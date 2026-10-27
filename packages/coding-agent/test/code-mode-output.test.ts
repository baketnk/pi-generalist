import fs from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CAPTURE_MAX_BYTES,
	CellOutput,
	OUTPUT_MAX_BYTES,
	OUTPUT_MAX_NEWLINES,
} from "../examples/extensions/code-mode/output.ts";

const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const path of directories.splice(0)) await fs.rm(path, { recursive: true, force: true });
});

async function finish(output: CellOutput) {
	const result = await output.finish();
	if (result.outputPath) directories.push(dirname(result.outputPath));
	return result;
}

function expectBounded(output: string) {
	expect(Buffer.byteLength(output)).toBeLessThan(OUTPUT_MAX_BYTES);
	expect(output.split("\n").length - 1).toBeLessThan(OUTPUT_MAX_NEWLINES);
}

describe("Code Mode output capture", () => {
	it("keeps small output and exact preview boundaries unchanged without creating files", async () => {
		for (const text of ["", "small\n", "x".repeat(OUTPUT_MAX_BYTES), "\n".repeat(OUTPUT_MAX_NEWLINES)]) {
			const output = new CellOutput();
			expect(output.append(text)).toBe(true);
			expect(await finish(output)).toEqual({ output: text });
		}
	});

	it("spills full composed text to a private file and previews both ends", async () => {
		const output = new CellOutput();
		const text = `START\n${"body\n".repeat(15000)}END\n`;
		for (const part of [text.slice(0, 30000), text.slice(30000)]) expect(output.append(part)).toBe(true);
		const result = await finish(output);
		expect(result.error).toBeUndefined();
		expect(isAbsolute(result.outputPath!)).toBe(true);
		expect(await fs.readFile(result.outputPath!, "utf8")).toBe(text);
		expect(result.output).toContain(JSON.stringify(result.outputPath));
		expect(result.output).toContain(`${Buffer.byteLength(text)} captured bytes`);
		expect(result.output).toContain("--- head ---\nSTART\n");
		expect(result.output).toContain("middle omitted");
		expect(result.output.endsWith("END\n")).toBe(true);
		expectBounded(result.output);
		if (process.platform !== "win32") {
			expect((await fs.stat(result.outputPath!)).mode & 0o777).toBe(0o600);
			expect((await fs.stat(dirname(result.outputPath!))).mode & 0o777).toBe(0o700);
		}
	});

	it("spills on either threshold and preserves UTF-8 at preview cuts", async () => {
		for (const text of ["\n".repeat(OUTPUT_MAX_NEWLINES + 1), `明${"狸🙂".repeat(15000)}終`]) {
			const output = new CellOutput();
			output.append(text);
			const result = await finish(output);
			expect(await fs.readFile(result.outputPath!, "utf8")).toBe(text);
			expect(result.output).not.toContain("�");
			expectBounded(result.output);
		}
	});

	it("retains only a valid UTF-8 prefix at the hard limit and labels the capture incomplete", async () => {
		const output = new CellOutput();
		expect(output.append("x".repeat(CAPTURE_MAX_BYTES - 1))).toBe(true);
		expect(output.append("🙂lost")).toBe(false);
		expect(output.append("also lost")).toBe(false);
		const result = await finish(output);
		const saved = await fs.readFile(result.outputPath!, "utf8");
		expect(saved).toBe("x".repeat(CAPTURE_MAX_BYTES - 1));
		expect(result.output).toContain("Capture incomplete: 16 MiB hard limit exceeded");
		expectBounded(result.output);
	});

	it("allows exactly the hard capture ceiling", async () => {
		const output = new CellOutput();
		expect(output.append("x".repeat(CAPTURE_MAX_BYTES))).toBe(true);
		const result = await finish(output);
		expect((await fs.stat(result.outputPath!)).size).toBe(CAPTURE_MAX_BYTES);
		expect(result.output).not.toContain("Capture incomplete");
	});

	it("reports temp creation failure without discarding the preview or claiming a saved file", async () => {
		vi.spyOn(fs, "mkdtemp").mockRejectedValueOnce(new Error("temp unavailable"));
		const output = new CellOutput();
		output.append(`START${"x".repeat(60000)}END`);
		const result = await finish(output);
		expect(result.error).toContain("temp unavailable");
		expect(result.outputPath).toBeUndefined();
		expect(result.output).toContain("Capture file unavailable");
		expect(result.output).toContain("START");
		expect(result.output.endsWith("END")).toBe(true);
		expectBounded(result.output);
	});

	it("removes a failed partial write and reports failure", async () => {
		const originalWrite = fs.writeFile;
		let path: string | undefined;
		vi.spyOn(fs, "writeFile").mockImplementationOnce(async (file, _data, options) => {
			path = String(file);
			await originalWrite(file, "partial", options);
			throw new Error("disk full");
		});
		const output = new CellOutput();
		output.append("x".repeat(60000));
		const result = await finish(output);
		expect(result.error).toContain("disk full");
		expect(result.outputPath).toBeUndefined();
		expect(path).toBeDefined();
		await expect(fs.stat(dirname(path!))).rejects.toMatchObject({ code: "ENOENT" });
	});
});
