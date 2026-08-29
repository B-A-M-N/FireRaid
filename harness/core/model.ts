/**
 * LLM model abstraction — OpenAI-compatible chat completions.
 * FIRERAID_LLM_BASE_URL, FIRERAID_LLM_API_KEY, FIRERAID_LLM_MODEL
 */
export async function callLlm(
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const baseUrl = process.env.FIRERAID_LLM_BASE_URL;
  const apiKey = process.env.FIRERAID_LLM_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new Error("LLM not configured — set FIRERAID_LLM_BASE_URL and FIRERAID_LLM_API_KEY");
  }

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
      temperature: 0.2,
      max_tokens: 512,
    }),
  });

  if (!resp.ok) throw new Error(`LLM error: ${resp.status}`);
  const json = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
  return json.choices[0]?.message?.content ?? "";
}
