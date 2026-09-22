import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type Api,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	normalizeContext,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import codeMode from "../examples/extensions/code-mode/index.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { NESTED_TOOL_RECORD } from "../src/core/nested-tool-record.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});

// Exercise real provider serializers, but throw at onPayload BEFORE transport.
// Keys and URLs are synthetic; no credential discovery or model request occurs.
async function project(model: Model<Api>, context: TranscriptContext): Promise<Record<string, unknown>> {
	let payload: Record<string, unknown> | undefined;
	const stream = streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, context, {
		apiKey:
			"header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoic3ludGhldGljIn19.signature",
		onPayload(value) {
			payload = structuredClone(value) as Record<string, unknown>;
			throw new Error("PAYLOAD_ONLY_NO_TRANSPORT");
		},
	});
	await stream.result();
	if (!payload) throw new Error("Provider serializer did not reach payload capture");
	return payload;
}

async function runFixture() {
	const h = await createHarness({
		extensionFactories: [codeMode],
		settings: { compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
	});
	harnesses.push(h);
	await writeFile(join(h.tempDir, "manifest.json"), JSON.stringify({ files: ["one.txt", "two.txt"] }));
	await writeFile(join(h.tempDir, "one.txt"), "old\n");
	await writeFile(join(h.tempDir, "two.txt"), "other\n");
	const contexts: TranscriptContext[] = [];
	const original = h.session.agent.streamFunction;
	h.session.agent.streamFunction = (model, context, options) => {
		contexts.push(normalizeContext({ messages: structuredClone(context.messages) }));
		return original(model, context, options);
	};
	h.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall(
					"exec",
					{
						code: `
			const manifest = JSON.parse((await tools.read({path: 'manifest.json'})).content[0].text);
			const results = await Promise.all(manifest.files.map(path => tools.read({path})));
			await tools.edit({path:'one.txt', edits:[{oldText:'old',newText:'new'}]});
			text(results.map(result => result.content[0].text.trim()));
		`,
					},
					{ id: "outer" },
				),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	await h.session.prompt("Inspect manifest and edit one file");
	return { h, contexts };
}

describe("Code Mode integration and provider projection", () => {
	it("retains failed call details and compiler diagnostics through the normal error pipeline and reopen", async () => {
		const h = await createHarness({ extensionFactories: [codeMode], settings: { compaction: { enabled: false } } });
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("exec", {
						code: "text('before'); await tools.bash({command:'printf compile-diagnostic; exit 7'});",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("Exercise a failing command");
		const result = h.session.messages.find((m) => m.role === "toolResult");
		expect(result).toMatchObject({
			isError: true,
			details: { calls: 1, toolCalls: [{ name: "bash", state: "failed" }] },
		});
		expect(getMessageText(result)).toContain("compile-diagnostic");
		expect(getMessageText(result)).toContain("before");
		const restored = SessionManager.open(h.session.exportToJsonl(join(h.tempDir, "failed.jsonl")));
		expect(restored.buildSessionContext().messages.find((m) => m.role === "toolResult")).toEqual(result);
	});

	it("caught nested failures remain visible in call details even when the cell succeeds", async () => {
		const h = await createHarness({ extensionFactories: [codeMode], settings: { compaction: { enabled: false } } });
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("exec", {
						code: "await Promise.allSettled([tools.read({path:'missing-fixture'})]); text('handled');",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("Handle an expected failure");
		expect(h.session.messages.find((m) => m.role === "toolResult")).toMatchObject({
			isError: false,
			details: { toolCalls: [{ name: "read", state: "failed" }] },
		});
	});

	it("settles an active cell and its Bash child before reload replaces runtime state", async () => {
		const h = await createHarness({ extensionFactories: [codeMode], settings: { compaction: { enabled: false } } });
		harnesses.push(h);
		let notify: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			notify = resolve;
		});
		h.session.subscribe((event) => {
			if (event.type === "tool_execution_update" && event.toolName === "bash") notify();
		});
		h.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"exec",
						{ code: "await tools.bash({command:'printf started; sleep 10'});" },
						{ id: "cancelled-cell" },
					),
				],
				{ stopReason: "toolUse" },
			),
		]);
		const running = h.session.prompt("Run a cancellable cell");
		await started;
		await h.session.reload();
		await running;
		expect(h.session.isStreaming).toBe(false);
		expect(
			h
				.eventsOfType("tool_execution_end")
				.map((e) => e.toolName)
				.sort(),
		).toEqual(["bash", "exec"]);
		expect(h.session.messages.find((m) => m.role === "toolResult")).toMatchObject({
			isError: true,
			details: { toolCalls: [{ name: "bash", state: "failed" }] },
		});
		h.setResponses([fauxAssistantMessage("ready after reload")]);
		await h.session.prompt("Continue without replaying the cell");
		expect(h.eventsOfType("tool_execution_start")).toHaveLength(2);
	});

	it("composes real built-ins, preserves bounded trace data across export/open, and never replays mutations", async () => {
		const { h } = await runFixture();
		expect(await readFile(join(h.tempDir, "one.txt"), "utf8")).toBe("new\n");
		const results = h.session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ isError: false });
		expect(getMessageText(results[0])).toContain("4 completed, 0 failed");
		const traces = h.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom" && e.customType === NESTED_TOOL_RECORD);
		expect(traces).toHaveLength(8);
		const path = h.session.exportToJsonl(join(h.tempDir, "export.jsonl"));
		const restored = SessionManager.open(path);
		expect(
			restored.getBranch().filter((e) => e.type === "custom" && e.customType === NESTED_TOOL_RECORD),
		).toHaveLength(8);
		expect(convertToLlm(restored.buildSessionContext().messages)).toEqual(convertToLlm(h.session.messages));
		await h.session.reload();
		expect(await readFile(join(h.tempDir, "one.txt"), "utf8")).toBe("new\n");
		expect(
			h.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === NESTED_TOOL_RECORD),
		).toHaveLength(8);
	});

	it("preserves OpenAI prefixes and Anthropic content except native cache markers across follow-up, turns, retry and reload", async () => {
		const { h, contexts } = await runFixture();
		expect(contexts).toHaveLength(2);
		h.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
			fauxAssistantMessage("retry done"),
		]);
		await h.session.prompt("Another ordinary turn");
		expect(h.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
		expect(contexts).toHaveLength(4);
		await h.session.reload();
		h.setResponses([fauxAssistantMessage("after reload")]);
		await h.session.prompt("After reload");
		expect(contexts).toHaveLength(5);
		const models = [
			getModel("openai", "gpt-5.4"),
			getModel("openai-codex", "gpt-5.5"),
			getModel("anthropic", "claude-sonnet-4-5"),
		];
		for (const model of models) {
			expect(model).toBeDefined();
			const payloads = await Promise.all(contexts.map((context) => project(model!, context)));
			for (const payload of payloads) {
				expect(payload.tools).toEqual(payloads[0].tools);
				expect(payload.system ?? payload.instructions).toEqual(payloads[0].system ?? payloads[0].instructions);
				const serialized = JSON.stringify(payload);
				expect(serialized).not.toContain("pi.nested-tool.v1");
				// Child IDs can occur in an error summary, but must not appear as tool-call/output protocol items.
				expect(serialized).not.toContain('"call_id":"outer:nested:');
				expect(serialized).not.toContain('"tool_use_id":"outer:nested:');
			}
			const rawItems = payloads.map((p) => (p.input ?? p.messages) as unknown[]);
			// Anthropic's existing adapter moves cache_control to trailing blocks.
			// Explicitly test that exception rather than claiming byte-identical payload prefixes.
			if (model!.api === "anthropic-messages")
				expect(rawItems[1].slice(0, rawItems[0].length)).not.toEqual(rawItems[0]);
			const items: unknown[][] =
				model!.api === "anthropic-messages"
					? rawItems.map((items) =>
							JSON.parse(JSON.stringify(items, (key, value) => (key === "cache_control" ? undefined : value))),
						)
					: rawItems;
			expect(items[1].slice(0, items[0].length)).toEqual(items[0]);
			expect(items[2].slice(0, items[1].length)).toEqual(items[1]);
			expect(items[3]).toEqual(items[2]); // retry does not re-run the cell or rewrite prior messages
			expect(items[4].slice(0, items[3].length)).toEqual(items[3]);
		}
	});
});
