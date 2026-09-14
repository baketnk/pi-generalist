# Code Mode (local nested-tools fork)

Opt-in trusted local JavaScript orchestration. This is **not a security sandbox**.
It reduces model round-trips by composing existing tools inside one disposable Node process.

## Run

From any project directory:

```bash
/home/baketnk/workspace/pi-mono/pi-nested
```

The source launcher preserves cwd and defaults to the normal `~/.pi/agent`
profile. Its provider authentication, installed Generalist package, and other Pi
settings therefore apply without copying credentials or replacing the installed
`pi`. To deliberately use an isolated profile instead:

```bash
PI_CODING_AGENT_DIR="$HOME/.pi-nested/agent" /home/baketnk/workspace/pi-mono/pi-nested
```

Existing global extensions then load normally; Code Mode does not activate their
nested use automatically. No PATH entry or global installation is required.
`--exclude-tools exec` disables Code Mode. `/code-mode` displays the configuration.

On an already running **fork**, the equivalent explicit extension is:

```bash
/path/to/pi-mono/pi-test.sh -e /path/to/pi-mono/packages/coding-agent/examples/extensions/code-mode/index.ts
```

Loading this extension into stock Pi cannot invoke tools: it reports the missing
fork API instead of falling back to private execute closures or in-process eval.
The supported development path is Node/tsx on Linux; standalone Bun binaries and
Windows process-tree teardown are not validated by this MVP.

## Model interface

`exec({ code, timeoutSeconds? })` accepts a JavaScript function body with top-level
`await`. It supplies `tools.NAME(args)` and `text(value)`:

```javascript
const result = await tools.read({ path: "manifest.json" });
const manifest = JSON.parse(result.content[0].text);
const results = await Promise.allSettled(
  manifest.files.map(path => tools.read({ path }))
);
for (const result of results) {
  text(result.status === "fulfilled" ? result.value.content : String(result.reason));
}
```

Arguments match the normal direct-tool schemas. Results contain `content`,
`details`, `isError`, `toolCallId`, and other normal tool-result fields. A tool error
rejects the JavaScript promise; `error.result` retains its structured result when
available. Only text results are supported; invoke image-producing tools directly.
A non-text result produces an explicit bridge error rather than silently dropping
its content.

Use direct calls for trivial operations. Code Mode helps with data-dependent
sequencing, loops, bounded parallelism, or selecting relevant output before it
enters model context. It does not make another model call. Direct tools stay
available with their normal definitions.

## Tool display and failure diagnostics

Collapsed `exec` rows show child paths/commands and completed edit diff counts
(e.g. `edit sum.mjs (+1/−1)`), with running/completed/failed/unknown states,
rather than JSON argument/result blobs. These summaries use observed child
requests and results, not guesses from JavaScript. Caught child failures remain
visible even when the cell itself completes. Expand the row with the normal
tool-output toggle to inspect the requested, syntax-highlighted JavaScript and
selected output. Explicitly script-printed output is preserved as-is, including
JSON if that is what the script printed. Error previews stay visible collapsed.

Restored nested trace rows use recorded effective arguments and show saved edit
diffs or bounded text output when expanded, not raw JSON metadata. They never
read current files to reconstruct an old edit preview. Incomplete snapshots
remain explicit; expanded saved output is capped at 8192 characters/100 lines.
Core live child rows and the durable trace format are unchanged.

Call lists are bounded to the cell limit and persisted in outer result details
for successful and failed cells. Old results without a list say it is unavailable;
they are not guessed from source text. Presentation does not change tool schemas,
guidelines, or provider messages. No automatic reload or context reinjection.

Uncaught nested tool failures now include up to 4096 characters of tool-provided
text diagnostics, with an explicit truncation marker, instead of only suggesting
`error.result`. Caught exceptions still carry the full bridge-bounded structured
result. Failure is shown before earlier printed output, so a large successful
read cannot bury a subsequent compiler error in the collapsed preview.

## Limits and ownership

- Fresh process per cell, no persistent variables, timers, store/load, or resumable cells.
- 64 KiB UTF-8 source; 60-second default deadline, user/model-selectable up to 300 seconds.
- At most 32 nested requests and 4 simultaneous child dispatches.
- 256 KiB serialized arguments per bridge request; 1 MiB maximum protocol frame;
  4 MiB aggregate serialized results sent to the worker.
- Printed/stdout/stderr output: 50 KiB or 2,000 newlines, plus bounded error/host diagnostics.
- Node `--max-old-space-size=256`. This is a V8 heap limit, **not a hard total-RSS limit**.
- One nested level; orchestrators cannot call themselves or another orchestrator.
- Every opted-in orchestrator is sequential against direct sibling tools. Inside
  a cell, sequential child tools form barriers; otherwise calls can overlap.
  Existing tool-owned file mutation queues are retained, not replaced.
- Abort, deadline, script failure, or unfinished calls cause process termination
  and cancellation requests for owned child tools. Linux kills the process group.
