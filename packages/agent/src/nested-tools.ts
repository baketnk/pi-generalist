import type { ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolCall, AgentToolResult, NestedToolInvoker } from "./types.ts";

export const NESTED_MAX_CALLS = 32;
export const NESTED_MAX_CONCURRENCY = 4;

type Outcome = { result: AgentToolResult<unknown>; isError: boolean };
type DispatchResult = { message: ToolResultMessage; terminate: boolean };

/** A scope owns all child work, including calls the parent forgot to await. */
export function createNestedScope(
	parentToolCallId: string,
	allowed: readonly string[],
	tools: AgentTool[],
	parentSignal: AbortSignal | undefined,
	sequential: boolean,
	dispatch: (call: AgentToolCall, signal: AbortSignal) => Promise<DispatchResult>,
): { context: NestedToolInvoker; finish(outcome: Outcome): Promise<Outcome> } {
	const controller = new AbortController();
	const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
	const pending = new Set<Promise<void>>();
	const running = new Set<Promise<void>>();
	const records: Array<{ id: string; name: string; isError: boolean }> = [];
	let barrier: Promise<unknown> = Promise.resolve();
	let open = true;
	let calls = 0;
	let rejected = 0;
	let terminating = false;
	let usage: Usage | undefined;

	const context: NestedToolInvoker = {
		invoke(name, args, options) {
			if (!open || signal.aborted || terminating) {
				return Promise.reject(new Error("Nested tool scope is closed or aborted"));
			}
			if (++calls > NESTED_MAX_CALLS) {
				rejected++;
				return Promise.reject(new Error(`Nested tool call limit (${NESTED_MAX_CALLS}) exceeded`));
			}
			const toolCall: AgentToolCall = {
				type: "toolCall",
				id: `${parentToolCallId}:nested:${calls}`,
				name,
				arguments: structuredClone(args),
				parentToolCallId,
			};
			const tool = tools.find((candidate) => candidate.name === name);
			const exclusive = sequential || tool?.executionMode === "sequential";
			const predecessors = exclusive ? Promise.all([...pending]) : barrier;
			const childSignal = options?.signal ? AbortSignal.any([signal, options.signal]) : signal;
			const operation = (async () => {
				await predecessors;
				while (running.size >= NESTED_MAX_CONCURRENCY) await Promise.race(running);
				// Admission and insertion into running happen without another yield.
				const execution = dispatch(toolCall, childSignal);
				const tracked = execution.then(
					() => {},
					() => {},
				);
				running.add(tracked);
				try {
					const result = await execution;
					records.push({ id: toolCall.id, name, isError: result.message.isError });
					if (result.message.usage) usage = sumUsage(usage, result.message.usage);
					if (result.terminate) {
						terminating = true;
						controller.abort();
					}
					return result.message;
				} catch (error) {
					records.push({ id: toolCall.id, name, isError: true });
					throw error;
				} finally {
					running.delete(tracked);
				}
			})();
			const settled = operation.then(
				() => {},
				() => {},
			);
			pending.add(settled);
			void settled.then(() => pending.delete(settled));
			if (exclusive) barrier = settled;
			return operation;
		},
	};

	// Filtering is done by the dispatcher, before lookup/validation/hooks. Keep this
	// assertion here to catch an accidentally unconfigured orchestration tool.
	if (!Array.isArray(allowed)) throw new Error("nestedTools must be an explicit allowlist");

	return {
		context,
		async finish(outcome) {
			open = false;
			const unfinished = pending.size;
			if (unfinished) controller.abort();
			// Do not let forgotten mutations outlive the outer result. Arbitrary host
			// tools must cooperate with abort; we cannot force-kill extension code.
			await Promise.all([...pending]);
			const failed = records.filter((record) => record.isError);
			const summary = `Nested tools: ${records.length} completed, ${failed.length} failed, ${rejected} rejected by call limit, ${unfinished} unfinished at parent return (cancel requested).${failed.length ? ` Failed IDs: ${failed.map((record) => record.id).join(", ")}.` : ""}${terminating ? " Child requested termination." : ""}`;
			return {
				isError: outcome.isError || unfinished > 0,
				result: {
					...outcome.result,
					content: [...(outcome.result.content ?? []), { type: "text", text: summary }],
					...(usage ? { usage: sumUsage(outcome.result.usage, usage) } : {}),
					...(terminating ? { terminate: true } : {}),
				},
			};
		},
	};
}

function sumUsage(left: Usage | undefined, right: Usage): Usage {
	if (!left) return structuredClone(right);
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		totalTokens: left.totalTokens + right.totalTokens,
		cost: {
			input: left.cost.input + right.cost.input,
			output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead,
			cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
		},
	};
}
