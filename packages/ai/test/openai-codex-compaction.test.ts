import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compactOpenAI } from "../src/api/openai-compaction.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { Context, Model } from "../src/types.ts";

const model: Model<"openai-codex-responses"> = {
	api: "openai-codex-responses",
	provider: "openai-codex",
	id: "gpt-6-astra",
	name: "Astra test",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 200000,
	maxTokens: 20000,
	cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 0 },
};
const context: Context = {
	systemPrompt: "Stable instructions",
	messages: [{ role: "user", content: "Remember this question", timestamp: 1 }],
	tools: [{ name: "probe", description: "Probe", parameters: Type.Object({}) }],
};
const apiKey = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake-account" } })).toString("base64")}.signature`;
const opaque = { type: "compaction", id: "cmp_test", encrypted_content: "opaque-state", extra: { keep: true } };
const completed = { type: "response.completed", response: { id: "compact-response", status: "completed" } };
const events = [{ type: "response.output_item.done", item: opaque }, completed];

function sse(items: unknown[] = events): Response {
	return new Response(items.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

afterEach(() => {
	cleanupSessionResources();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("Codex compaction v2", () => {
	it("uses the finalized payload and retains its user items with the unmodified opaque result", async () => {
		const retained = {
			type: "message",
			role: "user",
			id: "retained",
			content: [{ type: "input_text", text: "hook-finalized user" }],
			extra: true,
		};
		const requests: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
		const fetch: typeof globalThis.fetch = async (url, init) => {
			requests.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
			return sse([
				{ type: "response.output_item.done", item: { type: "message", role: "assistant", content: [] } },
				...events,
			]);
		};
		const result = await compactOpenAI(model, context, {
			apiKey,
			fetch,
			sessionId: "cache",
			reasoning: "high",
			headers: { "X-Codex-Beta-Features": "another-feature" },
			onPayload: (payload) => ({
				...(payload as Record<string, unknown>),
				input: [retained, { type: "function_call_output", call_id: "old", output: "tool history" }],
				previous_response_id: "must-not-be-used",
				service_tier: "priority",
			}),
		});
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(requests[0].body).toMatchObject({
			instructions: context.systemPrompt,
			stream: true,
			store: false,
			reasoning: { effort: "high" },
			prompt_cache_key: "cache",
			service_tier: "priority",
			tools: [{ name: "probe", type: "function" }],
			input: [
				retained,
				{ type: "function_call_output", call_id: "old", output: "tool history" },
				{ type: "compaction_trigger" },
			],
		});
		expect(requests[0].body.previous_response_id).toBeUndefined();
		expect(requests[0].headers.get("accept")).toBe("text/event-stream");
		expect(requests[0].headers.get("x-codex-beta-features")).toBe("another-feature,remote_compaction_v2");
		expect(result.compaction.output).toEqual([retained, opaque]);
		expect(result.usage).toBeUndefined();
	});

	it("bounds retained text, keeps image-only users, and replaces the previous opaque item", async () => {
		const messages: Context["messages"] = [
			{ role: "user", content: "oldest", timestamp: 1 },
			{ role: "user", content: `HEAD${"x".repeat(300000)}TAIL`, timestamp: 2 },
			{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "synthetic" }], timestamp: 3 },
			{ role: "user", content: "newest", timestamp: 4 },
		];
		const first = await compactOpenAI(model, { ...context, messages }, { apiKey, fetch: async () => sse() });
		const text = JSON.stringify(first.compaction.output);
		expect(text).not.toContain("oldest");
		expect(text).toContain("HEAD");
		expect(text).toContain("TAIL");
		expect(text).toContain("data:image/png;base64,synthetic");
		expect(text).toContain("newest");
		expect(text.length).toBeLessThan(257000);
		const nextOpaque = { ...opaque, id: "cmp_next", encrypted_content: "next-state" };
		const second = await compactOpenAI(
			model,
			{
				...context,
				messages: [
					{
						role: "user",
						content: [],
						timestamp: 5,
						openaiCompaction: { ...first.compaction, fallback: messages },
					},
				],
			},
			{
				apiKey,
				fetch: async (_url, init) => {
					expect(JSON.parse(String(init?.body)).input).toEqual([
						...first.compaction.output,
						{ type: "compaction_trigger" },
					]);
					return sse([{ type: "response.output_item.done", item: nextOpaque }, completed]);
				},
			},
		);
		expect(second.compaction.output).toEqual([...first.compaction.output.slice(0, -1), nextOpaque]);
	});

	it.each([
		["missing completion", [events[0]]],
		["missing checkpoint", [completed]],
		["duplicate checkpoint", [events[0], events[0], completed]],
		[
			"empty ciphertext",
			[{ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "" } }, completed],
		],
		["explicit error", [{ type: "error", error: { message: "rejected" } }]],
		["failed response", [{ type: "response.failed" }]],
		["incomplete response", [{ type: "response.incomplete" }]],
		["incomplete terminal status", [events[0], { type: "response.completed", response: { status: "incomplete" } }]],
		["terminal error", [events[0], { type: "response.completed", response: { error: { message: "failed" } } }]],
	] as const)("rejects %s without retry or text fallback", async (_name, streamEvents) => {
		const fetch = vi.fn(async () => sse([...streamEvents]));
		await expect(compactOpenAI(model, context, { apiKey, fetch, maxRetries: 5 })).rejects.toThrow();
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("rejects malformed SSE", async () => {
		await expect(
			compactOpenAI(model, context, {
				apiKey,
				fetch: async () => new Response("data: {bad json}\n\n"),
			}),
		).rejects.toThrow("Invalid Codex SSE JSON");
	});

	it("records streamed cache usage and reports HTTP failure details", async () => {
		const result = await compactOpenAI(model, context, {
			apiKey,
			fetch: async () =>
				sse([
					events[0],
					{
						...completed,
						response: {
							...completed.response,
							usage: {
								input_tokens: 100,
								output_tokens: 12,
								input_tokens_details: { cached_tokens: 80, cache_write_tokens: 5 },
							},
						},
					},
				]),
		});
		expect(result.usage).toMatchObject({ input: 15, cacheRead: 80, cacheWrite: 5, output: 12, totalTokens: 112 });
		await expect(
			compactOpenAI(model, context, {
				apiKey,
				fetch: async () => new Response("unsupported route", { status: 404 }),
			}),
		).rejects.toThrow("HTTP 404): unsupported route");
	});

	it("finishes at response.completed and cancels an otherwise open CRLF stream", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const event of events) {
					const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\r\n\r\n`);
					for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
				}
			},
			cancel,
		});
		const result = await compactOpenAI(model, context, { apiKey, fetch: async () => new Response(body) });
		expect(result.compaction.output.at(-1)).toEqual(opaque);
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it.each(["timeout", "cancel"])("interrupts a silent response body on %s", async (reason) => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const cancel = vi.fn();
		const pending = compactOpenAI(model, context, {
			apiKey,
			signal: controller.signal,
			websocketConnectTimeoutMs: 1,
			fetch: async () => new Response(new ReadableStream({ cancel })),
		});
		const assertion = expect(pending).rejects.toThrow(reason === "timeout" ? "300000ms" : "user cancellation");
		await vi.advanceTimersByTimeAsync(95000);
		expect(cancel).not.toHaveBeenCalled();
		if (reason === "timeout") await vi.advanceTimersByTimeAsync(205000);
		else controller.abort(new Error("user cancellation"));
		await assertion;
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
