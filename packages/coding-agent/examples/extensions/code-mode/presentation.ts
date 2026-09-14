import { highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export interface CellToolCall {
	name: string;
	state: "running" | "completed" | "failed" | "unknown";
	summary?: string;
}

export interface ExecDetails {
	calls: number;
	toolCalls: CellToolCall[];
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function oneLine(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 180);
}

/** Summarize observed arguments/results, never parse JS or read today's filesystem. */
export function toolCallSummary(name: string, input: unknown, output?: unknown): string {
	const args = record(input);
	const result = record(output);
	const path = args?.path ?? args?.file_path;
	let summary = name;
	if (["read", "edit", "write", "ls", "find", "grep"].includes(name) && typeof path === "string")
		summary += ` ${path}`;
	if (["bash", "powershell"].includes(name) && typeof args?.command === "string") summary += ` $ ${args.command}`;
	if (["grep", "find"].includes(name) && typeof args?.pattern === "string") summary += ` ${args.pattern}`;
	if (name === "edit" && result?.isError === false) {
		const diff = record(result.details)?.diff;
		if (typeof diff === "string") {
			const lines = diff.split("\n");
			const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
			const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
			summary += ` (+${added}/−${removed})`;
		}
	}
	return oneLine(summary);
}

/** Historical traces render saved facts only: no raw object dumps or fresh edit previews. */
export function renderNestedRecord(data: Record<string, unknown>, expanded: boolean, theme: Theme): Text {
	const name = typeof data.toolName === "string" ? data.toolName : "tool";
	const args = data.effectiveArguments ?? data.arguments;
	const saved = record(data.result);
	const result = saved && { ...saved, isError: data.isError };
	const title = toolCallSummary(name, args, result);
	const state =
		data.phase === "start"
			? "started; outcome unknown until completion"
			: typeof data.isError !== "boolean"
				? "outcome unknown"
				: data.isError
					? "failed"
					: "completed";
	const lines = [theme.fg(data.isError ? "error" : "dim", `${title} · ${state}`)];
	if (record(args)?.truncated === true || record(args)?.unavailable === true)
		lines.push(theme.fg("warning", "Argument snapshot incomplete."));
	if (saved?.truncated === true || saved?.unavailable === true)
		lines.push(theme.fg("warning", "Result snapshot incomplete; full output is not retained here."));
	if (expanded && saved) {
		const diff = name === "edit" && data.isError === false ? record(saved.details)?.diff : undefined;
		const text =
			typeof diff === "string"
				? diff
				: Array.isArray(saved.content)
					? saved.content
							.map((block: unknown) => record(block))
							.filter((block) => block?.type === "text" && typeof block.text === "string")
							.map((block) => block!.text)
							.join("\n")
					: "";
		const preview = text.slice(0, 8192).split("\n").slice(0, 100).join("\n");
		for (const line of preview.split("\n"))
			lines.push(
				theme.fg(
					typeof diff === "string" && line.startsWith("+")
						? "toolDiffAdded"
						: typeof diff === "string" && line.startsWith("-")
							? "toolDiffRemoved"
							: "toolOutput",
					line,
				),
			);
		if (preview !== text) lines.push(theme.fg("dim", "[Saved output preview truncated.]"));
	}
	return new Text(lines.join("\n"), 0, 0);
}

export function renderExecCall(code: string | undefined, expanded: boolean, theme: Theme): Text {
	let title = theme.fg("toolTitle", theme.bold("exec")) + theme.fg("dim", " · trusted local JS");
	if (expanded && code) title += `\n${highlightCode(code, "javascript")}`;
	return new Text(title, 0, 0);
}

export function renderExecResult(
	output: string,
	details: unknown,
	expanded: boolean,
	isPartial: boolean,
	isError: boolean,
	theme: Theme,
): Text {
	const rawCalls = details && typeof details === "object" && "toolCalls" in details ? details.toolCalls : undefined;
	const calls =
		Array.isArray(rawCalls) &&
		rawCalls.length <= 32 &&
		rawCalls.every(
			(call) =>
				call &&
				typeof call.name === "string" &&
				call.name.length <= 128 &&
				(call.summary === undefined || (typeof call.summary === "string" && call.summary.length <= 180)) &&
				["running", "completed", "failed", "unknown"].includes(call.state),
		)
			? (rawCalls as CellToolCall[])
			: undefined;
	const lines: string[] = [];
	if (calls?.length) {
		const failed = calls.filter((call) => call.state === "failed").length;
		const unknown = calls.filter(
			(call) => call.state === "unknown" || (!isPartial && call.state === "running"),
		).length;
		const state = isPartial ? "running" : isError ? "failed" : "completed";
		lines.push(
			theme.fg(
				isError || failed ? "error" : unknown ? "warning" : "dim",
				`${calls.length} nested calls · cell ${state}${failed ? ` · ${failed} failed` : ""}${unknown ? ` · ${unknown} unknown` : ""}`,
			),
		);
		// All (at most 32) calls stay visible in request order, including caught failures.
		for (const call of calls) {
			const status = !isPartial && call.state === "running" ? "unknown" : call.state;
			const color = status === "failed" ? "error" : status === "unknown" ? "warning" : "dim";
			lines.push(theme.fg(color, `  ${oneLine(call.summary ?? call.name)}: ${status}`));
		}
	} else {
		lines.push(
			theme.fg(
				isError ? "error" : "dim",
				isPartial
					? "Cell running; no nested calls yet."
					: calls
						? "No nested tool calls."
						: "Nested call list unavailable for this record.",
			),
		);
	}
	if (expanded) {
		if (output) lines.push(theme.fg("dim", "Output:"), output);
	} else if (isError) {
		// Do not replace a useful error with just a count. Expansion reveals full output.
		const preview = output.split("\n").filter(Boolean).slice(0, 4).join("\n").slice(0, 1000);
		lines.push(theme.fg("error", preview));
		if (preview !== output.trim()) lines.push(theme.fg("dim", "Expand for full output and requested JavaScript."));
	} else if (output && !isPartial) {
		lines.push(theme.fg("dim", "Expand for output and requested JavaScript."));
	}
	return new Text(lines.join("\n"), 0, 0);
}
