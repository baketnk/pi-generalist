import type { AgentTool, NestedToolInvoker } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { NESTED_TOOL_RECORD } from "../../src/core/nested-tool-record.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const echoSchema = Type.Object({ value: Type.Number() });
const echo: AgentTool<typeof echoSchema> = {
	name: "echo",
	label: "echo",
	description: "echo",
	parameters: echoSchema,
	execute: async (_id, args) => ({
		content: [{ type: "text", text: String(args.value) }],
		details: { value: args.value },
	}),
};
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});

async function setup(
	action: (tools: NestedToolInvoker) => Promise<string>,
	options: { tools?: AgentTool<typeof echoSchema>[]; configure?: (pi: ExtensionAPI) => void; allowed?: string[] } = {},
) {
	const h = await createHarness({
		tools: options.tools ?? [echo],
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "compose",
					label: "compose",
					description: "compose",
					parameters: Type.Object({}),
					nestedTools: options.allowed ?? ["echo", "serial", "compose"],
					async execute(_id, _args, _signal, _update, ctx) {
						if (!ctx.tools) throw new Error("Missing execution context");
						return { content: [{ type: "text", text: await action(ctx.tools) }], details: {} };
					},
				});
				options.configure?.(pi);
			},
		],
	});
	harnesses.push(h);
	h.setResponses([
		fauxAssistantMessage([fauxToolCall("compose", {}, { id: "outer" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	return h;
}

function nestedRecords(h: Harness) {
	return h.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === NESTED_TOOL_RECORD);
}

describe("execution-scoped nested tools", () => {
	it("runs prepare/validation/hooks/results through the same lifecycle, without orphan provider messages", async () => {
		const seen: string[] = [];
		const h = await setup(
			async (tools) => {
				const result = await tools.invoke("echo", { old: 2 });
				expect(result.isError).toBe(false);
				return getMessageText(result);
			},
			{
				tools: [{ ...echo, prepareArguments: (args) => ({ value: (args as { old: number }).old }) }],
				configure: (pi) => {
					pi.on("tool_call", (e, ctx) => {
						expect(ctx.tools).toBeUndefined();
						if (e.toolName !== "echo") return;
						expect(e.parentToolCallId).toBe("outer");
						e.input.value = 7;
						seen.push("before");
					});
					pi.on("tool_result", (e) => {
						if (e.toolName !== "echo") return;
						seen.push("after");
						return { content: [{ type: "text", text: "patched" }] };
					});
				},
			},
		);
		await h.session.prompt("compose");
		expect(seen).toEqual(["before", "after"]);
		const results = h.session.messages.filter((m) => m.role === "toolResult");
		expect(results).toHaveLength(1);
		expect(getMessageText(results[0])).toContain("patched");
		expect(nestedRecords(h)).toHaveLength(2);
		expect(nestedRecords(h)[1]).toMatchObject({ data: { effectiveArguments: { value: 7 }, isError: false } });
		expect(h.sessionManager.buildSessionContext().messages.filter((m) => m.role === "toolResult")).toHaveLength(1);
		expect(h.eventsOfType("tool_execution_start").map((e) => e.parentToolCallId)).toEqual([undefined, "outer"]);
	});

	it("records schema failures, blocked calls and recursion failures even if the script prints nothing", async () => {
		const h = await setup(
			async (tools) => {
				for (const [name, args] of [
					["echo", { value: "bad" }],
					["echo", { value: 2 }],
					["compose", {}],
					["missing", {}],
				] as const) {
					expect((await tools.invoke(name, args)).isError).toBe(true);
				}
				return "ignored errors";
			},
			{
				configure: (pi) =>
					pi.on("tool_call", (e) => (e.toolName === "echo" ? { block: true, reason: "blocked" } : undefined)),
			},
		);
		await h.session.prompt("compose");
		expect(nestedRecords(h)).toHaveLength(8);
		expect(getMessageText(h.session.messages.find((m) => m.role === "toolResult"))).toContain("4 failed");
	});

	it("revokes captured invocation contexts once the parent settles", async () => {
		let captured: NestedToolInvoker | undefined;
		const h = await setup(async (tools) => {
			captured = tools;
			return "ok";
		});
		await h.session.prompt("compose");
		await expect(captured!.invoke("echo", { value: 1 })).rejects.toThrow("closed");
	});

	it("rejects tools disabled after the parent starts", async () => {
		let disable = () => {};
		const h = await setup(
			async (tools) => {
				disable();
				expect(getMessageText(await tools.invoke("echo", { value: 1 }))).toContain("inactive");
				return "ok";
			},
			{
				configure: (pi) => {
					disable = () => pi.setActiveTools(["compose"]);
				},
			},
		);
		await h.session.prompt("compose");
		expect(h.eventsOfType("tool_execution_end")).toHaveLength(2);
	});

	it("bounds fan-out, respects sequential child barriers, and keeps direct siblings outside the cell", async () => {
		let running = 0;
		let maxRunning = 0;
		const order: string[] = [];
		const delayed: AgentTool<typeof echoSchema> = {
			...echo,
			execute: async (_id, args) => {
				running++;
				maxRunning = Math.max(maxRunning, running);
				order.push(`start${args.value}`);
				await new Promise((resolve) => setTimeout(resolve, 5));
				order.push(`end${args.value}`);
				running--;
				return { content: [], details: {} };
			},
		};
		const serial: AgentTool<typeof echoSchema> = {
			...echo,
			name: "serial",
			executionMode: "sequential",
			execute: async () => {
				expect(running).toBe(0);
				order.push("serial");
				return { content: [], details: {} };
			},
		};
		const h = await setup(
			async (tools) => {
				await Promise.all([
					...Array.from({ length: 7 }, (_, value) => tools.invoke("echo", { value })),
					tools.invoke("serial", { value: 0 }),
					tools.invoke("echo", { value: 8 }),
				]);
				return "ok";
			},
			{ tools: [delayed, serial] },
		);
		h.setResponses([
			fauxAssistantMessage([fauxToolCall("compose", {}, { id: "outer" }), fauxToolCall("echo", { value: 99 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("compose");
		expect(maxRunning).toBe(4);
		expect(order.indexOf("serial")).toBeGreaterThan(order.indexOf("end6"));
		expect(order.indexOf("start8")).toBeGreaterThan(order.indexOf("serial"));
		expect(order.indexOf("start99")).toBeGreaterThan(order.indexOf("end8"));
	});

	it("cancels forgotten children and reports the outer result as incomplete", async () => {
		let aborted = false;
		const waiting: AgentTool<typeof echoSchema> = {
			...echo,
			execute: async (_id, _args, signal) => {
				await new Promise<void>((resolve) => {
					if (signal?.aborted) resolve();
					else signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				aborted = true;
				throw new Error("cancelled");
			},
		};
		const h = await setup(
			async (tools) => {
				void tools.invoke("echo", { value: 1 });
				await new Promise((resolve) => setTimeout(resolve, 10));
				return "forgot to await";
			},
			{ tools: [waiting] },
		);
		await h.session.prompt("compose");
		expect(aborted).toBe(true);
		expect(h.session.messages.find((m) => m.role === "toolResult")).toMatchObject({ isError: true });
		expect(getMessageText(h.session.messages.find((m) => m.role === "toolResult"))).toContain("1 unfinished");
	});

	it("uses child cancellation signals inside hooks and never starts cancelled queued tools", async () => {
		let hookStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			hookStarted = resolve;
		});
		let executed = false;
		const h = await setup(
			async (tools) => {
				const controller = new AbortController();
				const child = tools.invoke("echo", { value: 0 }, { signal: controller.signal });
				await started;
				controller.abort();
				expect((await child).isError).toBe(true);
				return "cancelled";
			},
			{
				tools: [
					{
						...echo,
						execute: async () => {
							executed = true;
							return { content: [], details: {} };
						},
					},
				],
				configure: (pi) =>
					pi.on("tool_call", async (event, ctx) => {
						if (event.toolName !== "echo") return;
						hookStarted();
						await new Promise<void>((resolve) =>
							ctx.signal?.addEventListener("abort", () => resolve(), { once: true }),
						);
					}),
			},
		);
		await h.session.prompt("compose");
		expect(executed).toBe(false);
		expect(nestedRecords(h)).toHaveLength(2);
	});

	it("aggregates child usage once and propagates termination instead of silently continuing", async () => {
		const usage = {
			input: 2,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 5,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
		};
		const h = await setup(
			async (tools) => {
				await tools.invoke("echo", { value: 0 });
				await expect(tools.invoke("echo", { value: 1 })).rejects.toThrow("closed");
				return "done";
			},
			{ tools: [{ ...echo, execute: async () => ({ content: [], details: {}, usage, terminate: true }) }] },
		);
		await h.session.prompt("compose");
		expect(h.getPendingResponseCount()).toBe(1);
		const result = h.session.messages.find((m) => m.role === "toolResult");
		expect(result).toMatchObject({ usage });
		expect(h.session.getSessionStats().cost).toBeGreaterThanOrEqual(3);
	});

	it("serializes asynchronous child preflight hooks but not independent execution", async () => {
		let active = 0;
		let peak = 0;
		const h = await setup(
			async (tools) => {
				await Promise.all([1, 2, 3].map((value) => tools.invoke("echo", { value })));
				return "ok";
			},
			{
				configure: (pi) =>
					pi.on("tool_call", async (e) => {
						if (e.toolName !== "echo") return;
						active++;
						peak = Math.max(peak, active);
						await new Promise((resolve) => setTimeout(resolve, 5));
						active--;
					}),
			},
		);
		await h.session.prompt("compose");
		expect(peak).toBe(1);
	});

	it("limits nested calls independently of printed output", async () => {
		const h = await setup(async (tools) => {
			const results = await Promise.allSettled(Array.from({ length: 40 }, () => tools.invoke("echo", { value: 0 })));
			expect(results.filter((r) => r.status === "rejected")).toHaveLength(8);
			return "ok";
		});
		await h.session.prompt("compose");
		expect(nestedRecords(h)).toHaveLength(64);
		expect(getMessageText(h.session.messages.find((m) => m.role === "toolResult"))).toContain("8 rejected");
	});
});
