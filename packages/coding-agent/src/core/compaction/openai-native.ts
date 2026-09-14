import type { Api, Model, ProviderEnv } from "@earendil-works/pi-ai";
import { supportsNativeOpenAICompaction } from "@earendil-works/pi-ai/api/openai-compaction";
import { buildSessionContext, type SessionEntry } from "../session-manager.ts";
import {
	type CompactionPreparation,
	type CompactionSettings,
	estimateContextTokens,
	prepareCompaction,
} from "./compaction.ts";
import { createFileOps } from "./utils.ts";

export function prepareProviderCompaction(
	entries: SessionEntry[],
	settings: CompactionSettings,
	model: Model<Api>,
	env?: ProviderEnv,
): CompactionPreparation | undefined {
	if (!supportsNativeOpenAICompaction(model, env)) return prepareCompaction(entries, settings);
	if (entries.at(-1)?.type === "compaction") return undefined;
	const messages = buildSessionContext(entries).messages;
	if (!messages.length || messages.every((message) => message.role === "compactionSummary")) return undefined;
	return {
		firstKeptEntryId: entries.at(-1)!.id, // Native output replaces the full window; no local tail is retained.
		messagesToSummarize: messages,
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: estimateContextTokens(messages).tokens,
		fileOps: createFileOps(),
		settings,
	};
}
