import type { AgentEvent } from "@earendil-works/pi-agent-core";

export const NESTED_TOOL_RECORD = "pi.nested-tool.v1";
export const NESTED_RECORD_MAX_BYTES = 64 * 1024;

/** Custom entries, not provider messages. A start with no end means outcome unknown, never replay-safe. */
export function nestedToolRecord(event: AgentEvent): Record<string, unknown> | undefined {
	if ((event.type !== "tool_execution_start" && event.type !== "tool_execution_end") || !event.parentToolCallId)
		return undefined;
	return {
		phase: event.type === "tool_execution_start" ? "start" : "end",
		parentToolCallId: event.parentToolCallId,
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		...(event.type === "tool_execution_start"
			? { arguments: snapshot(event.args) }
			: {
					isError: event.isError,
					effectiveArguments: snapshot(event.effectiveArgs),
					result: snapshot(event.result),
				}),
	};
}

function snapshot(value: unknown): unknown {
	try {
		const json = JSON.stringify(value);
		if (json === undefined) return null;
		const bytes = Buffer.byteLength(json);
		if (bytes <= NESTED_RECORD_MAX_BYTES) return JSON.parse(json);
		return {
			truncated: true,
			originalBytes: bytes,
			preview: Buffer.from(json).subarray(0, NESTED_RECORD_MAX_BYTES).toString("utf8"),
		};
	} catch {
		return { unavailable: true, reason: "Value is not JSON serializable" };
	}
}
