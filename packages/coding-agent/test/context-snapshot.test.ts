import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ContextSnapshotEvent, ExtensionFactory } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

async function runnerFor(factories: ExtensionFactory[]) {
	const runtime = createExtensionRuntime();
	const bus = createEventBus();
	const extensions = await Promise.all(
		factories.map((factory, i) => loadExtensionFromFactory(factory, "/tmp", bus, runtime, `snapshot-${i}`)),
	);
	const manager = SessionManager.inMemory("/tmp");
	const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	return { runner: new ExtensionRunner(extensions, runtime, "/tmp", manager, registry), manager };
}

test("snapshot observes final context regardless of order; copies and returns cannot mutate it", async () => {
	const observed: ContextSnapshotEvent[] = [];
	const { runner, manager } = await runnerFor([
		(pi) => {
			pi.on("context_snapshot", (event) => {
				observed.push(structuredClone(event));
				event.messages.length = 0;
			});
		},
		(pi) => {
			pi.on("context", (event) => ({
				messages: [...event.messages, { role: "user", content: "projected", timestamp: 2 }],
			}));
			pi.on("context_snapshot", (event) => {
				observed.push(structuredClone(event));
				throw new Error("observer failed");
			});
		},
	]);
	const leaf = manager.appendMessage({ role: "user", content: "base", timestamp: 1 });
	const input: AgentMessage[] = [{ role: "user", content: "base", timestamp: 1 }];
	const errors: string[] = [];
	runner.onError((e) => errors.push(e.error));
	const result = await runner.emitContext(input);
	expect(input).toHaveLength(1);
	expect(result).toHaveLength(2);
	expect(observed[0]).toEqual(observed[1]);
	expect(observed[0]).toMatchObject({ leafId: leaf, contextErrors: 0, providerRequestHooks: false });
	expect(observed[0].messages).toEqual(result);
	expect(errors).toEqual(["observer failed"]);
	expect(manager.getLeafId()).toBe(leaf);
	expect(manager.getEntries()).toHaveLength(1);
});

test("snapshot exposes transform failure and potential later payload rewriting", async () => {
	let snapshot: ContextSnapshotEvent | undefined;
	const { runner } = await runnerFor([
		(pi) => {
			pi.on("context", () => {
				throw new Error("transform failed");
			});
			pi.on("before_provider_request", () => undefined);
			pi.on("context_snapshot", (event) => {
				snapshot = event;
			});
		},
	]);
	expect(await runner.emitContext([])).toEqual([]);
	expect(snapshot).toMatchObject({ contextErrors: 1, providerRequestHooks: true, leafId: null });
});
