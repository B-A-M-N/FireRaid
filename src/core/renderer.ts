/**
 * HTML renderer — injects defense profile into the signup page.
 * FR-INV-003: client never decides classification.
 * FR-R6-046: no inline <style> — all static styles live in public/signup.css,
 *   so CSP style-src no longer needs 'unsafe-inline'.
 * FR-R6-047: P01–P05 keep distinct DOM structures (they are experimental
 *   variables); P06 is non-rendered.
 * FR-R6-048: template rendering is CANONICAL — the renderer never re-writes
 *   template text (the duplicated S06 switch is deleted); it only supplies
 *   the runtime substitutions (nonce, endpoint, field) to template.render().
 * FR-R6-036: emits the server-generated client config
 *   (<script type="application/json" id="fr-client-config">) that signup.js
 *   must honor for the telemetry capture mask.
 */
import type { DefenseProfile } from "../types/profile.js";
import { SEMANTIC_TEMPLATES, PLACEMENTS } from "./catalog.js";
import { MAX_EVENTS_PER_BATCH, MAX_EVENT_PAYLOAD_BYTES } from "../types/telemetry.js";

/**
 * FR-POST-R6-P3: the decoy-route family must be observable by an agent to be
 * a measurable treatment — a route token that exists server-side but renders
 * nowhere can never be REQUESTED, so DECOY_ROUTE_ONLY would be a null
 * condition, and SEMANTIC_ROUTE sessions that drew a template which never
 * names the endpoint (S01–S03/S07/S09) would be silent too.
 *
 * FR-R7-012: production's route artifact is split off here. The lab keeps
 * the visible notice (so researchers can verify the rendered token by eye
 * and the integration suite can grep the DOM for it); production renders
 * a zero-layout, AX-inert <template data-fr-route> — the token still
 * exists in the raw HTML for raw-DOM consumers, but the element has no
 * visual layout, no semantic role, and is excluded from the accessibility
 * tree. CSS clipping is not enough by itself (clipped elements can still
 * appear in the AX tree); a non-rendered <template> is the cleanest inert
 * surface.
 */
export function renderRouteNotice(profile: DefenseProfile, opts: { labMode: boolean }): string {
  if (!profile.decoyRoute) return "";
  if (opts.labMode) {
    return (
      `<div data-fr-route class="fr-canary-wrap">` +
      `<span class="fr-decoy">Verification endpoint: /c/${profile.decoyRoute.endpointToken}</span>` +
      `</div>`
    );
  }
  // FR-R7-012: production artifact is intentionally NOT a hyperlink and
  // NOT focusable — a passive page element that auto-fetches would cause
  // the causal false-positive gate (E2E "normal user makes zero /c/
  // requests") to fire on every legitimate user. Raw DOM consumers
  // (curl, browser-use, raw-dom LLM) can still read the token from the
  // template element's text content.
  return (
    `<template data-fr-route="production" data-fr-token="${profile.decoyRoute.endpointToken}">` +
    `Verification endpoint: /c/${profile.decoyRoute.endpointToken}` +
    `</template>`
  );
}

