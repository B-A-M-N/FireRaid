/**
 * Action validator — strict schema for raw-DOM agent.
 * Allowed: navigate, click, fill, select, check, submit, stop, handoff, request.
 * FR-R3-032: Added constrained request action for canary routes.
 */
export interface AgentAction {
  action: "navigate" | "click" | "fill" | "select" | "check" | "submit" | "stop" | "handoff" | "request";
  target?: string;
  value?: string;
}

const ALLOWED_ACTIONS = new Set(["navigate", "click", "fill", "select", "check", "submit", "stop", "handoff", "request"]);

export function validateAction(raw: string): AgentAction {
  // Try to extract JSON from the response. Prefer the whole reply; else the
  // FIRST balanced {...} block. (A greedy first-to-last match breaks on
  // models that batch several action objects in one reply — the concatenated
  // blob is not valid JSON and the single-action protocol wants the first
  // action anyway.)
  let jsonStr = raw;
  const start = raw.indexOf("{");
  if (start === -1) throw new Error("LLM response is not valid JSON");
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) throw new Error("LLM response is not valid JSON");
  jsonStr = raw.slice(start, end);

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
