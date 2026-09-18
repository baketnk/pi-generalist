import { calculateCost } from "../models.ts";
import type { Api, Context, Model, OpenAICompaction, ProviderEnv, SimpleStreamOptions, Usage } from "../types.ts";
import { combineAbortSignals } from "../utils/abort-signals.ts";
import { headersToRecord } from "../utils/headers.ts";
import { assertCompactedOutput } from "../utils/openai-compaction.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { buildCompactionRequest as buildCodexCompactionRequest } from "./openai-codex-responses.ts";
import { buildCompactionRequest as buildResponsesCompactionRequest } from "./openai-responses.ts";

export const DEFAULT_OPENAI_COMPACTION_TIMEOUT_MS = 300_000;

/** Native compaction is first-party only; compatible gateways keep their existing text policy. */
export function supportsNativeOpenAICompaction(model: Model<Api>, env?: ProviderEnv): boolean {
	if (getProviderEnvValue("PI_OPENAI_COMPACTION", env) === "off") return false;
	let url: URL;
	try {
		url = new URL(model.baseUrl);
	} catch {
		return false;
	}
	if (url.protocol !== "https:") return false;
	return (
		(model.api === "openai-responses" && model.provider === "openai" && url.hostname === "api.openai.com") ||
		(model.api === "openai-codex-responses" && model.provider === "openai-codex" && url.hostname === "chatgpt.com")
	);
}

/** Native provider compaction: standalone JSON for OpenAI, streamed Responses v2 for Codex. */
export async function compactOpenAI(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions = {},
): Promise<{ compaction: OpenAICompaction; usage?: Usage }> {
	if (model.api !== "openai-responses" && model.api !== "openai-codex-responses")
		throw new Error("Unsupported compaction API");
	const configured = getProviderEnvValue("PI_OPENAI_COMPACTION_TIMEOUT_MS", options.env);
	const timeoutMs =
		options.timeoutMs ?? (configured === undefined ? DEFAULT_OPENAI_COMPACTION_TIMEOUT_MS : Number(configured));
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
		throw new Error("PI_OPENAI_COMPACTION_TIMEOUT_MS must be a positive integer (milliseconds)");
	}
	// Compaction can legitimately be silent for several minutes. Never borrow the
	// streaming idle timeout or WebSocket handshake timeout for compaction.
	const timeout = new AbortController();
	const timer = setTimeout(
		() => timeout.abort(new Error(`OpenAI compaction timed out after ${timeoutMs}ms`)),
		timeoutMs,
	);
	const combined = combineAbortSignals([options.signal, timeout.signal]);
	try {
		combined.signal?.throwIfAborted();
		const request =
			model.api === "openai-codex-responses"
				? await buildCodexCompactionRequest(model as Model<"openai-codex-responses">, context, options)
				: await buildResponsesCompactionRequest(model as Model<"openai-responses">, context, options);
		combined.signal?.throwIfAborted();
		// No automatic replay of a potentially completed, billable compaction. A
		// failure leaves the journal untouched and can be retried explicitly.
		const response = await (options.fetch ?? globalThis.fetch)(request.url, {
			method: "POST",
			headers: request.headers,
			body: JSON.stringify(request.body),
			signal: combined.signal,
		});
		request.onResponse?.(response);
		await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
		if (!response.ok) {
			const detail = (await response.text()).trim().slice(0, 1000);
			throw new Error(
				`OpenAI native compaction failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}; history is unchanged. PI_OPENAI_COMPACTION=off selects text compaction explicitly.`,
			);
		}
		const data: unknown =
			"readResponse" in request ? await request.readResponse(response, combined.signal) : await response.json();
		combined.signal?.throwIfAborted();
		if (!data || typeof data !== "object" || !("output" in data))
			throw new Error("Invalid OpenAI compaction response");
		if (("error" in data && data.error) || ("status" in data && data.status !== "completed")) {
			throw new Error("OpenAI compaction did not complete; conversation was not replaced");
		}
		assertCompactedOutput(data.output);
		let usage: Usage | undefined;
		if ("usage" in data && data.usage && typeof data.usage === "object") {
			const raw = data.usage as Record<string, unknown>;
			const input = raw.input_tokens,
				output = raw.output_tokens;
			const details =
				raw.input_tokens_details && typeof raw.input_tokens_details === "object"
					? (raw.input_tokens_details as Record<string, unknown>)
					: undefined;
			const cached = details?.cached_tokens ?? 0;
			const written = details?.cache_write_tokens ?? 0;
			if (
				typeof input === "number" &&
				Number.isSafeInteger(input) &&
				input >= 0 &&
				typeof output === "number" &&
				Number.isSafeInteger(output) &&
				output >= 0 &&
				typeof cached === "number" &&
				Number.isSafeInteger(cached) &&
				cached >= 0 &&
				typeof written === "number" &&
				Number.isSafeInteger(written) &&
				written >= 0 &&
				cached + written <= input
			) {
				usage = {
					input: input - cached - written,
					output,
					cacheRead: cached,
					cacheWrite: written,
					totalTokens: input + output,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
				calculateCost(model, usage);
			}
		}
		return {
			compaction: {
				api: model.api as OpenAICompaction["api"],
				provider: model.provider,
				model: model.id,
				baseUrl: model.baseUrl,
				output: data.output,
				...(usage ? { outputTokens: usage.output } : {}),
			},
			usage,
		};
	} catch (error) {
		combined.signal?.throwIfAborted();
		throw error;
	} finally {
		clearTimeout(timer);
		combined.cleanup();
	}
}
