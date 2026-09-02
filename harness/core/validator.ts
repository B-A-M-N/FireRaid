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

/**
 * P2-ATTACKS: common tool-vocabulary aliases free models emit from their
 * training (browser-use / MCP verb names) mapped onto the protocol action.
 * The intent is unambiguous; losing a trial to verb-guessing would measure
 * the harness, not the defense. The raw reply always remains in the
 * transcript, so the vocabulary mismatch stays visible evidence.
 */
const ACTION_ALIASES: Record<string, AgentAction["action"]> = {
  browser_navigate: "navigate",
  browser_click: "click",
  browser_fill: "fill",
  browser_type: "fill",
  browser_select: "select",
  browser_check: "check",
  go_to: "navigate",
  goto: "navigate",
  type: "fill",
  write: "fill",
};

/** Canonicalize an action name or null when it is neither allowed nor aliased. */
function canonicalAction(name: string): AgentAction["action"] | null {
  const lower = name.toLowerCase();
  if (ALLOWED_ACTIONS.has(lower)) return lower as AgentAction["action"];
  return ACTION_ALIASES[lower] ?? null;
}

export function validateAction(raw: string): AgentAction {
  // P2-ATTACKS: several free-tier models answer in a tool-call XML dialect
  // (<invoke name="..."><parameter name="target">...) or with bare
  // action-named parameter blocks instead of the JSON protocol. Extract
  // the FIRST such block into the JSON shape before the JSON scan — an
  // action lost to formatting is a measurement defect, not a finding (the
  // finding is what the attacker DID).
  const xmlAction = tryParseToolCallXml(raw);
  if (xmlAction) return xmlAction;

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
  // P2-ATTACKS: {"name":"fill","input":{...}} is the same action in the
  // <tool_use> envelope's vocabulary — normalize it onto action/target/value
  // before canonicalization.
  if (typeof obj.action !== "string" && typeof obj.name === "string" && obj.input && typeof obj.input === "object") {
    const input = obj.input as Record<string, unknown>;
    obj.action = obj.name;
    if (obj.target === undefined) {
      obj.target = [input.target, input.url, input.path].find((v) => typeof v === "string");
    }
    if (obj.value === undefined) {
      obj.value = [input.value, input.text].find((v) => typeof v === "string");
    }
  }
  // P2-ATTACKS: the JSON path canonicalizes through the same alias table —
  // a model that emits {"action":"browser_type"} means "fill".
  const canonicalJson = typeof obj.action === "string" ? canonicalAction(obj.action) : null;
  if (!canonicalJson) {
    throw new Error(`Invalid action: ${obj.action}`);
  }

  return {
    action: canonicalJson,
    target: typeof obj.target === "string" ? obj.target.slice(0, 128) : undefined,
    value: typeof obj.value === "string" ? obj.value.slice(0, 256) : undefined,
  };
}

/**
 * P2-ATTACKS: recognize the common tool-call XML dialects free models
 * emit despite the JSON protocol instruction. Returns null when the reply
 * carries no recognizable action block (caller falls through to the JSON
 * path and its error taxonomy).
 *
 * Handles:
 *   <invoke name="fill"><parameter name="target">node-001</parameter>...
 *   <function_calls><invoke name="fill">...
 *   <fill><target>node-001</target>...            (bare action tag)
 * Accepts an action only when its name is in ALLOWED_ACTIONS; parameter
 * spellings target/url/path/value/text are all honored.
 */
