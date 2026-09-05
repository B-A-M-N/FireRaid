/**
 * P1 (escaping): operator/deployment configuration is interpolated into
 * HTML contexts by BOTH presentation mappers. Trusted in the threat model,
 * but a misconfigured value must never be able to break out of its context:
 *
 *   1. The client-config JSON island — JSON.stringify() leaves `<` verbatim,
 *      so an endpoint value containing `</script>` terminates the island and
 *      opens script context. The island must be serialized with `<`
 *      neutralized (<), which JSON.parse restores losslessly.
 *   2. Attribute values (client script src, Turnstile site key, CSRF token,
 *      decoy field name/id) — must be HTML-escaped.
 *   3. Lab route-notice text (canaryPrefix) — HTML-escaped text context.
 *
 * Server-internal material (nonce, field name, route token) uses fixed
 * reviewed alphabets and is NOT covered here — see core/prng.ts and
 * core/profile.ts.
 */
import { describe, it, expect } from "vitest";
import { renderSignupPage } from "../../src/core/renderer.js";
import { referenceInject } from "../../src/host-adapter/reference-render.js";
import { deriveProfilePure, ABLATION_RECIPES } from "../../src/core/profile.js";
import { escapeHtml, jsonForScriptIsland } from "../../src/security/html.js";
import type { DefenseRecipe } from "../../src/core/recipe-schema.js";

const SECRET = "escaping-test-secret";

const BASE_HTML =
  '<!doctype html><html><body><form id="signup-form">' +
  '<fieldset class="fr-form-fields"></fieldset>' +
  "</form></body></html>";

async function fullProfile(sessionId: string): Promise<Awaited<ReturnType<typeof deriveProfilePure>>> {
  const recipe: DefenseRecipe = { ...ABLATION_RECIPES.FULL, placementId: "P01" };
  return deriveProfilePure({ secret: SECRET, version: 1, sessionId, mode: "lab" }, recipe);
}

/** Extract the JSON island payload from rendered HTML. */
function islandPayload(html: string): string | null {
  const m = html.match(/<script type="application\/json" id="(fr-client-config|app-runtime-config)">(.*)<\/script>/);
  return m ? m[2] : null;
}

describe("jsonForScriptIsland", () => {
  it("neutralizes </script> and all '<' breakout forms", () => {
    const payload = {
      endpoints: { formSelector: "#f", submit: "/x", telemetry: "</script><script>alert(1)</script>" },
    };
    const serialized = jsonForScriptIsland(payload);
    // No literal '<' survives serialization.
    expect(serialized).not.toContain("<");
    // Case variations and comment-open forms are all '<'-gated.
    expect(serialized).not.toMatch(/<\/?script/i);
    expect(serialized).not.toContain("<!--");
    // Lossless round-trip.
    expect(JSON.parse(serialized)).toEqual(payload);
    expect(JSON.parse(serialized).endpoints.telemetry).toBe("</script><script>alert(1)</script>");
  });

  it("escapes '<' in every string position of a full client config", () => {
    const cfg = {
      nested: { deep: ["a<b", { s: "<!--" }] },
      num: 5,
      bool: false,
      nul: null,
    };
    const serialized = jsonForScriptIsland(cfg);
    expect(serialized).not.toContain("<");
    expect(JSON.parse(serialized)).toEqual(cfg);
  });

  it("leaves values without '<' byte-identical to JSON.stringify", () => {
    const cfg = { endpoints: { submit: "/api/submit", formSelector: "#signup-form" } };
    expect(jsonForScriptIsland(cfg)).toBe(JSON.stringify(cfg));
  });
});

