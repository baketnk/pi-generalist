import { createHash } from "node:crypto";
import type { AgentRequestIdentity } from "@earendil-works/pi-ai";
import type { SessionEntry } from "./session-manager.ts";

/** Checkpoint-derived UUID: stable across reloads, distinct across sibling branches and forks. */
export function withContextWindow(
	identity: AgentRequestIdentity,
	branch: readonly SessionEntry[],
): AgentRequestIdentity {
	const checkpoints = branch.filter((entry) => entry.type === "compaction");
	const bytes = createHash("sha256")
		.update(JSON.stringify(["pi-context-window-v1", identity.threadId, checkpoints.at(-1)?.id ?? null]))
		.digest()
		.subarray(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x80;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	const contextWindowId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	return { ...identity, windowId: contextWindowId, contextWindowId, windowNumber: checkpoints.length };
}