function tryParseToolCallXml(raw: string): AgentAction | null {
  // Canonical shapes: <invoke name="ACTION"> ... </invoke> (possibly inside
  // <function_calls> or <mcp-tool> wrappers).
  const invoke = raw.match(/<invoke\s+name=["']([a-zA-Z_-]+)["']\s*>([\s\S]*?)<\/invoke>/);
  if (invoke) {
    const action = invoke[1].toLowerCase();
    const body = invoke[2];
    const canonical = canonicalAction(action);
    if (!canonical) return null;
    const param = (name: string): string | undefined => {
      const m = body.match(
        new RegExp(`<parameter\\s+name=["']${name}["']\\s*>([\\s\\S]*?)</parameter>`)
      );
      return m ? m[1].trim().slice(0, 256) : undefined;
    };
    return {
      action: canonical,
      target: param("target") ?? param("url") ?? param("path"),
      value: param("value") ?? param("text"),
    };
  }
  // Bare action-tag shape: <fill><target>...</target><value>...</value></fill>
  // (target spelling may be target/url/path; value spelling value/text).
  const bare = raw.match(
    /<([a-zA-Z_-]+)>\s*<(target|url|path)>([\s\S]*?)<\/\2>/
  );
  const bareCanonical = bare ? canonicalAction(bare[1]) : null;
  if (bare && bareCanonical) {
    const value = raw.match(new RegExp(`<(value|text)>([\\s\\S]*?)</\\1>`));
    return {
      action: bareCanonical,
      target: bare[3].trim().slice(0, 128),
      value: value ? value[2].trim().slice(0, 256) : undefined,
    };
  }
  // <tool_name>ACTION</tool_name><arguments>{"k":...}</arguments> — the
  // MCP-ish dialect; the JSON arguments object maps url/path→target,
  // text/value→value.
  const toolName = raw.match(/<tool_name>\s*([a-zA-Z_-]+)\s*<\/tool_name>/);
  const toolCanonical = toolName ? canonicalAction(toolName[1]) : null;
  if (toolName && toolCanonical) {
    const args = raw.match(/<arguments>\s*(\{[\s\S]*?\})\s*<\/arguments>/);
    if (args) {
      try {
        const o = JSON.parse(args[1]) as Record<string, unknown>;
        const target = [o.target, o.url, o.path].find((v) => typeof v === "string") as string | undefined;
        const value = [o.value, o.text].find((v) => typeof v === "string") as string | undefined;
        return {
          action: toolCanonical,
          target: target?.slice(0, 128),
          value: value?.slice(0, 256),
        };
      } catch {
        // Malformed arguments blob → fall through to JSON path / error.
      }
    }
  }
  // <function=ACTION><parameter=KEY>VALUE</parameter></function> — equals-
  // sign parameter form (observed live from :free models).
  const fnEq = raw.match(/<function=([a-zA-Z_-]+)>([\s\S]*?)<\/function>/);
  const fnCanonical = fnEq ? canonicalAction(fnEq[1]) : null;
  if (fnEq && fnCanonical) {
    const param = (name: string): string | undefined => {
      const m = fnEq[2].match(new RegExp(`<parameter=${name}>([\\s\\S]*?)</parameter>`));
      return m ? m[1].trim().slice(0, 256) : undefined;
    };
    return {
      action: fnCanonical,
      target: param("target") ?? param("url") ?? param("path"),
      value: param("value") ?? param("text"),
    };
  }
  // <function name="ACTION">…</function> — attribute-named function tag,
  // seen namespaced (<seed:tool_call><function name="fill">…). Parameters
  // use either name= attributes or the equals form.
  const fnAttr = raw.match(/<function\s+name=["']([a-zA-Z_-]+)["']\s*>([\s\S]*?)<\/function>/);
  const fnAttrCanonical = fnAttr ? canonicalAction(fnAttr[1]) : null;
  if (fnAttr && fnAttrCanonical) {
    const body = fnAttr[2];
    const param = (name: string): string | undefined => {
      const named = body.match(new RegExp(`<parameter\\s+name=["']${name}["'][^>]*>([\\s\\S]*?)</parameter>`));
      if (named) return named[1].trim().slice(0, 256);
      const eq = body.match(new RegExp(`<parameter=${name}>([\\s\\S]*?)</parameter>`));
      return eq ? eq[1].trim().slice(0, 256) : undefined;
    };
    return {
      action: fnAttrCanonical,
      target: param("target") ?? param("url") ?? param("path"),
      value: param("value") ?? param("text"),
    };
  }
  return null;
}
