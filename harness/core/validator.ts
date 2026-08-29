/**
 * Action validator — strict schema for raw-DOM agent.
 * Allowed: navigate, click, fill, select, check, submit, stop, handoff.
 */
export interface AgentAction {
  action: "navigate" | "click" | "fill" | "select" | "check" | "submit" | "stop" | "handoff";
  target?: string;
  value?: string;
}

const ALLOWED_ACTIONS = new Set(["navigate", "click", "fill", "select", "check", "submit", "stop", "handoff"]);

export function validateAction(raw: string): AgentAction {
  // Try to extract JSON from the response
  let jsonStr = raw;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) jsonStr = jsonMatch[0];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error("LLM response is not valid JSON");
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.action !== "string" || !ALLOWED_ACTIONS.has(obj.action)) {
    throw new Error(`Invalid action: ${obj.action}`);
  }

  return {
    action: obj.action as AgentAction["action"],
    target: typeof obj.target === "string" ? obj.target.slice(0, 128) : undefined,
    value: typeof obj.value === "string" ? obj.value.slice(0, 256) : undefined,
  };
}
