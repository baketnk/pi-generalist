/**
 * Tool wrappers for extension-registered tools.
 * Tool call and result interception is handled by AgentSession via agent-core hooks.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { JsonObject } from "@earendil-works/pi-ai";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import type { ExtensionRunner } from "./runner.ts";
import type { RegisteredTool } from "./types.ts";

/** Wrap a registered tool with its per-call extension context and scoped nested authority. */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	const tool = wrapToolDefinition(registeredTool.definition, (toolCallId, signal) =>
		runner.createToolContext(toolCallId, signal),
	);
	const execute = tool.execute;
	return {
		...tool,
		execute: (toolCallId, params, signal, onUpdate, execution) => {
			const invoker = execution?.nestedTools;
			const guardedExecution = invoker && {
				nestedTools: {
					invoke: (name: string, args: JsonObject, options?: { signal?: AbortSignal }) => {
						runner.getActiveTools(); // Throws for an invalidated extension runtime.
						return invoker.invoke(name, args, options);
					},
				},
			};
			// Tool-loadout changes are committed as system-message deltas by the
			// upstream loop; do not also encode obsolete addedToolNames metadata.
			return execute(toolCallId, params, signal, onUpdate, guardedExecution);
		},
	};
}

export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map((tool) => wrapRegisteredTool(tool, runner));
}
