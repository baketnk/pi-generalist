import type { JsonValue } from "../types.ts";
import { assertCompactedOutput } from "../utils/openai-compaction.ts";

// Codex remote compaction v2 retains recent user text alongside its opaque item.
// This budget applies only when creating a checkpoint, never when replaying one.
const RETAINED_USER_TOKEN_BUDGET = 64_000;

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function retainUserMessages(input: JsonValue[]): JsonValue[] {
	let remaining = RETAINED_USER_TOKEN_BUDGET;
	const retained: JsonValue[] = [];
	for (let i = input.length - 1; i >= 0 && remaining > 0; i--) {
		const item = input[i];
		if (
			!item ||
			typeof item !== "object" ||
			Array.isArray(item) ||
			item.role !== "user" ||
			(item.type !== undefined && item.type !== "message")
		)
			continue;
		const message = structuredClone(item);
		const content =
			typeof message.content === "string" ? [{ type: "input_text", text: message.content }] : message.content;
		if (!Array.isArray(content)) continue;
		let characters = remaining * 4;
		const parts: JsonValue[] = [];
		for (const part of content) {
			if (part && typeof part === "object" && !Array.isArray(part) && typeof part.text === "string") {
				if (characters === 0) continue;
				if (part.text.length > characters) {
					const head = Math.ceil((characters - 1) / 2);
					const tail = Math.floor((characters - 1) / 2);
					part.text = `${part.text.slice(0, head)}…${tail > 0 ? part.text.slice(-tail) : ""}`;
				}
				characters -= part.text.length;
			}
			parts.push(part);
		}
		if (!parts.length) continue;
		const tokens = Math.max(1, Math.ceil((remaining * 4 - characters) / 4));
		remaining -= tokens;
		// Easy input messages omit type; persisted checkpoints require an explicit type.
		retained.push({ ...message, type: "message", content: parts });
	}
	return retained.reverse();
}

/** Collect v2's single opaque result, then construct the durable replacement window. */
export async function collectCodexCompaction(
	events: AsyncIterable<Record<string, unknown>>,
	input: JsonValue[],
	onMetadata: (headers: Record<string, unknown>) => void,
): Promise<{ output: JsonValue[]; usage: unknown }> {
	const items: unknown[] = [];
	for await (const event of events) {
		if (event.type === "codex.response.metadata" || event.type === "response.metadata") {
			if (isObject(event.headers)) onMetadata(event.headers);
		} else if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") {
			const response = isObject(event.response) ? event.response : undefined;
			const error = isObject(event.error) ? event.error : isObject(response?.error) ? response.error : event;
			throw new Error(`Codex compaction failed: ${typeof error.message === "string" ? error.message : event.type}`);
		} else if (event.type === "response.output_item.done") {
			if (isObject(event.item) && event.item.type === "compaction") items.push(event.item);
		} else if (event.type === "response.completed" || event.type === "response.done") {
			if (
				!isObject(event.response) ||
				event.response.error ||
				(event.response.status !== undefined && event.response.status !== "completed")
			) {
				throw new Error("Codex compaction did not complete; conversation was not replaced");
			}
			if (items.length !== 1) {
				throw new Error(`Codex compaction expected exactly one compaction item, received ${items.length}`);
			}
			assertCompactedOutput(items);
			return { output: [...retainUserMessages(input), ...items], usage: event.response.usage };
		}
	}
	throw new Error("Codex compaction stream ended before response.completed; conversation was not replaced");
}
