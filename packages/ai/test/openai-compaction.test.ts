import { zstdDecompressSync } from "node:zlib";
import { FinishReason } from "@google/genai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mapStopReason } from "../src/api/google-shared.ts";
import { stream as codexStream } from "../src/api/openai-codex-responses.ts";
import { compactOpenAI, supportsNativeOpenAICompaction } from "../src/api/openai-compaction.ts";
import { stream as responsesStream } from "../src/api/openai-responses.ts";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { Model, OpenAICompaction, SimpleStreamOptions, TranscriptContext } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const output = [
	{ type: "message", id: "retained-user", role: "user", content: [{ type: "input_text", text: "original question" }] },
	{ type: "compaction", id: "cmp_1", encrypted_content: "synthetic-opaque-state", future_field: { preserve: true } },
];
const context = normalizeContext({
	systemPrompt: "Stable instructions",
	messages: [{ role: "user", content: "original question", timestamp: 1 }],
	tools: [{ name: "probe", description: "Synthetic tool", parameters: Type.Object({}) }],
});
const identity = {
	sessionId: "session",
	threadId: "session",
	turnId: "compact-turn",
	requestKind: "compaction" as const,
	startedAt: 1,
};
const apiKey = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake-account" } })).toString("base64")}.signature`;
function model(api: OpenAICompaction["api"] = "openai-responses"): Model<OpenAICompaction["api"]> {
	return {
		api,
		id: "gpt-5.4",
		name: "Test",
		provider: api === "openai-responses" ? "openai" : "openai-codex",
		baseUrl: api === "openai-responses" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		contextWindow: 200000,
		maxTokens: 20000,
		cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 0 },
	};
}
function response(): Response {
	return Response.json({
		output,
		usage: { input_tokens: 100, output_tokens: 12, input_tokens_details: { cached_tokens: 90 } },
	});
}
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("native OpenAI compaction", () => {
	it.each(["openai-responses", "openai-codex-responses"] as const)(
		"uses %s's native protocol and replays the entire checkpoint window",
		async (api) => {
			const requests: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
			const fetch: typeof globalThis.fetch = async (url, init) => {
				const body =
					typeof init?.body === "string"
						? init.body
						: Buffer.from(zstdDecompressSync(init?.body as Uint8Array)).toString();
				const payload = JSON.parse(body);
				requests.push({ url: String(url), body: payload, headers: new Headers(init?.headers) });
				if (String(url).endsWith("/compact")) return response();
				if (payload.input.at(-1)?.type === "compaction_trigger") {
					return new Response(
						[
							{ type: "response.output_item.done", item: output[1] },
							{
								type: "response.completed",
								response: {
									status: "completed",
									usage: { input_tokens: 100, output_tokens: 12, input_tokens_details: { cached_tokens: 90 } },
								},
							},
						]
							.map((event) => `data: ${JSON.stringify(event)}\n\n`)
							.join(""),
					);
				}
				return new Response(
					'data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}}\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				);
			};
			const m = model(api);
			const result = await compactOpenAI(m, context, {
				apiKey,
				fetch,
				sessionId: "session",
				requestIdentity: identity,
			});
			const expectedOutput =
				api === "openai-responses"
					? output
					: [
							{ type: "message", role: "user", content: [{ type: "input_text", text: "original question" }] },
							output[1],
						];
			expect(result.compaction.output).toEqual(expectedOutput);
			expect(result.usage).toMatchObject({ input: 10, cacheRead: 90, output: 12, totalTokens: 112 });
			expect(requests[0].url).toBe(
				api === "openai-responses"
					? "https://api.openai.com/v1/responses/compact"
					: "https://chatgpt.com/backend-api/codex/responses",
			);
			expect(requests[0].body).toMatchObject({ model: m.id, instructions: "Stable instructions" });
			for (const key of ["previous_response_id", "max_output_tokens"]) expect(requests[0].body[key]).toBeUndefined();
			if (api === "openai-codex-responses") {
				expect(requests[0].body).toMatchObject({
					stream: true,
					store: false,
					client_metadata: { turn_id: "compact-turn" },
				});
				expect((requests[0].body.input as unknown[]).at(-1)).toEqual({ type: "compaction_trigger" });
				expect(requests[0].headers.get("x-codex-beta-features")).toContain("remote_compaction_v2");
				expect(requests[0].headers.get("chatgpt-account-id")).toBe("fake-account");
				expect(requests[0].body.tools).toHaveLength(1);
				expect(JSON.parse(requests[0].headers.get("x-codex-turn-metadata")!)).toMatchObject({
					request_kind: "compaction",
					thread_id: "session",
				});
			} else {
				for (const key of ["tools", "reasoning", "client_metadata", "stream", "store"])
					expect(requests[0].body[key]).toBeUndefined();
			}
			const replay: TranscriptContext = normalizeContext({
				messages: [
					context.messages[0],
					{
						role: "user",
						content: [],
						timestamp: 2,
						openaiCompaction: { ...result.compaction, fallback: context.messages },
					},
				],
			});
			const options = { apiKey, fetch, transport: "sse" as const, sessionId: "session" };
			for (let i = 0; i < 3; i++) {
				const stream =
					api === "openai-responses"
						? responsesStream(m as Model<"openai-responses">, replay, options)
						: codexStream(m as Model<"openai-codex-responses">, replay, options);
				expect((await stream.result()).stopReason).toBe("stop");
				if (i === 1) replay.messages.push({ role: "user", content: "next turn", timestamp: 3 });
			}
			const inputs = requests.slice(1).map((r) => r.body.input as unknown[]);
			const start = api === "openai-responses" ? 1 : 0;
			for (const input of inputs) expect(input.slice(start, start + expectedOutput.length)).toEqual(expectedOutput);
			expect(inputs[1]).toEqual(inputs[0]);
			expect(inputs[2].slice(0, inputs[0].length)).toEqual(inputs[0]);
			expect(transformMessages(replay.messages, { ...m, id: "different-model" })[0]).toEqual(context.messages[0]);
		},
	);

	it("allows a silent 95-second response, independently of short connection timeouts", async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | null | undefined;
		const fetch: typeof globalThis.fetch = async (_url, init) => {
			signal = init?.signal;
			await new Promise((resolve) => setTimeout(resolve, 95_000));
			return response();
		};
		const pending = compactOpenAI(model(), context, { apiKey, fetch, websocketConnectTimeoutMs: 1 });
		await vi.advanceTimersByTimeAsync(94_999);
		expect(signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect((await pending).compaction.output).toEqual(output);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["timeout", "cancel"])("aborts promptly on %s without retrying", async (reason) => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const fetch = vi.fn<typeof globalThis.fetch>(
			async (_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				}),
		);
		const options: SimpleStreamOptions = { apiKey, fetch, signal: controller.signal, maxRetries: 10 };
		const pending = compactOpenAI(model(), context, options);
		const assertion = expect(pending).rejects.toThrow(reason === "cancel" ? "user cancellation" : "300000ms");
		await vi.advanceTimersByTimeAsync(299_999);
		expect(fetch).toHaveBeenCalledTimes(1);
		if (reason === "cancel") controller.abort(new Error("user cancellation"));
		else await vi.advanceTimersByTimeAsync(1);
		await assertion;
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("honors an independent configured timeout", async () => {
		vi.useFakeTimers();
		const fetch: typeof globalThis.fetch = async (_url, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			});
		const assertion = expect(
			compactOpenAI(model(), context, { apiKey, fetch, env: { PI_OPENAI_COMPACTION_TIMEOUT_MS: "600000" } }),
		).rejects.toThrow("600000ms");
		await vi.advanceTimersByTimeAsync(600_000);
		await assertion;
	});

	it.each([{}, { output: [] }, { output: [{ type: "compaction" }] }, { output: [null] }])(
		"rejects malformed output %j",
		async (body) => {
			await expect(
				compactOpenAI(model(), context, { apiKey, fetch: async () => Response.json(body) }),
			).rejects.toThrow();
		},
	);
	it("does not silently fall back to ordinary generation on an unsupported route", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("unsupported", { status: 404 }));
		await expect(compactOpenAI(model(), context, { apiKey, fetch })).rejects.toThrow("HTTP 404");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(supportsNativeOpenAICompaction(model())).toBe(true);
		expect(supportsNativeOpenAICompaction(model(), { PI_OPENAI_COMPACTION: "off" })).toBe(false);
		expect(supportsNativeOpenAICompaction({ ...model(), baseUrl: "https://proxy.invalid/v1" })).toBe(false);
	});
	it("handles the additional finish reason in HEAD's pinned Google SDK", () => {
		expect(mapStopReason(FinishReason.TOO_MANY_TOOL_CALLS)).toBe("error");
	});
});