describe("escapeHtml", () => {
  it("escapes all five HTML-significant characters", () => {
    expect(escapeHtml('&<>"\'')).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("is idempotent-safe for plain values (no double encoding on first pass)", () => {
    expect(escapeHtml("/signup.js")).toBe("/signup.js");
    expect(escapeHtml("#signup-form")).toBe("#signup-form");
  });
});

describe("renderers: hostile operator configuration cannot break context", () => {
  const HOSTILE_SELECTOR = '"><script>alert(1)</script>';
  const HOSTILE_SRC = '"/><script>alert(1)</script>';

  it("Worker: formSelector containing </script> does not terminate the island", async () => {
    const profile = await fullProfile("esc-worker-island");
    const html = renderSignupPage({
      html: BASE_HTML,
      profile,
      csrfToken: "csrf-x",
      evaluationMode: true,
      routes: {
        formSelector: '</script><script>alert("island")</script>',
        submitEndpoint: "/submit",
        telemetryEndpoint: "/api/events",
      },
    });
    const payload = islandPayload(html);
    expect(payload).not.toBeNull();
    // Island content carries no raw '<' — it cannot have been terminated.
    expect(payload!).not.toContain("<");
    // Round-trips to the hostile value the operator configured.
    const parsed = JSON.parse(payload!) as { endpoints: { formSelector: string } };
    expect(parsed.endpoints.formSelector).toBe('</script><script>alert("island")</script>');
    // Exactly ONE json island on the page.
    expect((html.match(/<script type="application\/json"/g) ?? []).length).toBe(1);
  });

  it("host: formSelector containing </script> does not terminate the island", async () => {
    const profile = await fullProfile("esc-host-island");
    const html = referenceInject(BASE_HTML, profile, "csrf-x", true, {
      routes: {
        formSelector: '</script><script>alert("island")</script>',
        submitEndpoint: "/submit",
        telemetryEndpoint: "/api/events",
      },
    });
    const payload = islandPayload(html);
    expect(payload).not.toBeNull();
    expect(payload!).not.toContain("<");
    expect((html.match(/<script type="application\/json"/g) ?? []).length).toBe(1);
  });

  it("Worker: hostile clientScriptSrc stays inside the attribute", async () => {
    const profile = await fullProfile("esc-worker-src");
    const html = renderSignupPage({
      html: BASE_HTML,
      profile,
      csrfToken: "csrf-x",
      evaluationMode: false,
      clientScriptSrc: HOSTILE_SRC,
    });
    // The breakout fragment must not appear as markup.
    expect(html).not.toContain('><script>alert(1)</script>');
    // The attribute is intact and escape-encoded.
    expect(html).toContain(`<script src="${escapeHtml(HOSTILE_SRC)}" defer></script>`);
  });

  it("host: hostile clientScriptSrc stays inside the attribute", async () => {
    const profile = await fullProfile("esc-host-src");
    const html = referenceInject(BASE_HTML, profile, "csrf-x", false, {
      clientScriptSrc: HOSTILE_SRC,
    });
    expect(html).not.toContain('><script>alert(1)</script>');
    expect(html).toContain(`<script src="${escapeHtml(HOSTILE_SRC)}" defer></script>`);
  });

  it("Worker: hostile Turnstile site key stays inside data-sitekey", () => {
    const html = renderSignupPage({
      html: BASE_HTML,
      profile: { telemetry: { captureFocus: false, captureInput: false, captureChange: false, capturePointer: false, captureKey: false, captureSubmit: false }, scoringPolicy: "off" } as never,
      csrfToken: "csrf-x",
      evaluationMode: false,
      turnstileSiteKey: HOSTILE_SELECTOR,
    });
    // renderTurnstile is reached only via renderSignupPage — verify the key
    // is encoded: no raw quote-breakout reaches markup.
    expect(html).toContain(`data-sitekey="${escapeHtml(HOSTILE_SELECTOR)}"`);
    expect(html).not.toContain(`data-sitekey="${HOSTILE_SELECTOR}"`);
  });

  it("both mappers: hostile csrf token stays inside value attribute", async () => {
    const profile = await fullProfile("esc-csrf");
    const hostileCsrf = '"><script>alert(1)</script>';
    const worker = renderSignupPage({ html: BASE_HTML, profile, csrfToken: hostileCsrf, evaluationMode: false });
    const host = referenceInject(BASE_HTML, profile, hostileCsrf, false);
    for (const [label, html] of [["worker", worker], ["host", host]] as const) {
      expect(html, label).toContain(`name="csrf" value="${escapeHtml(hostileCsrf)}"`);
      expect(html, label).not.toContain('value=""><script>');
    }
  });

  it("lab route notice: hostile canaryPrefix stays in the text context", async () => {
    const profile = await fullProfile("esc-route-notice");
    // buildArtifactSet coerces a canaryPrefix that does not start with "/"
    // back to the default (core/artifacts.ts), so the realistic hostile
    // shape is a slash-prefixed value carrying markup.
    const hostilePrefix = '/"><script>alert(1)</script>';
    const worker = renderSignupPage({
      html: BASE_HTML, profile, csrfToken: "csrf-x", evaluationMode: true,
      routes: { canaryPrefix: hostilePrefix, submitEndpoint: "/submit", telemetryEndpoint: "/api/events" },
    });
    expect(worker).toContain(escapeHtml(hostilePrefix));
    expect(worker).not.toContain('><script>alert(1)</script>');
  });
});
