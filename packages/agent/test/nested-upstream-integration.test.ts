import { fauxAssistantMessage, fauxToolCall, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { executeToolCalls } from "../src/tool-execution.ts";
import type { AgentContext, AgentEvent, AgentTool } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "fixture",
	name: "Fixture",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

// Rebase regression: upstream result/error/timing behavior must survive extraction
// into the fork's shared dispatcher, including scoped nested execution.
describe("nested tools with upstream execution semantics", () => {
	it("preserves returned failures and execution timing for nested and direct tools", async () => {
		const child: AgentTool = {
			name: "child",
			label: "Child",
			description: "Returns a structured failure",
			parameters: Type.Object({}),
			async execute() {
				return {
					content: [{ type: "text", text: "failed" }],
					details: { diagnostic: "retained" },
					structuredContent: { value: 1 },
					isError: true,
				};
			},
		};
		const parent: AgentTool = {
			name: "parent",
			label: "Parent",
			description: "Invokes child",
			parameters: Type.Object({}),
			nestedTools: ["child"],
			async execute(_id, _args, _signal, _update, execution) {
				const result = await execution!.nestedTools!.invoke("child", {});
				expect(result.isError).toBe(true);
				expect(result.durationMs).toEqual(expect.any(Number));
				return { content: [{ type: "text", text: "handled" }], details: {} };
			},
		};
		const context: AgentContext = { messages: [], tools: [parent, child] };
		const events: AgentEvent[] = [];
		const batch = await executeToolCalls(
			context,
			fauxAssistantMessage([fauxToolCall("parent", {}, { id: "outer" }), fauxToolCall("child", {})]),
			{ model, convertToLlm: () => [] },
			undefined,
			(event) => {
				events.push(event);
			},
		);
		expect(batch.messages).toHaveLength(2);
		expect(batch.messages[0]).toMatchObject({ isError: false, durationMs: expect.any(Number) });
		expect(batch.messages[1]).toMatchObject({ isError: true, durationMs: expect.any(Number) });
		expect(batch.messages[0].content).toContainEqual({
			type: "text",
			text: expect.stringContaining("1 completed, 1 failed"),
		});
		expect(events.find((event) => event.type === "tool_execution_end" && event.parentToolCallId)).toMatchObject({
			isError: true,
			durationMs: expect.any(Number),
			result: { structuredContent: { value: 1 }, details: { diagnostic: "retained" } },
		});
	});
});
