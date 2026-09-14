import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type CellToolCall,
	type ExecDetails,
	renderExecCall,
	renderExecResult,
	renderNestedRecord,
	toolCallSummary,
} from "./presentation.ts";
import { runCell } from "./runtime.ts";

const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"];

export default function codeMode(pi: ExtensionAPI) {
	// Startup-only, explicit host configuration. Never rewrite the catalog in a
	// context hook. Stateful extensions require a nested-record compatibility audit.
	const names = [
		...new Set(
			(process.env.PI_CODE_MODE_TOOLS?.split(",") ?? DEFAULT_TOOLS).map((name) => name.trim()).filter(Boolean),
		),
	];
	if (names.includes("exec")) throw new Error("Code Mode cannot include itself");
	// Throwing preserves normal failure semantics; the result hook retains UI-only details.
	const failedDetails = new Map<string, ExecDetails>();
	pi.on("tool_result", (event) => {
		if (event.toolName !== "exec") return;
		const details = failedDetails.get(event.toolCallId);
		failedDetails.delete(event.toolCallId);
		if (details) return { details };
	});
	pi.on("session_shutdown", () => failedDetails.clear());
	pi.registerTool({
		name: "exec",
		label: "exec (trusted local JS)",
		description: `Run a fresh JavaScript cell to compose existing tools without another model round-trip. TRUSTED LOCAL EXECUTION, NOT SANDBOXED. Use await tools.NAME(args), with the same argument schemas as direct tools. Configured nested names: ${names.join(", ")}; only currently active tools are callable. Each successful call returns {content:[{type:"text",text}], details, isError, toolCallId}; failed tools reject with error.result containing that result. Use text(value) to return selected output. Supports await, loops, branching, Promise.all/allSettled. No persistent state; do not leave unfinished calls. 32 nested calls, 4 concurrent, 64 KiB source, 50 KiB output, 4 MiB aggregate nested results. Default 60s deadline, maximum 300s; use bg_tasks directly for long commands. Text only: call image-producing tools directly. Child calls retain normal hooks and durable bounded traces; a host-generated summary reports failures even if not printed. Direct host I/O bypasses those traces: use tools, not Node APIs. No automatic retries or rollback; inspect partial failures before retrying mutations.`,
		promptSnippet: "Compose tool calls in a disposable local JavaScript process",
		promptGuidelines: [
			"Use exec for data-dependent tool sequencing or local result reduction; use direct calls for simple operations. Await every nested call and print useful results. Do not use exec for blocking questions, session changes, or unreviewed stateful extensions.",
		],
		parameters: Type.Object({
			code: Type.String({
				maxLength: 65536,
				description: "JavaScript function body; top-level await and tools.NAME(args)/text(value) are available",
			}),
			timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
		}),
		nestedTools: names,
		async execute(id, args, signal, onUpdate, ctx) {
			if (!ctx.tools)
				throw new Error("Code Mode requires the nested-tools Pi fork; no unsafe fallback is available");
			const invoker = ctx.tools;
			const toolCalls: CellToolCall[] = [];
			const details = (): ExecDetails => ({
				calls: toolCalls.length,
				toolCalls: toolCalls.map((call) => ({ ...call })),
			});
			const update = () => onUpdate?.({ content: [], details: details() });
			const result = await runCell({
				code: args.code,
				cwd: ctx.cwd,
				tools: names.filter((name) => pi.getActiveTools().includes(name)),
				invoke: async (name, input, options) => {
					const call: CellToolCall = { name, state: "running", summary: toolCallSummary(name, input) };
					toolCalls.push(call);
					update();
					try {
						const result = await invoker.invoke(name, input, options);
						call.state = result.isError ? "failed" : "completed";
						call.summary = toolCallSummary(name, input, result);
						return result;
					} catch (error) {
						call.state = "unknown";
						throw error;
					} finally {
						update();
					}
				},
				signal,
				timeoutMs: (args.timeoutSeconds ?? 60) * 1000,
			});
			if (result.error) {
				failedDetails.set(id, details());
				throw new Error(
					`${result.error}${result.output ? `\n\nPrinted output before failure:\n${result.output}` : ""}`,
				);
			}
			return {
				content: [{ type: "text", text: result.output || "Cell completed without printed output." }],
				details: details(),
			};
		},
		renderCall(args, theme, context) {
			return renderExecCall(args.code, context.expanded, theme);
		},
		renderResult(result, options, theme, context) {
			const output = result.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			return renderExecResult(output, result.details, options.expanded, options.isPartial, context.isError, theme);
		},
	});

	// Core emits live child tool rows. Custom entries restore bounded traces on
	// resume/reload without inventing assistant tool calls or replaying code.
	pi.registerEntryRenderer<Record<string, unknown>>("pi.nested-tool.v1", (entry, { expanded }, theme) => {
		return entry.data ? renderNestedRecord(entry.data, expanded, theme) : undefined;
	});

	pi.registerCommand("code-mode", {
		description: "Show Code Mode trust boundary and nested tool configuration",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`Code Mode: trusted disposable process, NOT sandboxed. Nested tools: ${names.join(", ")}. No persistent cells or replay. Configure PI_CODE_MODE_TOOLS before startup; stateful extensions need explicit compatibility review.`,
				"info",
			);
		},
	});
}
