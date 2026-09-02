/**
 * P2-ATTACKS: action-validator protocol tests.
 *
 * The wire protocol is JSON, but free-tier models frequently answer in
 * tool-call XML dialects (<invoke name=...>, bare action tags). Since
 * P2-ATTACKS the validator recognizes those dialects BEFORE the JSON scan:
 * an action lost to formatting is a measurement defect, not a finding.
 * These tests pin both paths — including the cases that must STILL fail
 * (unknown actions smuggled through XML, prose without any action).
 */
import { describe, it, expect } from "vitest";
import { validateAction } from "../../harness/core/validator.js";

describe("action validator (P2-ATTACKS protocol)", () => {
  // ── JSON protocol (the contract) ────────────────────────────────────────
  it("parses a clean JSON action", () => {
    expect(validateAction('{"action":"fill","target":"node-001","value":"x"}')).toEqual({
      action: "fill", target: "node-001", value: "x",
    });
  });

  it("parses JSON embedded in prose (first balanced object)", () => {
    expect(
      validateAction('Sure! Here is my next step:\n{"action":"click","target":"node-002"}\nThanks!')
    ).toEqual({ action: "click", target: "node-002", value: undefined });
  });

  // ── tool-call XML dialects (free-model reality) ─────────────────────────
  it("parses <invoke name=...> with <parameter> children", () => {
    const raw = `<invoke name="fill">
<parameter name="target">node-003</parameter>
<parameter name="value">Priya Testington</parameter>
</invoke>`;
    expect(validateAction(raw)).toEqual({
      action: "fill", target: "node-003", value: "Priya Testington",
    });
  });

  it("parses <function_calls>-wrapped invoke blocks", () => {
    const raw = `<function_calls>
<invoke name="navigate">
<parameter name="url">/signup</parameter>
</invoke>
</function_calls>`;
    expect(validateAction(raw)).toEqual({
      action: "navigate", target: "/signup", value: undefined,
    });
  });

  it("parses bare action-tag shapes", () => {
    expect(validateAction(`<submit><target>node-009</target></submit>`)).toEqual({
      action: "submit", target: "node-009", value: undefined,
    });
  });

  it("honors alternate parameter spellings (url/path/text)", () => {
    expect(validateAction(`<request><path>/c/abc123</path></request>`)).toEqual({
      action: "request", target: "/c/abc123", value: undefined,
    });
    expect(validateAction(`<fill><target>n1</target><text>hello</text></fill>`)).toEqual({
      action: "fill", target: "n1", value: "hello",
    });
  });

  it("parses the <tool_name>+<arguments>{json}> dialect", () => {
    const raw = `<tool_name>navigate</tool_name>
<arguments>
{"url": "/c/"}
</arguments>`;
    expect(validateAction(raw)).toEqual({
      action: "navigate", target: "/c/", value: undefined,
    });
  });

  it("parses the <function=ACTION><parameter=KEY> equals-form dialect", () => {
    // browser-use verb vocabulary maps onto the protocol action (the raw
    // reply stays in the transcript as evidence of the mismatch).
    expect(
      validateAction(`<function=browser_navigate><parameter=url>https://acme-research.example/register</parameter></function>`)
    ).toEqual({ action: "navigate", target: "https://acme-research.example/register", value: undefined });
    // The legal spelling parses identically.
    expect(
      validateAction(`<function=navigate><parameter=url>/register</parameter></function>`)
    ).toEqual({ action: "navigate", target: "/register", value: undefined });
  });

  it("maps browser-use verb aliases (browser_fill/type/go_to)", () => {
    // JSON path canonicalizes through the same alias table.
    expect(validateAction(`{"action":"browser_fill","target":"n1","value":"v"}`))
      .toEqual({ action: "fill", target: "n1", value: "v" });
    expect(validateAction(`<invoke name="browser_fill"><parameter name="target">n1</parameter><parameter name="value">v</parameter></invoke>`))
      .toEqual({ action: "fill", target: "n1", value: "v" });
    expect(validateAction(`<go_to><url>/x</url></go_to>`)).toEqual({ action: "navigate", target: "/x", value: undefined });
  });

  it("parses the <tool_use>{name,input}</tool_use> envelope", () => {
    const raw = `<tool_use>
{"name": "browser_navigate", "input": {"url": "https://example.com/c/verify"}}
</tool_use>`;
    expect(validateAction(raw)).toEqual({
      action: "navigate", target: "https://example.com/c/verify", value: undefined,
    });
  });

  it("parses namespaced <function name=...> tags (seed:tool_call dialect)", () => {
    const raw = `<seed:tool_call><function name="fill"><parameter name="target" string="true">node-000</parameter><parameter name="value" string="true">Priya Testington</parameter></function></seed:tool_call>`;
    expect(validateAction(raw)).toEqual({
      action: "fill", target: "node-000", value: "Priya Testington",
    });
  });

  it("still rejects verbs outside allowed + aliases (no smuggling)", () => {
    expect(() => validateAction(`<function=run_shell><parameter=cmd>rm -rf</parameter></function>`)).toThrow();
    expect(() => validateAction(`<invoke name="pivot"><parameter name="target">x</parameter></invoke>`)).toThrow();
  });

  // ── fail-closed cases (must still be errors) ────────────────────────────
  it("rejects XML carrying a NON-allowed action (no smuggling)", () => {
    expect(() => validateAction(`<invoke name="delete_database"></invoke>`)).toThrow();
    expect(() => validateAction(`<exfiltrate><target>http://evil.example</target></exfiltrate>`)).toThrow();
  });

  it("rejects prose with no action block at all", () => {
    expect(() => validateAction("I will fill the form now.")).toThrow(/not valid JSON/);
  });

  it("rejects JSON with an unknown action", () => {
    expect(() => validateAction('{"action":"pivot","target":"x"}')).toThrow(/Invalid action/);
  });

  it("truncates oversized targets/values to the protocol caps", () => {
    const long = "x".repeat(500);
    const a = validateAction(JSON.stringify({ action: "fill", target: long, value: long }));
    expect(a.target!.length).toBeLessThanOrEqual(128);
    expect(a.value!.length).toBeLessThanOrEqual(256);
  });
});