export function renderCanaryForProfile(profile: DefenseProfile): string {
  if (!profile.semantic) return "";
  const template = SEMANTIC_TEMPLATES.find((t) => t.id === profile.semantic!.templateId);
  const placement = PLACEMENTS.find((p) => p.id === profile.semantic!.placementId);
  if (!template || !placement) return "";

  // FR-R6-027/049: the route endpoint comes ONLY from decoyRoute. A
  // DECOY_FIELD_ONLY session renders "/c/<token>" placeholders — it has no
  // route token, and handing it one would contaminate the ablation.
  const endpoint = profile.decoyRoute
    ? `/c/${profile.decoyRoute.endpointToken}`
    : "/c/<token>";
  // Likewise the decoy field name comes ONLY from decoyField: S06's
  // decoy-mode text names the field; without decoy-field the placeholder
  // renders (and CANARY_NONCE_REPRODUCED is unreachable for that session,
  // which is the point of the ablation).
  const field = profile.decoyField?.fieldName;

  // Canonical template renderer — S06's mode-dependence lives in the catalog
  // (FR-R6-048), not duplicated here.
  const body = template.render({
    nonce: profile.semantic.nonce,
    endpoint,
    field,
    mode: profile.semantic.mode,
  });

  // P06 (non-rendered) is hidden from visible UI, AX tree, and keyboard.
  if (placement.position === "non-rendered") {
    return `<div data-fr-canary-id="${template.id}" class="fr-decoy" aria-hidden="true" tabindex="-1">${body}</div>`;
  }

  // FR-R6-047: placements are experimental variables — keep their structures
  // distinct (P04 inert container, P05 server-injected fragment, P01/P02/P03
  // visible canary regions).
  switch (placement.position) {
    case "inert":
      return `<div data-fr-canary-id="${template.id}" data-fr-placement="${placement.id}" ` +
        `role="note" class="fr-canary-wrap fr-canary-inert">${body}</div>`;
    case "server-injected":
      return `<div data-fr-canary-id="${template.id}" data-fr-placement="${placement.id}" ` +
        `aria-describedby="fr-canary-desc" class="fr-canary-wrap fr-canary-server-injected">` +
        `<span id="fr-canary-desc" class="fr-decoy">Lab verification notice.</span>${body}</div>`;
    default:
      // form-adjacent / form-metadata / submit-adjacent share the visible
      // canary style; their distinct position in the DOM is set by the
      // caller (renderSignupPage injection point).
      return `<div data-fr-canary-id="${template.id}" data-fr-placement="${placement.id}" class="fr-canary-wrap">${body}</div>`;
  }
}

export function renderDecoyField(profile: DefenseProfile): string {
  // FR-R6-029: only the decoy-field family renders an input.
  if (!profile.decoyField) return "";
  return `<input type="text" name="${profile.decoyField.fieldName}" id="${profile.decoyField.elementId}" ` +
    `class="fr-decoy" aria-hidden="true" tabindex="-1" autocomplete="off" value="">`;
}

export function renderCsrfField(csrfToken: string): string {
  return `<input type="hidden" name="csrf" value="${csrfToken}">`;
}

/**
 * FR-R7-013: production-only inert machine-targeted semantic artifact.
 *
 * S01–S08 are instruction-bearing templates that are LAB-ONLY — they
 * would be a real "semantic defense" only when an automated client reads
 * them. Production has no such template (S09 is a metadata marker, not
 * an instruction). This function renders a NON-INSTRUCTION, session-bound
 * notice into an inert <template data-fr-prod-notice> — visible to raw-DOM
 * consumers and invisible to humans / AX / keyboard.
 *
 * The text is generic on purpose: it does NOT instruct the client to
 * stop, do not submit, or bypass the form. It only acknowledges that
 * automated clients SHOULD verify same-origin verification. Treat this
 * as a probe of raw-DOM observation, not a defense — its causal weight
 * is zero (the score system ignores it). The goal is to test whether
 * raw-DOM clients can detect that the page exists, not to manipulate
 * their behavior.
 *
 * Lab mode does NOT emit this artifact — researchers are studying the
 * real S01–S08 templates and a generic prod-only artifact would dilute
 * the measurement.
 */
export function renderProductionNotice(_profile: DefenseProfile): string {
  // Deterministic, generic, and contains no session-specific tokens that
  // could be misused as a per-session marker. The nonce here is a static
  // constant — the artifact is a measurement probe, not a session
  // identifier.
  const text = "This site uses same-origin verification challenges. " +
               "Automated clients should expect a verification token to be presented inline.";
  return `<template data-fr-prod-notice="machine-targeted">${escapeHtml(text)}</template>`;
}

