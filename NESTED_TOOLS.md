# Local nested-tools fork

Baseline: upstream `earendil-works/pi` commit
`842c73170` (2026-10-27, after v1.4.0). Development branch: `nested-tools`.
The installed Pi is not replaced. This is a local prototype, not a published release.

Upstream's built-in sandboxed `codemode` and MCP integration coexist with this
fork's trusted Node `exec` tool. Opted-in tools receive the fork's scoped invoker
as `ctx.nestedTools`; `ctx.tools` retains upstream's tool-definition list.

## Entry point

```bash
/path/to/pi-mono/pi-nested
```

Run from the project you want to work on. By default it uses the normal Pi
profile, `~/.pi/agent`, so its provider authentication, installed Generalist
package, theme, and other settings apply. Set `PI_CODING_AGENT_DIR` explicitly
before launching to use an isolated or alternate profile. See the [Code Mode
guide](packages/coding-agent/examples/extensions/code-mode/README.md) for usage,
profile overrides, extension opt-ins, and trust/cancellation limits.

## Prepare/build

Use the repository's supported Node version. Workspace source imports include
public package exports, so compile the workspace dependencies before integration
tests or general use:

```bash
npm ci --ignore-scripts
npm run build:offline
npm run check
```

The offline build requires generated model catalog data in
`packages/ai/src/providers/data`. Provision it with `npm run hydrate:model-data`
(which fetches public catalogs), then validate with `npm run check:model-data`.
The generated data and build products remain ignored, not source changes.
`build:offline` does not fetch missing data.

## Layout

- `packages/agent/src/tool-execution.ts`: shared direct/nested preparation,
  validation, hooks, execution and finalization, extracted from `agent-loop.ts`.
- `packages/agent/src/nested-tools.ts`: scoped scheduling, limits, cancellation,
  usage/termination aggregation, and host-generated outcome summaries.
- `packages/coding-agent/src/core/nested-tool-record.ts`: bounded custom trace entries.
- `packages/coding-agent/src/core/extensions`: explicit opt-in API and runtime guards.
- `packages/coding-agent/examples/extensions/code-mode`: disposable trusted Node runtime.
- `pi-nested`: separate source launcher, cwd-preserving and using the normal Pi profile by default.

## Offline verification

Targeted suites use synthetic fixtures/faux responses. Provider-projection tests
invoke serialization with fake keys and abort at `onPayload`, before transport;
there are no live model calls. Do not infer live cache hits or speedup measurements.

Use a scrubbed environment for tests: an upstream failure assertion can otherwise
print inherited shell variables, including credentials.

```bash
cd packages/agent
env -i PATH="$PATH" HOME="$HOME" PI_OFFLINE=1 node ../../node_modules/vitest/dist/cli.js --run test/agent-loop.test.ts test/agent.test.ts
cd ../coding-agent
env -i PATH="$PATH" HOME="$HOME" PI_OFFLINE=1 node ../../node_modules/vitest/dist/cli.js --run test/code-mode-runtime.test.ts test/code-mode-projection.test.ts test/suite/nested-tools.test.ts test/agent-session-dynamic-tools.test.ts test/suite/agent-session-runtime.test.ts test/suite/agent-session-tool-result-images.test.ts test/suite/agent-session-retry-events.test.ts
```

The local verification also starts `pi-nested --mode rpc --no-session` from a
fresh temporary directory/home, requests state/commands, and checks Code Mode
registration without authentication or model calls. No global installation,
GitHub remote creation, publishing, or mutation replay is part of that smoke test.

Compaction and explicit activation changes are lifecycle boundaries, not promises
of unchanged provider prefixes. Stateful generalist extensions need separate
nested-restoration audits before opting them into Code Mode.
