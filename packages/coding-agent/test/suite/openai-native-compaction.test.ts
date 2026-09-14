import { fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCompaction } from "../../src/core/compaction/compaction.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { withContextWindow } from "../../src/core/request-identity.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const nativeModel: Model<"openai-responses"> = {
	api: "openai-responses",
	provider: "openai",
	id: "gpt-5.4",
	name: "Synthetic native model",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 200000,
	maxTokens: 20000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const output = [
	{ type: "message", role: "user", content: [{ type: "input_text", text: "retained by provider" }] },
	{ type: "compaction", id: "cmp_1", encrypted_content: "synthetic-ciphertext" },
];
const harnesses: Harness[] = [];
async function setup(observedCompactions?: string[]): Promise<Harness> {
	const harness = await createHarness({
		settings: { compaction: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.on("session_compact", (event) => {
					observedCompactions?.push(event.compactionEntry.id);
				});
				pi.on("context", (event) => ({
					messages: [{ role: "user", content: "TRANSIENT_REVOKABLE_PACKET", timestamp: 0 }, ...event.messages],
				}));
			},
		],
	});
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
	await harness.session.prompt("first question");
	await harness.session.prompt("second question");
	await harness.authStorage.modify("openai", async () => ({ type: "api_key", key: "synthetic-key" }));
	harness.session.agent.state.model = nativeModel;
	return harness;
}
function project(manager: SessionManager): unknown[] {
	return convertResponsesMessages(
		nativeModel,
		{ messages: convertToLlm(manager.buildSessionContext().messages) },
		new Set(["openai"]),
	);
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	while (harnesses.length) harnesses.pop()!.cleanup();
});

describe("native compaction session lifecycle", () => {
	it("commits one full replacement, survives reload, and appends after the canonical window", async () => {
		const harness = await setup();
		let body: Record<string, unknown> = {};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init?: RequestInit) => {
				body = JSON.parse(String(init?.body));
				return Response.json({ output });
			}),
		);
		const before = project(harness.sessionManager);
		const oldEntries = harness.sessionManager.getEntries();
		const result = await harness.session.compact();
		expect(body.input).toEqual(before);
		expect(JSON.stringify(body)).not.toContain("TRANSIENT_REVOKABLE_PACKET");
		expect(result.details).toMatchObject({ openaiCompaction: { output } });
		expect(harness.sessionManager.getEntries().slice(0, oldEntries.length)).toEqual(oldEntries);
		expect(harness.session.messages).toHaveLength(1);
		expect(project(harness.sessionManager)).toEqual(output);
		const restored = SessionManager.inMemory(
			undefined,
			undefined,
			JSON.parse(JSON.stringify([harness.sessionManager.getHeader(), ...harness.sessionManager.getEntries()])),
		);
		expect(project(restored)).toEqual(output);
		restored.appendMessage({ role: "user", content: "next turn", timestamp: 3 });
		expect(project(restored).slice(0, output.length)).toEqual(output);
		const foreign = convertResponsesMessages(
			{ ...nativeModel, id: "different-model" },
			{ messages: convertToLlm(restored.buildSessionContext().messages) },
			new Set(["openai"]),
		);
		expect(JSON.stringify(foreign)).not.toContain("synthetic-ciphertext");
		expect(JSON.stringify(foreign)).toContain("first question");
		expect(JSON.stringify(foreign)).toContain("second answer");
		expect(JSON.stringify(foreign)).toContain("next turn");
		const preparation = prepareCompaction(restored.getBranch(), {
			enabled: true,
			reserveTokens: 100,
			keepRecentTokens: 1,
		});
		expect(JSON.stringify(preparation?.messagesToSummarize)).toContain("first question");
	});

	it("sends the previous native window back to the compactor without retaining a duplicate tail", async () => {
		const observedCompactions: string[] = [];
		const harness = await setup(observedCompactions);
		const bodies: Record<string, unknown>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init?: RequestInit) => {
				bodies.push(JSON.parse(String(init?.body)));
				return Response.json({ output: [...output.slice(0, 1), { ...output[1], id: `cmp_${bodies.length}` }] });
			}),
		);
		await harness.session.compact();
		harness.sessionManager.appendMessage({ role: "user", content: "after compaction", timestamp: 4 });
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		await harness.session.compact();
		expect((bodies[1].input as unknown[]).slice(0, output.length)).toEqual(output);
		expect(project(harness.sessionManager)).toHaveLength(output.length);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(2);
		expect(observedCompactions).toEqual(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "compaction")
				.map((entry) => entry.id),
		);
	});

	it.each(["http", "malformed", "changed branch", "cancel"])(
		"does not commit or rotate context identity after %s",
		async (failure) => {
			const harness = await setup();
			const oldLeaf = harness.sessionManager.getLeafId();
			const identity = harness.session.agent.createRequestIdentity();
			const before = withContextWindow(identity, harness.sessionManager.getBranch());
			vi.stubGlobal(
				"fetch",
				vi.fn(async (_url: unknown, init?: RequestInit) => {
					if (failure === "http") return new Response("unsupported", { status: 404 });
					if (failure === "malformed") return Response.json({ output: [] });
					if (failure === "changed branch") harness.sessionManager.appendCustomEntry("concurrent-change", {});
					if (failure === "cancel") {
						queueMicrotask(() => harness.session.abortCompaction());
						return new Promise<Response>((_resolve, reject) =>
							init?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
						);
					}
					return Response.json({ output });
				}),
			);
			await expect(harness.session.compact()).rejects.toThrow();
			expect(harness.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
			expect(withContextWindow(identity, harness.sessionManager.getBranch())).toEqual(before);
			if (failure !== "changed branch") expect(harness.sessionManager.getLeafId()).toBe(oldLeaf);
		},
	);

	it.each(["threshold", "overflow"] as const)("uses the native route for automatic %s compaction", async (reason) => {
		const harness = await setup();
		const fetch = vi.fn(async () => Response.json({ output }));
		vi.stubGlobal("fetch", fetch);
		const internal = harness.session as unknown as {
			_runAutoCompaction(reason: "threshold" | "overflow", willRetry: boolean): Promise<boolean>;
		};
		expect(await internal._runAutoCompaction(reason, reason === "overflow")).toBe(reason === "overflow");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(project(harness.sessionManager)).toEqual(output);
	});
});
