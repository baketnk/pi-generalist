import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { NestedToolInvoker } from "@earendil-works/pi-agent-core";

export const CODE_MAX_BYTES = 64 * 1024;
export const OUTPUT_MAX_BYTES = 50 * 1024;
const FRAME_MAX_BYTES = 1024 * 1024;
const RESULTS_MAX_BYTES = 4 * 1024 * 1024;
const REQUEST_MAX_BYTES = 256 * 1024;

export interface CellOptions {
	code: string;
	cwd: string;
	tools: readonly string[];
	invoke: NestedToolInvoker["invoke"];
	signal?: AbortSignal;
	timeoutMs?: number;
	onProgress?: (text: string) => void;
}

export interface CellResult {
	output: string;
	error?: string;
	calls: number;
}

/** Disposable trusted Node process. No eval in Pi, no inline fallback, no detached cells. */
export async function runCell(options: CellOptions): Promise<CellResult> {
	if (Buffer.byteLength(options.code) > CODE_MAX_BYTES) throw new Error("Code exceeds 64 KiB");
	const timeout = options.timeoutMs ?? 60000;
	if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300000) throw new Error("Invalid cell deadline");
	options.signal?.throwIfAborted();
	const workerPath = fileURLToPath(new URL("./worker.mjs", import.meta.url));
	const child = spawn(process.execPath, ["--max-old-space-size=256", workerPath], {
		cwd: options.cwd,
		detached: process.platform !== "win32",
		// Do not unnecessarily copy provider keys or Node preload flags. This is
		// hygiene, NOT isolation: trusted JS can still read files and use the network.
		env: Object.fromEntries(
			["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "SYSTEMROOT"].flatMap((key) =>
				process.env[key] === undefined ? [] : [[key, process.env[key]!]],
			),
		),
		stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
	});
	const incoming = child.stdio[3] as Readable;
	const outgoing = child.stdio[4] as Writable;
	const controller = new AbortController();
	const requests = new Set<Promise<void>>();
	const requestIds = new Set<number>();
	let finished = false;
	let error: string | undefined;
	let output = "";
	let outputBytes = 0;
	let outputLines = 0;
	let resultBytes = 0;
	let calls = 0;
	let buffer = "";
	let resolveDone: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		resolveDone = resolve;
	});
	const exited = new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		child.once("error", () => resolve());
	});

	function stop(reason?: string) {
		if (finished) return;
		finished = true;
		error = reason;
		controller.abort();
		if (child.pid) {
			try {
				if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		}
		resolveDone();
	}

	function append(text: string) {
		if (finished) return;
		const bytes = Buffer.byteLength(text);
		const lines = text.split("\n").length - 1;
		if (outputLines + lines > 2000) {
			stop("Cell output exceeds 2000 lines; output is incomplete");
			return;
		}
		if (outputBytes + bytes > OUTPUT_MAX_BYTES) {
			stop("Cell output exceeds 50 KiB; output is incomplete");
			return;
		}
		outputBytes += bytes;
		outputLines += lines;
		output += text;
	}

	function send(message: unknown) {
		if (finished) return;
		const line = JSON.stringify(message);
		if (Buffer.byteLength(line) > FRAME_MAX_BYTES) {
			stop("Nested result exceeds 1 MiB; inspect the nested trace");
			return;
		}
		outgoing.write(`${line}\n`);
	}

	async function handleCall(message: Record<string, unknown>) {
		const { id, name, args } = message;
		if (
			typeof id !== "number" ||
			!Number.isSafeInteger(id) ||
			id < 1 ||
			requestIds.has(id) ||
			typeof name !== "string" ||
			!options.tools.includes(name) ||
			!args ||
			typeof args !== "object" ||
			Array.isArray(args)
		) {
			stop("Invalid or unavailable nested tool request");
			return;
		}
		requestIds.add(id);
		if (++calls > 32) {
			stop("Cell exceeded 32 nested tool requests");
			return;
		}
		if (Buffer.byteLength(JSON.stringify(args)) > REQUEST_MAX_BYTES) {
			stop("Nested arguments exceed 256 KiB");
			return;
		}
		options.onProgress?.(`Nested call ${calls}: ${name}`);
		try {
			const result = await options.invoke(name, args as Record<string, unknown>, { signal: controller.signal });
			if (finished) return;
			// Do not transport image payloads into this text-only MVP or silently erase them.
			if (result.content.some((block) => block.type !== "text")) {
				send({ type: "reply", id, error: "Non-text nested result; call this tool directly to inspect it" });
				return;
			}
			// Uncaught bridge errors must retain useful diagnostics, not just "see error.result".
			// The full structured result remains available to caught errors and in bounded traces.
			const diagnostic = result.isError
				? result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n")
				: "";
			const preview = diagnostic.slice(0, 4096);
			const reply = {
				type: "reply",
				id,
				result,
				...(result.isError
					? {
							error: `Nested tool ${name} failed${preview ? `:\n${preview}` : " (no text diagnostic)"}${diagnostic.length > preview.length ? "\n[Diagnostic truncated; inspect error.result or the nested trace.]" : ""}`,
						}
					: {}),
			};
			resultBytes += Buffer.byteLength(JSON.stringify(reply));
			if (resultBytes > RESULTS_MAX_BYTES) {
				stop("Aggregate nested results exceed 4 MiB");
				return;
			}
			send(reply);
		} catch (cause) {
			send({ type: "reply", id, error: String(cause).slice(0, 8192) });
		}
	}

	function handle(line: string) {
		if (finished) return;
		if (Buffer.byteLength(line) > FRAME_MAX_BYTES) {
			stop("Worker frame exceeds 1 MiB");
			return;
		}
		const message: unknown = JSON.parse(line);
		if (!message || typeof message !== "object" || !("type" in message)) {
			stop("Malformed worker frame");
			return;
		}
		const value = message as Record<string, unknown>;
		switch (value.type) {
			case "text":
				if (typeof value.text !== "string") {
					stop("Invalid text output");
					return;
				}
				append(`${value.text}\n`);
				break;
			case "call": {
				const task = handleCall(value);
				requests.add(task);
				void task.then(
					() => requests.delete(task),
					(cause) => {
						requests.delete(task);
						stop(String(cause));
					},
				);
				break;
			}
			case "done":
				stop(
					value.pending !== 0 || requests.size > 0
						? "Cell returned with unfinished tool calls; cancellation requested, effects may be partial"
						: undefined,
				);
				break;
			case "error":
				stop(typeof value.error === "string" ? value.error.slice(0, 8192) : "Cell failed");
				break;
			default:
				stop("Unknown worker frame");
		}
	}

	incoming.setEncoding("utf8");
	incoming.on("data", (chunk: string) => {
		if (finished) return;
		buffer += chunk;
		try {
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				handle(line);
				if (finished) break;
			}
			if (Buffer.byteLength(buffer) > FRAME_MAX_BYTES) stop("Worker frame exceeds 1 MiB");
		} catch (cause) {
			stop(`Worker protocol error: ${String(cause)}`);
		}
	});
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => append(`[stdout] ${chunk}`));
	child.stderr?.on("data", (chunk: string) => append(`[stderr] ${chunk}`));
	incoming.on("error", (cause) => stop(String(cause)));
	outgoing.on("error", (cause) => stop(String(cause)));
	child.on("error", (cause) => stop(`Cannot start Code Mode process: ${String(cause)}`));
	child.on("exit", (code, signal) => stop(`Code Mode process exited before completion (${code ?? signal})`));
	const onAbort = () => stop("Cell aborted; child-tool cancellation requested, effects may be partial");
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(
		() => stop(`Cell deadline exceeded (${timeout} ms); child-tool cancellation requested, effects may be partial`),
		timeout,
	);
	try {
		if (options.signal?.aborted) onAbort();
		else send({ type: "run", code: options.code, tools: options.tools });
		await done;
		await exited;
		// A host extension that ignores AbortSignal can delay settlement. Do not
		// claim it stopped or allow an unknown mutation to escape this turn.
		await Promise.allSettled([...requests]);
		return { output, error, calls };
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
		stop("Cell disposed");
		incoming.destroy();
		outgoing.destroy();
	}
}
