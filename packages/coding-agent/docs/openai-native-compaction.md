# Native OpenAI compaction (local fork)

Manual `/compact` and automatic threshold/overflow compaction use native provider
compaction. Direct OpenAI Responses uses the standalone `/responses/compact`
route. ChatGPT Codex uses remote compaction v2: a normal streamed `/codex/responses`
request with a final `compaction_trigger` input item. Codex requests advertise
`remote_compaction_v2`, including subsequent requests that replay the checkpoint.
The request names the active model and carries its usual instructions and tools;
it does not ask for a prose summary. Branch-navigation summaries are unchanged.

## Configuration

- Default request timeout: **300,000 ms (five minutes)**, covering response headers
  and the complete JSON body or compaction stream. Silent 90+ second compactions
  are allowed. This does not inherit normal streaming idle or WebSocket connection
  timeouts.
- `PI_OPENAI_COMPACTION_TIMEOUT_MS=600000` sets a ten-minute compaction deadline.
  Positive integer milliseconds are required. Low-level `compactOpenAI()` callers
  can instead pass `timeoutMs`.
- Cancellation interrupts the request immediately.
- `PI_OPENAI_COMPACTION=off` explicitly selects pi's existing text compaction.
  Other providers and compatible gateways keep that text policy by default.

The service must support compaction for the selected model. Unsupported routes,
timeouts, malformed output and cancellation leave the previous conversation in
place. There is no automatic text-generation fallback or replay of a potentially
completed compaction. Retry explicitly. Input must fit the service's context
window; overflow is not permission to silently discard history until it fits.

## Persistence and caching

For direct OpenAI, the entire returned output window is persisted in the compaction
entry's `details.openaiCompaction`. Codex v2 must complete its stream with exactly
one valid encrypted compaction item. Its replacement window contains recent durable
user messages (a 64,000-token approximate text budget, selected newest first and
replayed chronologically) followed by that unchanged item. Images in retained
messages are preserved. The trigger, previous
encrypted checkpoint, assistant messages, and tool results are not retained as
separate items in the new window. Original messages remain in the journal.

Every retained item and the encrypted compaction item
are replayed together, unchanged. The old local tail is not appended a second
time. Ordinary turns, tool continuations and retries append after this window.
Compaction itself is an intentional cache-prefix reset, not a claim of preserving
the pre-compaction cache.

The original append-only journal remains intact. Reload rebuilds the same native
window. A different model, provider or endpoint uses transparent history from the
journal instead of incompatible encrypted state; that can enlarge context again.
Text compaction after such a switch summarizes real history, not the native
checkpoint's UI label. Older pi versions without this fork's replay support must
not continue a native-compacted session: use this fork, or branch before the native
checkpoint first. The newer experimental lane/session backend is not wired to this
coding-agent compaction path.

Revocable extension context snapshots are **not** passed through context hooks
into the compactor. They reattach separately after the committed boundary. This
does not erase information already disclosed in actual conversation/tool messages.
Source revocation and activation changes remain explicit lifecycle changes.

Codex requests retain logical turn identity across continuations and retries.
Native compaction has its own `request_kind: compaction`; it does not displace the
foreground turn's routing token. Successful checkpoints produce a distinct
`context_window_id`, `window_id`, and `window_number`; failures do not. Window UUIDs
are derived from thread and checkpoint identity, so reloads are stable and sibling
branches/forked sessions do not collide. Optional installation identity is accepted
from callers; no new persistent machine identifier is created.

Usage is recorded when the endpoint returns it. Missing usage is not fabricated.
The post-compaction size is an estimate until a normal model response reports
actual context usage. These changes do not establish subscription-quota parity
or guarantee a particular cache-hit rate.

See [OpenAI's standalone compaction guide](https://developers.openai.com/api/docs/guides/compaction).
The Codex v2 protocol follows upstream Codex's `compact_remote_v2` implementation;
`@ogulcancelik/pi-codex-compaction` was also reviewed as a reference. No extension
installation or new dependency is required. Existing checkpoints replay through
the same serializer, and WebSocket continuation resumes after the new window has
established its own cache prefix.
The identity/routing implementation selectively incorporates upstream
[PR #9488](https://github.com/earendil-works/pi/pull/9488), with checkpoint-derived
context-window identity added locally. Proxy attribution and branch-summary
policy changes from that PR were not imported.
