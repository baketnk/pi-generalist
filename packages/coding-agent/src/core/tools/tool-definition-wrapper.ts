import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: (signal?: AbortSignal) => ExtensionContext,
): AgentTool<any, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		constrainedSampling: definition.constrainedSampling,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		nestedTools: definition.nestedTools,
		execute: (toolCallId, params, signal, onUpdate, execution) => {
			// AgentTool factories can themselves be registered as ToolDefinitions. In
			// that case the fifth argument is already the extension context.
			const ctx =
				ctxFactory?.(signal) ?? (execution && "cwd" in execution ? (execution as ExtensionContext) : undefined);
			if (ctx && execution) ctx.tools = execution.tools;
			return definition.execute(toolCallId, params, signal, onUpdate, ctx as ExtensionContext);
		},
	};
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: () => ExtensionContext,
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters as any,
		constrainedSampling: tool.constrainedSampling,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		nestedTools: tool.nestedTools,
		execute: async (toolCallId, params, signal, onUpdate, ctx) =>
			tool.execute(toolCallId, params, signal, onUpdate, ctx),
	};
}
