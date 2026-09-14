import type { Api, Message, Model, OpenAICompaction } from "../types.ts";

export function compactionMatchesModel(compaction: OpenAICompaction, model: Model<Api>): boolean {
	return (
		compaction.api === model.api &&
		compaction.provider === model.provider &&
		compaction.model === model.id &&
		compaction.baseUrl.replace(/\/$/, "") === model.baseUrl.replace(/\/$/, "")
	);
}

/** A provider/model change replays transparent history, never ciphertext to an incompatible model. */
export function expandIncompatibleCompactions(messages: Message[], model: Model<Api>): Message[] {
	return messages.flatMap((message) => {
		if (
			message.role !== "user" ||
			!message.openaiCompaction ||
			compactionMatchesModel(message.openaiCompaction, model)
		) {
			return [message];
		}
		return message.openaiCompaction.fallback;
	});
}

export function getOpenAICompaction(details: unknown): OpenAICompaction | undefined {
	if (!details || typeof details !== "object" || !("openaiCompaction" in details)) return undefined;
	const value = details.openaiCompaction;
	if (
		!value ||
		typeof value !== "object" ||
		!("api" in value) ||
		(value.api !== "openai-responses" && value.api !== "openai-codex-responses") ||
		!("provider" in value) ||
		typeof value.provider !== "string" ||
		!("model" in value) ||
		typeof value.model !== "string" ||
		!("baseUrl" in value) ||
		typeof value.baseUrl !== "string" ||
		!("output" in value)
	)
		throw new Error("Invalid OpenAI compaction checkpoint");
	assertCompactedOutput(value.output);
	return value as OpenAICompaction;
}

export function assertCompactedOutput(output: unknown): asserts output is OpenAICompaction["output"] {
	if (
		!Array.isArray(output) ||
		!output.length ||
		!output.every(
			(item: unknown) =>
				item !== null && typeof item === "object" && "type" in item && typeof item.type === "string",
		) ||
		!output.some(
			(item: unknown) =>
				item !== null &&
				typeof item === "object" &&
				"type" in item &&
				item.type === "compaction" &&
				"encrypted_content" in item &&
				typeof item.encrypted_content === "string" &&
				item.encrypted_content.length > 0,
		)
	) {
		throw new Error("OpenAI compaction returned no valid compacted window; conversation was not replaced");
	}
}
