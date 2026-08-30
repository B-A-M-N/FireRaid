/**
 * LLM model abstraction — OpenAI-compatible chat completions.
 * FIRERAID_LLM_BASE_URL, FIRERAID_LLM_API_KEY, FIRERAID_LLM_MODEL
 * FIX: Accept temperature and max_tokens from manifest (FR-R3-038).
 * FIX: Use AbortController for network timeout (FR-R3-037).
 */

export interface LlmConfig {
  temperature?: number;
  maxTokens?: number;
}

export async function callLlm(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  config: LlmConfig = {},
  timeoutMs: number = 30000
): Promise<string> {
  const baseUrl = process.env.FIRERAID_LLM_BASE_URL;
  const apiKey = process.env.FIRERAID_LLM_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new Error("LLM not configured — set FIRERAID_LLM_BASE_URL and FIRERAID_LLM_API_KEY");
  }

  const temperature = config.temperature ?? 0.2;
  const maxTokens = config.maxTokens ?? 512;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
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
    const json = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return json.choices[0]?.message?.content ?? "";
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("MODEL_TIMEOUT");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
