import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { NestedToolInvoker } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { runCell } from "../examples/extensions/code-mode/runtime.ts";

const directories: string[] = [];
afterEach(async () => {
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
const invoke: NestedToolInvoker["invoke"] = async (name, args) => ({
	role: "toolResult",
	toolCallId: "child",
	toolName: name,
	content: [{ type: "text", text: JSON.stringify(args) }],
	details: { value: args.value },
	isError: false,
	timestamp: 0,
});
async function cell(code: string, options: Partial<Parameters<typeof runCell>[0]> = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-code-mode-"));
	directories.push(cwd);
	const result = await runCell({ code, cwd, tools: ["echo"], invoke, timeoutMs: 5000, ...options });
	if (result.outputPath) directories.push(dirname(result.outputPath));
	return result;
}

describe("trusted disposable Code Mode process", () => {
	it("supports data-dependent sequencing, parallel calls and selected output", async () => {
		const result = await cell(`
			const first = await tools.echo({value: 2});
			const results = await Promise.all([1, 2, 3].map(value => tools.echo({value: value * first.details.value})));
			text(results.map(r => r.details.value));
		`);
		expect(result.error).toBeUndefined();
		expect(result.calls).toBe(4);
		expect(result.output).toContain("[ 2, 4, 6 ]");
	});

	it("propagates tool errors with inspectable result objects", async () => {
		const result = await cell(
			`
			try { await tools.echo({value: 1}); } catch (error) { text(error.result.isError); }
		`,
			{ invoke: async (name, args) => ({ ...(await invoke(name, args)), isError: true }) },
		);
		expect(result.error).toBeUndefined();
		expect(result.output).toBe("true\n");
	});

	it("includes bounded diagnostics for uncaught nested failures without losing error.result", async () => {
		const failure: NestedToolInvoker["invoke"] = async (name, args) => ({
			...(await invoke(name, args)),
			isError: true,
			content: [{ type: "text", text: `Compiler diagnostic: invalid argument\n${"x".repeat(10000)}` }],
		});
		const uncaught = await cell("await tools.echo({})", { invoke: failure });
		expect(uncaught.error).toContain("Compiler diagnostic: invalid argument");
		expect(uncaught.error).toContain("Diagnostic truncated");
		expect(uncaught.error!.length).toBeLessThanOrEqual(8192);
		const caught = await cell("try { await tools.echo({}); } catch (e) { text(e.result.content[0].text.length); }", {
			invoke: failure,
		});
		expect(caught.error).toBeUndefined();
		expect(caught.output).toBe("10038\n");
	});

	it("uses fresh cells rather than persistent globals", async () => {
		expect((await cell("globalThis.marker = 42; text('ok')")).error).toBeUndefined();
		expect((await cell("text(typeof globalThis.marker)")).output).toBe("undefined\n");
	});

	it("terminates infinite synchronous loops without blocking Pi", async () => {
		const started = Date.now();
		const result = await cell("while (true) {}", { timeoutMs: 200 });
		expect(result.error).toContain("deadline");
		expect(Date.now() - started).toBeLessThan(3000);
	});

	it("retains earlier output on syntax/runtime failure", async () => {
		expect(await cell("text('prefix'); throw new Error('oops')")).toMatchObject({
			output: "prefix\n",
			error: expect.stringContaining("oops"),
		});

		expect((await cell("const =")).error).toContain("SyntaxError");
	});

	it("finishes all three large reads and subsequent work instead of stopping at the preview limit", async () => {
		const result = await cell(`
			for (const value of ['first', 'middle', 'last']) {
				const r = await tools.echo({value});
				text(r.details.value + ': ' + 'x'.repeat(30000));
			}
			await tools.echo({value: 'after-spill'});
			text('FINAL RESULT');
		`);
		expect(result.error).toBeUndefined();
		expect(result.calls).toBe(4);
		const saved = await readFile(result.outputPath!, "utf8");
		expect(saved).toBe(
			`${["first", "middle", "last"].map((name) => `${name}: ${"x".repeat(30000)}\n`).join("")}FINAL RESULT\n`,
		);
		expect(result.output).toContain("first:");
		expect(result.output).toContain("FINAL RESULT");
		expect(Buffer.byteLength(result.output)).toBeLessThan(50 * 1024);
	});

	it("spills newline-heavy output and preserves capture after a runtime error or timeout", async () => {
		for (const ending of ["", "throw new Error('after-spill')", "await new Promise(() => {})"]) {
			const result = await cell(`text('START' + '\\n'.repeat(3000) + 'END'); ${ending}`, { timeoutMs: 300 });
			expect(await readFile(result.outputPath!, "utf8")).toBe(`START${"\n".repeat(3000)}END\n`);
			if (ending.startsWith("throw")) expect(result.error).toContain("after-spill");
			else if (ending) expect(result.error).toContain("deadline");
			else expect(result.error).toBeUndefined();
		}
	});

	it("retains a spill on external abort after output has reached the host", async () => {
		const controller = new AbortController();
		const result = await cell("text('x'.repeat(60000)); await tools.echo({});", {
			signal: controller.signal,
			invoke: async (name, args) => {
				controller.abort();
				return invoke(name, args);
			},
		});
		expect(result.error).toContain("aborted");
		expect(await readFile(result.outputPath!, "utf8")).toBe(`${"x".repeat(60000)}\n`);
	});

	it("stops runaway output at the hard capture limit and retains its bounded prefix", async () => {
		const result = await cell("while (true) { text('x'.repeat(100000)); await new Promise(setImmediate); }");
		expect(result.error).toContain("16 MiB capture limit");
		expect(result.output).toContain("Capture incomplete");
		expect(Buffer.byteLength(await readFile(result.outputPath!))).toBe(16 * 1024 * 1024);
	});

	it("cancels pending host tools if the cell finishes without awaiting them", async () => {
		let aborted = false;
		const result = await cell("void tools.echo({});", {
			invoke: async (_name, _args, options) => {
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) resolve();
					else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				aborted = true;
				throw new Error("cancelled");
			},
		});
		expect(result.error).toContain("unfinished");
		expect(aborted).toBe(true);
	});

	it("propagates external abort and rejects an already-aborted cell before spawn", async () => {
		const controller = new AbortController();
		const promise = cell("await new Promise(() => {})", { signal: controller.signal });
		setTimeout(() => controller.abort(), 100);
		expect((await promise).error).toContain("aborted");
		await expect(cell("text('no')", { signal: controller.signal })).rejects.toThrow();
	});

	it("enforces the serialized argument limit per call at its boundary", async () => {
		const limit = 256 * 1024;
		const emptyArgumentBytes = Buffer.byteLength(JSON.stringify({ value: "" }));
		const exactValueLength = limit - emptyArgumentBytes;
		const exact = await cell(`await tools.echo({value: 'x'.repeat(${exactValueLength})})`);
		expect(exact.error).toBeUndefined();
		expect(exact.calls).toBe(1);

		const overValueLength = limit - emptyArgumentBytes + 1;
		const over = await cell(`await tools.echo({value: 'x'.repeat(${overValueLength})})`);
		expect(over.error).toContain("Nested arguments exceed 256 KiB for this call");
		expect(over.error).toContain("per-call limit");
		expect(over.calls).toBe(1);

		// Two individually valid requests may exceed 256 KiB in aggregate.
		const aggregate = await cell(`
			const value = 'x'.repeat(150000);
			await tools.echo({value});
			await tools.echo({value});
		`);
		expect(aggregate.error).toBeUndefined();
		expect(aggregate.calls).toBe(2);
	});

	it("reports early process exit, oversized results and unavailable images", async () => {
		expect((await cell("process.exit(0)")).error).toContain("exited before completion");
		expect(
			(
				await cell("await tools.echo({})", {
					invoke: async (name, args) => ({
						...(await invoke(name, args)),
						details: { huge: "x".repeat(1100000) },
					}),
				})
			).error,
		).toContain("exceeds 1 MiB");
		expect(
			(
				await cell("await tools.echo({})", {
					invoke: async (name, args) => ({
						...(await invoke(name, args)),
						content: [{ type: "image", mimeType: "image/png", data: "fake" }],
					}),
				})
			).error,
		).toContain("Non-text");
	});

	it("kills same-process-group descendants on timeout (Linux)", async () => {
		if (process.platform !== "linux") return;
		const cwd = await mkdtemp(join(tmpdir(), "pi-code-mode-tree-"));
		directories.push(cwd);
		const result = await cell(
			`
			const fs = await import('node:fs');
			const cp = await import('node:child_process');
			const child = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {stdio:'ignore'});
			fs.writeFileSync('pid', String(child.pid));
			await new Promise(() => {});
		`,
			{ cwd, timeoutMs: 300 },
		);
		expect(result.error).toContain("deadline");
		const pid = Number(await readFile(join(cwd, "pid"), "utf8"));
		// A reparented zombie is dead but can remain visible until init reaps it.
		let alive = false;
		try {
			alive = !(await readFile(`/proc/${pid}/stat`, "utf8")).includes(") Z ");
		} catch {
			/* gone */
		}
		expect(alive).toBe(false);
	});
});
