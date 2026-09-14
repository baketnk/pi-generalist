import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	return runCell({ code, cwd, tools: ["echo"], invoke, timeoutMs: 5000, ...options });
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

	it("caps output and retains earlier output on syntax/runtime failure", async () => {
		expect(await cell("text('prefix'); throw new Error('oops')")).toMatchObject({
			output: "prefix\n",
			error: expect.stringContaining("oops"),
		});
		expect((await cell("text('x'.repeat(60000))")).error).toContain("output exceeds");
		expect((await cell("text('\\n'.repeat(3000))")).error).toContain("2000 lines");
		expect((await cell("const =")).error).toContain("SyntaxError");
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

	it("reports early process exit, oversized arguments, results and unavailable images", async () => {
		expect((await cell("process.exit(0)")).error).toContain("exited before completion");
		expect((await cell("await tools.echo({value: 'x'.repeat(300000)})")).error).toContain("arguments exceed");
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
