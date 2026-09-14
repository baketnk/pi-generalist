import { describe, expect, it } from "vitest";
import { withContextWindow } from "../src/core/request-identity.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("committed context-window identity (#9481)", () => {
	it("survives reload and retries, changes only on checkpoints, distinguishes siblings and forks", () => {
		const manager = SessionManager.inMemory();
		const identity = {
			sessionId: manager.getSessionId(),
			threadId: manager.getSessionId(),
			turnId: "turn",
			requestKind: "turn" as const,
			startedAt: 1,
		};
		const root = withContextWindow(identity, manager.getBranch());
		const user = manager.appendMessage({ role: "user", content: "one", timestamp: 1 });
		expect(withContextWindow({ ...identity, turnId: "retry" }, manager.getBranch()).contextWindowId).toBe(
			root.contextWindowId,
		);
		const first = manager.appendCompaction("one", user, 100);
		const window = withContextWindow(identity, manager.getBranch());
		expect(window.contextWindowId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
		expect(window.windowNumber).toBe(1);
		expect(window.contextWindowId).not.toBe(root.contextWindowId);
		const restored = SessionManager.inMemory(
			undefined,
			undefined,
			JSON.parse(JSON.stringify([manager.getHeader(), ...manager.getEntries()])),
		);
		expect(withContextWindow(identity, restored.getBranch())).toEqual(window);
		manager.branch(user);
		expect(withContextWindow(identity, manager.getBranch())).toEqual(root);
		manager.appendCompaction("sibling", user, 100);
		expect(withContextWindow(identity, manager.getBranch()).contextWindowId).not.toBe(window.contextWindowId);
		manager.branch(first);
		expect(withContextWindow(identity, manager.getBranch())).toEqual(window);
		manager.createBranchedSession(first);
		expect(
			withContextWindow(
				{ ...identity, threadId: manager.getSessionId(), sessionId: manager.getSessionId() },
				manager.getBranch(),
			).contextWindowId,
		).not.toBe(window.contextWindowId);
	});
});
