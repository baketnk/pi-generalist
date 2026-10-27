import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const OUTPUT_MAX_BYTES = 50 * 1024;
export const OUTPUT_MAX_NEWLINES = 2000;
export const CAPTURE_MAX_BYTES = 16 * 1024 * 1024;
// Leave ample space for the path/notice. Error and nested-call diagnostics are
// separately bounded by the runtime/core and are never part of this preview.
const PREVIEW_BYTES_PER_END = 20 * 1024;
const PREVIEW_NEWLINES_PER_END = 900;

function utf8Prefix(bytes: Buffer, limit: number): Buffer {
	let end = Math.min(bytes.length, limit);
	while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end);
}

function previewEnd(bytes: Buffer, tail: boolean): string {
	let part: Buffer;
	if (tail) {
		let start = Math.max(0, bytes.length - PREVIEW_BYTES_PER_END);
		while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
		part = bytes.subarray(start);
	} else {
		part = utf8Prefix(bytes, PREVIEW_BYTES_PER_END);
	}
	let newlines = 0;
	for (let n = 0; n < part.length; n++) {
		const i = tail ? part.length - 1 - n : n;
		if (part[i] === 10 && ++newlines > PREVIEW_NEWLINES_PER_END) {
			part = tail ? part.subarray(i + 1) : part.subarray(0, i);
			break;
		}
	}
	return part.toString("utf8");
}

/** Bounded capture of emitted text, not a copy of unprinted/raw nested results. */
export class CellOutput {
	private chunks: Buffer[] = [];
	private bytes = 0;
	private newlines = 0;
	private capped = false;

	/** False requests cell termination; retain the prefix up to the hard ceiling. */
	append(text: string): boolean {
		if (this.capped) return false;
		const incoming = Buffer.from(text);
		const remaining = CAPTURE_MAX_BYTES - this.bytes;
		this.capped = incoming.length > remaining;
		const retained = this.capped ? utf8Prefix(incoming, remaining) : incoming;
		// Pack small writes into fixed slabs, so millions of tiny text() calls
		// cannot turn a bounded byte capture into an unbounded array of buffers.
		let offset = 0;
		while (offset < retained.length) {
			const used = this.bytes % (64 * 1024);
			if (used === 0) this.chunks.push(Buffer.alloc(64 * 1024));
			const count = Math.min(retained.length - offset, 64 * 1024 - used);
			retained.copy(this.chunks[this.chunks.length - 1], used, offset, offset + count);
			this.bytes += count;
			offset += count;
		}
		for (const byte of retained) if (byte === 10) this.newlines++;
		return !this.capped;
	}

	async finish(): Promise<{ output: string; outputPath?: string; error?: string }> {
		const bytes = Buffer.concat(this.chunks, this.bytes);
		this.chunks = [];
		if (!this.capped && this.bytes <= OUTPUT_MAX_BYTES && this.newlines <= OUTPUT_MAX_NEWLINES) {
			return { output: bytes.toString("utf8") };
		}

		let outputPath: string | undefined;
		let directory: string | undefined;
		let error: string | undefined;
		try {
			// mkdtemp creates a private (0700 on POSIX) directory. Keep it after
			// cell exit/reload; OS temp cleanup or explicit user removal owns retention.
			directory = await fs.mkdtemp(join(resolve(tmpdir()), "pi-exec-"));
			const path = join(directory, "output.txt");
			await fs.writeFile(path, bytes, { flag: "wx", mode: 0o600 });
			outputPath = path;
		} catch (cause) {
			error = `Cannot save captured cell output: ${String(cause).slice(0, 1024)}`;
			// Do not advertise a partial file as a successful capture.
			if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
		}
		const notice = [
			`[Output preview: head/tail of ${this.bytes} captured bytes, ${this.newlines} newlines.`,
			this.capped ? "Capture incomplete: 16 MiB hard limit exceeded; cell stopped." : "",
			outputPath
				? `Captured output saved to: ${JSON.stringify(outputPath)}. Use read with offset/limit or bash/rg to inspect. Retained until OS temp cleanup or manual removal.`
				: "Capture file unavailable; omitted output is not recoverable from this response.",
			"]",
		]
			.filter(Boolean)
			.join(" ");
		return {
			output: `${notice}\n\n--- head ---\n${previewEnd(bytes, false)}\n\n[... middle omitted from preview ...]\n\n--- tail ---\n${previewEnd(bytes, true)}`,
			outputPath,
			error,
		};
	}
}
