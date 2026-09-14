// Trusted local JavaScript, NOT a sandbox. Separate process only for lifecycle containment.
import { createReadStream, createWriteStream } from "node:fs";
import { inspect } from "node:util";

const input = createReadStream(null, { fd: 4 });
const output = createWriteStream(null, { fd: 3 });
const pending = new Map();
let nextId = 0;
let started = false;
let buffer = "";
const MAX_FRAME = 1024 * 1024;

function send(value) {
	const line = JSON.stringify(value);
	if (Buffer.byteLength(line) > MAX_FRAME) throw new Error("Code Mode message exceeds 1 MiB");
	output.write(`${line}\n`);
}

function text(value) {
	const rendered = typeof value === "string" ? value : inspect(value, { depth: 8, maxArrayLength: 1000, maxStringLength: 50000, colors: false });
	send({ type: "text", text: rendered });
}

function call(name, args) {
	if (nextId >= 32) return Promise.reject(new Error("Code Mode call limit (32) exceeded"));
	const id = ++nextId;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		try { send({ type: "call", id, name, args }); }
		catch (error) { pending.delete(id); reject(error); }
	});
}

async function run(message) {
	if (started) throw new Error("Worker already started");
	started = true;
	const tools = Object.create(null);
	for (const name of message.tools) tools[name] = args => call(name, args);
	Object.freeze(tools);
	try {
		const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
		await new AsyncFunction("tools", "text", `"use strict";\n${message.code}\n//# sourceURL=pi-code-mode-cell.js`)(tools, text);
		send({ type: "done", pending: pending.size });
	} catch (error) {
		send({ type: "error", error: String(error?.stack ?? error).slice(0, 8192) });
	}
}

input.setEncoding("utf8");
input.on("data", chunk => {
	buffer += chunk;
	for (;;) {
		const newline = buffer.indexOf("\n");
		if (newline < 0) break;
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (Buffer.byteLength(line) > MAX_FRAME) throw new Error("Oversized host frame");
		const message = JSON.parse(line);
		if (message.type === "run") void run(message);
		else if (message.type === "reply") {
			const task = pending.get(message.id);
			if (!task) throw new Error("Unknown tool reply");
			pending.delete(message.id);
			if (message.error) task.reject(Object.assign(new Error(message.error), { result: message.result }));
			else task.resolve(message.result);
		}
	}
	if (Buffer.byteLength(buffer) > MAX_FRAME) throw new Error("Oversized host frame");
});
input.on("end", () => process.exit(0));
process.on("unhandledRejection", error => {
	try { send({ type: "error", error: `Unhandled rejection: ${String(error).slice(0, 8192)}` }); }
	catch { process.exit(1); }
});
