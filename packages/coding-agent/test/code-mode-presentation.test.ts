import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import codeMode from "../examples/extensions/code-mode/index.ts";
import {
	renderExecCall,
	renderExecResult,
	renderNestedRecord,
	toolCallSummary,
} from "../examples/extensions/code-mode/presentation.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];
beforeAll(() => initTheme("dark"));
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});

const details = {
	calls: 3,
	toolCalls: [
		{ name: "read", state: "completed" },
		{ name: "bash", state: "failed" },
		{ name: "edit", state: "running" },
	],
};

describe("Code Mode presentation", () => {
	it("formats observed edit summaries and saved diffs rather than JSON", () => {
		const args = { path: "sum.mjs", edits: [{ oldText: "before", newText: "after" }] };
		const result = {
			isError: false,
			content: [{ type: "text", text: "Edit succeeded" }],
			details: { diff: "-1 before\n+1 after" },
		};
		expect(toolCallSummary("edit", args, result)).toBe("edit sum.mjs (+1/−1)");
		expect(toolCallSummary("edit", args, { ...result, isError: true })).toBe("edit sum.mjs");
		const data = { phase: "end", toolName: "edit", effectiveArguments: args, result, isError: false };
		const collapsed = stripAnsi(renderNestedRecord(data, false, theme).render(120).join("\n"));
		expect(collapsed).toContain("edit sum.mjs (+1/−1) · completed");
		expect(collapsed).not.toContain("oldText");
		const expanded = stripAnsi(renderNestedRecord(data, true, theme).render(120).join("\n"));
		expect(expanded).toContain("-1 before");
		expect(expanded).toContain("+1 after");
		expect(expanded).not.toContain("effectiveArguments");
		const parent = {
			calls: 1,
			toolCalls: [{ name: "edit", state: "completed", summary: toolCallSummary("edit", args, result) }],
		};
		expect(stripAnsi(renderExecResult("", parent, false, false, false, theme).render(120).join("\n"))).toContain(
			"edit sum.mjs (+1/−1)",
		);
	});

	it("summarizes shell/read calls and labels incomplete saved snapshots without dumping them", () => {
		expect(toolCallSummary("read", { path: "manifest.json" })).toBe("read manifest.json");
		expect(toolCallSummary("bash", { command: "node test.mjs\n" })).toBe("bash $ node test.mjs ");
		expect(toolCallSummary("write", { path: "x".repeat(500), content: "secret" }).length).toBeLessThanOrEqual(180);
		const view = stripAnsi(
			renderNestedRecord(
				{
					phase: "end",
					toolName: "read",
					isError: false,
					effectiveArguments: { truncated: true, preview: "private-argument" },
					result: { truncated: true, preview: "private-result" },
				},
				true,
				theme,
			)
				.render(120)
				.join("\n"),
		);
		expect(view).toContain("Argument snapshot incomplete");
		expect(view).toContain("Result snapshot incomplete");
		expect(view).not.toContain("private");
	});

	it("hides requested JS until expanded, without guessing calls from source text", () => {
		const code = 'const result = await tools.read({path: "fixture.txt"});\ntext(result.content);';
		expect(stripAnsi(renderExecCall(code, false, theme).render(120).join("\n"))).not.toContain("fixture.txt");
		const expanded = stripAnsi(renderExecCall(code, true, theme).render(120).join("\n"));
		for (const line of code.split("\n")) expect(expanded).toContain(line);
		expect(expanded).toContain("trusted local JS");
	});

	it("shows calls and caught failures collapsed; final running records become unknown", () => {
		const collapsed = stripAnsi(
			renderExecResult("private-output", details, false, false, false, theme).render(120).join("\n"),
		);
		expect(collapsed).toContain("3 nested calls · cell completed · 1 failed · 1 unknown");
		expect(collapsed).toContain("bash: failed");
		expect(collapsed).toContain("edit: unknown");
		expect(collapsed).not.toContain("private-output");
		const live = stripAnsi(renderExecResult("", details, false, true, false, theme).render(120).join("\n"));
		expect(live).toContain("edit: running");
		expect(live).toContain("cell running");
	});

	it("keeps error diagnostics visible collapsed and does not fabricate historical call lists", () => {
		const failed = stripAnsi(
			renderExecResult("Compiler diagnostic", details, false, false, true, theme).render(120).join("\n"),
		);
		expect(failed).toContain("cell failed");
		expect(failed).toContain("Compiler diagnostic");
		for (const old of [undefined, { calls: 4 }, { toolCalls: "bad" }, { toolCalls: [null] }]) {
			expect(
				stripAnsi(renderExecResult("saved output", old, true, false, false, theme).render(120).join("\n")),
			).toContain("Nested call list unavailable");
		}
	});

	it("wraps within narrow terminal widths and expands output", () => {
		for (const width of [12, 40, 80]) {
			const component = renderExecResult("long-output-".repeat(20), details, true, false, true, theme);
			const lines = component.render(width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(stripAnsi(lines.join("\n"))).toContain("Output:");
		}
	});

	it("works through the real tool row when expansion is toggled after settlement", async () => {
		const h = await createHarness({ extensionFactories: [codeMode] });
		harnesses.push(h);
		const definition = h.session.getToolDefinition("exec");
		expect(definition?.renderCall).toBeDefined();
		const component = new ToolExecutionComponent(
			"exec",
			"cell",
			{ code: "text('source-marker');" },
			{},
			definition,
			{ requestRender: () => {} } as unknown as TUI,
			h.tempDir,
		);
		component.updateResult({ content: [{ type: "text", text: "output-marker" }], details, isError: true }, false);
		expect(stripAnsi(component.render(120).join("\n"))).not.toContain("source-marker");
		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("text('source-marker');");
		expect(expanded).toContain("output-marker");
		component.setExpanded(false);
		expect(stripAnsi(component.render(120).join("\n"))).not.toContain("source-marker");
	});
});