- Host tools must cooperate with `AbortSignal`. Pi waits for them to settle instead
  of falsely claiming they stopped or releasing unknown mutations into a later turn.
  A non-cooperative extension can still delay cancellation indefinitely.
- No automatic retries, rollback, or mutation replay. A cell failure may follow
  successful or partial writes. Inspect outcomes before deciding to retry.

`bg_tasks` remains the direct tool for intentionally asynchronous work; Code Mode
cells do not outlive their outer tool invocation. A trusted script can deliberately
escape these conventions using host APIs or detached processes; this version does
not defend against that.

## What is and is not sandboxed

The JavaScript runs outside Pi's process, so a synchronous infinite loop does not
freeze the TUI. It still has normal Node capabilities and host access. No provider
keys or Node preload flags are copied into its environment, but it can still read
files containing credentials, use the network, import modules, and start processes.
Do not treat the reduced environment as a security boundary.

Only calls routed through `tools` get nested validation, hooks and traces. Direct
Node I/O bypasses them. The model instructions require brokered tool use; that is a
convention here, not an enforced capability boundary.

A future restricted runtime can replace `runtime.ts`/`worker.mjs` without replacing
the shared dispatcher. Sandboxing the actual tools is a separate, broader change.
Registered sandboxed Bash overrides are used normally, but neither that override
nor a VM adapter automatically confines arbitrary extension I/O.

## Extension API and compatibility

Register an orchestrator with an explicit allowlist:

```typescript
pi.registerTool({
  name: "compose",
  // label, description, parameters ...
  nestedTools: ["read", "edit"],
  async execute(id, args, signal, onUpdate, ctx) {
    if (!ctx.tools) throw new Error("Nested dispatch is unavailable");
    const result = await ctx.tools.invoke("read", { path: "manifest.json" });
    // The core API resolves tool errors with isError (unlike the JS bridge).
    return { content: result.content, details: {} };
  },
});
```

`ctx.tools` exists only inside an opted-in execute invocation, not commands or
hooks. Captured invokers expire when that invocation settles; invalidated extension
runtimes reject stale use. Cancellation signals are invocation-specific in execute,
`tool_call`, and `tool_result` hooks.

Dispatch shares the direct pipeline: argument preparation, schema validation,
mutable/blocking tool-call hooks, registered execution, result hooks, image
normalization, and start/update/end events. Nested preflight hooks run in request
order. Activation revocation is checked before and after hooks. Registrations and
schemas use the current turn's snapshot; newly introduced tools are for later
turns, not silent schema changes within a cell.

Nested events/hooks carry `parentToolCallId`; completion events also carry
`effectiveArgs`. Child usage is aggregated into the outer result once. Child
termination closes further dispatch and propagates the termination hint to the
outer batch (normal all-results-terminating semantics still apply).

Default Code Mode names are `read,bash,edit,write,grep,find,ls,powershell`, intersected
with active tools. Override the allowlist explicitly **before startup** with:

```bash
PI_CODE_MODE_TOOLS=read,bash,edit,write,apply_patch /path/to/pi-nested
```

This is not a blanket compatibility certification for `apply_patch` or any other
extension. In particular, workpads/stateful tools may reconstruct state from
ordinary `toolResult` messages. Nested calls are not those messages: adapt and test
their reconstruction before opting them in. Blocking questions, session changes,
and background-job orchestration are intentionally left direct initially.

## Traces and provider context

Core persists nested start/end records as `pi.nested-tool.v1` **custom entries**, not
unmatched tool-result messages. Each arguments/result snapshot is capped at 64 KiB;
oversized snapshots contain an explicit byte count and preview. Unserializable
values are marked unavailable. No raw-output promise beyond the tool's own output
and these trace limits is made.

Live nested tools use ordinary execution rows. On resume/reload, the extension
renders bounded custom records; expanded completion rows show details. A start
without a matching completion means **unknown outcome**, not safe-to-replay work.
Custom records survive session export/open and remain in branch history through
compaction, but they are not all fed to the compaction model. Print useful summaries
of changes needed by later reasoning; the trace remains available in JSONL.

The provider receives only the outer result, selected output, and an automatic
summary of child failures/unfinished calls. It does not receive all child outputs
or fabricated assistant calls. Tool schemas and guidelines remain fixed during
ordinary turns. Explicit activation changes are honest configuration changes, not
a claim of unchanged cache prefixes.

Tests project real OpenAI Responses/Codex and Anthropic payloads without sending
requests. OpenAI prefixes are checked exactly across follow-ups, ordinary turns,
retry, and unchanged reload. Anthropic's existing adapter moves `cache_control`
markers to trailing content: raw payload prefixes are **not byte-identical** there.
Tests explicitly check that exception and compare content excluding only those
markers. These checks do not prove a live provider cache-hit rate or Astra
round-trip savings; live A/B evaluation is still pending.
