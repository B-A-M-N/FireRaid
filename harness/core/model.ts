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
  const maxTokens = config.maxTokens ?? 512;

  const endpoint = `${normalizeBaseUrl(baseUrl)}/chat/completions`;

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
}