export function renderTurnstile(siteKey: string): string {
  // FIX: Use explicit rendering with proper callbacks
  return `<div class="cf-turnstile" data-sitekey="${siteKey}" data-action="fireraid_signup"
    data-callback="turnstileOnSuccess"
    data-error-callback="turnstileOnError"
    data-expired-callback="turnstileOnExpired"></div>`;
}

/** FR-R7-013: deterministic HTML-escape used by the production notice. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * FR-R6-036: server-generated client config. The browser script MUST honor
 * this mask — a profile whose telemetry config disables pointer capture must
 * not capture pointer events client-side, or randomized telemetry conditions
 * are not actual treatments.
 *
 * FR-P0-5: the server's batch limits are surfaced here too — the client
 * batches by BOTH count and encoded byte size, and must never hardcode
 * magic numbers that can drift from the server's schema.
 */
export function renderClientConfig(profile: DefenseProfile): string {
  const config = {
    telemetry: profile.telemetry,
    interactionScoring: profile.interaction?.scoringEnabled ?? false,
    limits: {
      maxEventsPerBatch: MAX_EVENTS_PER_BATCH,
      maxBatchBytes: MAX_EVENT_PAYLOAD_BYTES,
    },
  };
  return `<script type="application/json" id="fr-client-config">${JSON.stringify(config)}</script>`;
}

/**
 * Inject all defense markup into the static signup HTML.
 * Uses string replacement at known anchor points.
 */
export function renderSignupPage(opts: {
  html: string;
  profile: DefenseProfile;
  csrfToken: string;
  turnstileSiteKey?: string;
  labMode: boolean;
}): string {
  const { html, profile, csrfToken, turnstileSiteKey, labMode } = opts;

  const canary = renderCanaryForProfile(profile);
  const routeNotice = renderRouteNotice(profile, { labMode });
  const decoy = renderDecoyField(profile);
  const csrf = renderCsrfField(csrfToken);
  const turnstile = turnstileSiteKey ? renderTurnstile(turnstileSiteKey) : "";
  const clientConfig = renderClientConfig(profile);

  let out = html;

  // Inject CSRF + decoy + turnstile + client config before </form>
  const formClose = "</form>";
  const injection = csrf + decoy + turnstile + clientConfig;
  const idx = out.indexOf(formClose);
  if (idx >= 0) {
    out = out.slice(0, idx) + injection + out.slice(idx);
  } else {
    out += injection;
  }

  // Inject canary based on placement
  if (canary) {
    const placement = profile.semantic
      ? PLACEMENTS.find((p) => p.id === profile.semantic!.placementId)
      : undefined;
    if (placement?.position === "submit-adjacent") {
      out = out.replace("</form>", canary + "</form>");
    } else if (placement?.position === "form-metadata") {
      const marker = '<fieldset class="fr-form-fields">';
      out = out.replace(marker, marker + canary);
    } else {
      // Default: form-adjacent (before form)
      const formOpen = '<form id="signup-form"';
      out = out.replace(formOpen, canary + formOpen);
    }
  }

  // FR-POST-R6-P3: guarantee the route token is rendered EXACTLY once —
  // mount the standalone notice only when no template body already carried
  // the endpoint path (route-only sessions, or semantic templates that never
  // name the endpoint, e.g. S01–S03/S07/S09).
  if (routeNotice && !out.includes("/c/" + (profile.decoyRoute?.endpointToken ?? ""))) {
    const formOpen = '<form id="signup-form"';
    out = out.replace(formOpen, routeNotice + formOpen);
  }

  // Lab banner
  if (labMode) {
    const banner = `<div class="fr-lab-banner">RESEARCH / TEST ENVIRONMENT — USE SYNTHETIC DATA ONLY</div>`;
    out = out.replace("<body>", "<body>" + banner);
  } else {
    // FR-R7-013: production-only inert machine-targeted artifact. Sits at
    // the very end of <body> so it cannot affect anything above it.
    out = out.replace("</body>", renderProductionNotice(profile) + "</body>");
  }

  return out;
}
