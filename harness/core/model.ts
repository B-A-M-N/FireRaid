/**
 * LLM model abstraction — OpenAI-compatible chat completions.
 * FIRERAID_LLM_BASE_URL, FIRERAID_LLM_API_KEY, FIRERAID_LLM_MODEL
 * FIX: Accept temperature and max_tokens from manifest (FR-R3-038).
 * FIX: Use AbortController for network timeout (FR-R3-037).
 * FR-P0-9: callLlm returns { content, provenance } — the runner records what
 *   was REQUESTED (model id, temperature, max_tokens) alongside what the
 *   provider actually SERVED (`model` + `provider` in the response). An
 *   OpenRouter-style router may alias the requested id to a different
 *   backend; only the served id is honest provenance.
 * FR-P0-10: base URL path normalization — a configured base of
 *   "https://host" AND "https://host/v1" both yield ".../v1/chat/completions"
 *   (a bare "/chat/completions" append on an already-versioned base is the
 *   classic 404).
 * FR-P0-11: harness/.env is loaded here (attack-plane credentials live ONLY
 *   in the harness; src/ never sees them). dotenv-default semantics: real
 *   environment wins over .env, so CI-injected secrets are never shadowed by
 *   a stale file.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface LlmConfig {
  temperature?: number;
  maxTokens?: number;
}

/** FR-P0-9: requested-vs-served record of one completion call. */
export interface LlmProvenance {
  /** URL the request was POSTed to (post-normalization). */
  endpoint: string;
  /** Model id we asked for (scenario/manifest value). */
  modelRequested: string;
  /** Model id the provider says it served. */
  modelServed?: string;
  /** Upstream provider host the router picked (OpenRouter `provider`). */
  providerOrigin?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LlmResult {
  content: string;
  provenance: LlmProvenance;
}

/**
 * FR-P0-11: parse harness/.env into the environment without clobbering real
 * env vars (dotenv default semantics: existing process.env wins). Called
 * once per process; missing file is a no-op.
 */
let envLoaded = false;
export function loadHarnessEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  const path = join(process.cwd(), "harness", ".env");
  if (!existsSync(path)) return;
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key in process.env) continue; // real environment wins
    process.env[key] = value;
  }
}

/**
 * FR-P0-10: normalize a configured base URL to "<scheme>/<host>/v1".
 * Accepts "https://host", "https://host/", "https://host/v1", "https://host/v1/".
 */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/** Retryable free-tier transport failures (availability, not our bug). */
function isTransientLlmError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // HTTP 408/429/5xx from the router; timeouts; empty-router responses.
  const status = err.message.match(/^LLM error: (\d{3})$/);
  if (status) return ["408", "429", "500", "502", "503", "504"].includes(status[1]);
  return err.message === "MODEL_TIMEOUT" || err.message === "LLM_EMPTY_REPLY";
}

/**
 * P1-AUDIT-2 Phase F: bounded retry for FREE-TIER transport flakiness —
 * routers rate-limit (429) and providers shed load (5xx) between rounds.
 * Fixed short backoff keeps a smoke step under its timeout; MODEL_TIMEOUT
 * retries only when the backoff budget allows. A call that exhausts retries
 * throws the LAST error — the adapter's fail-closed mapping is unchanged.
 * Retries re-execute the ENTIRE attempt (fresh timeout, same payload), and
 * provenance always reflects the attempt that actually succeeded.
 */
const LLM_RETRY_DELAYS_MS = [1500, 4000, 9000];
async function withTransportRetry<T>(attempt: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= LLM_RETRY_DELAYS_MS.length; i++) {
    if (i > 0) {
      const delay = LLM_RETRY_DELAYS_MS[i - 1];
      console.warn(`[llm] transient failure (${String(lastErr).slice(0, 80)}); retry ${i}/${LLM_RETRY_DELAYS_MS.length} in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
      if (!isTransientLlmError(err)) throw err;
    }
  }
  throw lastErr;
}

export async function callLlm(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  config: LlmConfig = {},
  timeoutMs: number = 30000
): Promise<LlmResult> {
  loadHarnessEnv();

  const baseUrl = process.env.FIRERAID_LLM_BASE_URL;
  const apiKey = process.env.FIRERAID_LLM_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new Error("LLM not configured — set FIRERAID_LLM_BASE_URL and FIRERAID_LLM_API_KEY");
  }

  const temperature = config.temperature ?? 0.2;
  // Headroom above bare-JSON needs: free-tier models (e.g. reasoning
  // variants) spend budget on invisible reasoning BEFORE content — a 512
  // cap routinely yields an empty reply for a one-line action.
  const maxTokens = config.maxTokens ?? 1024;

  const endpoint = `${normalizeBaseUrl(baseUrl)}/chat/completions`;

  return withTransportRetry(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature,
          max_tokens: maxTokens,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) throw new Error(`LLM error: ${resp.status}`);
      const json = (await resp.json()) as {
        model?: string;
        provider?: string;
        choices: Array<{ message: { content: string | null } }>;
      };
      const content = json.choices[0]?.message?.content ?? "";
      if (!content.trim()) {
        // HTTP-200 with empty content: reasoning variants exhaust their
        // token budget on invisible reasoning. Retryable availability
        // failure — NOT a valid reply.
        throw new Error("LLM_EMPTY_REPLY");
      }
      return {
        content,
        provenance: {
          endpoint,
          modelRequested: model,
          modelServed: json.model,
          providerOrigin: json.provider,
          temperature,
          maxTokens,
        },
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error("MODEL_TIMEOUT");
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  });
}

/**
 * P1-AUDIT-2 Phase F — multimodal completion for the vision-only adapter.
 * Identical config/env/timeout/provenance semantics to callLlm(), with one
 * image (data: URL) embedded as an OpenAI-compatible image_url content part
 * in the user message. Text and image ride the SAME user turn so the
 * screenshot is contextualized by the prompt text.
 */
export async function callLlmVision(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  imageDataUrl: string,
  config: LlmConfig = {},
  timeoutMs: number = 45000
): Promise<LlmResult> {
  loadHarnessEnv();

  const baseUrl = process.env.FIRERAID_LLM_BASE_URL;
  const apiKey = process.env.FIRERAID_LLM_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new Error("LLM not configured — set FIRERAID_LLM_BASE_URL and FIRERAID_LLM_API_KEY");
  }

  const temperature = config.temperature ?? 0.2;
  // Vision payloads are large; default headroom above the text-only floor —
  // reasoning variants burn invisible tokens before the visible content.
  const maxTokens = config.maxTokens ?? 2048;

  const endpoint = `${normalizeBaseUrl(baseUrl)}/chat/completions`;

  return withTransportRetry(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: [
                { type: "text", text: userPrompt },
                { type: "image_url", image_url: { url: imageDataUrl } },
              ],
            },
          ],
          temperature,
          max_tokens: maxTokens,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) throw new Error(`LLM error: ${resp.status}`);
      const json = (await resp.json()) as {
        model?: string;
        provider?: string;
        choices: Array<{ message: { content: string | null } }>;
      };
      const content = json.choices[0]?.message?.content ?? "";
      if (!content.trim()) {
        // HTTP-200 with empty content: reasoning variants exhaust their
        // token budget on invisible reasoning. Retryable availability
        // failure — NOT a valid reply.
        throw new Error("LLM_EMPTY_REPLY");
      }
      return {
        content,
        provenance: {
          endpoint,
          modelRequested: model,
          modelServed: json.model,
          providerOrigin: json.provider,
          temperature,
          maxTokens,
        },
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error("MODEL_TIMEOUT");
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  });
}
