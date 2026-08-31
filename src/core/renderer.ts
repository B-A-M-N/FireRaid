/**
 * HTML renderer — injects defense profile into the signup page.
 * FR-INV-003: client never decides classification.
 * FR-R6-046: no inline <style> — all static styles live in public/signup.css,
 *   so CSP style-src no longer needs 'unsafe-inline'.
 * FR-R6-047: P01–P05 keep distinct DOM structures (they are experimental
 *   variables); P06 is non-rendered.
 * FR-R6-048: template rendering is CANONICAL — the renderer never re-writes
 *   template text; it only supplies the runtime substitutions.
 * FR-R6-036: emits the server-generated client config.
 *
 * P1-22 (opaque production carriers): the page MUST NOT carry any FIXED,
 * greppable signature that an attacker can hardcode-detect in PRODUCTION.
 * The fixed markers (data-fr-*, .fr-decoy, fr_<hex> field names, the visible
 * "/c/<token>" text) are emitted ONLY in labMode so researchers can verify the
 * rendered token by eye and the integration suite can grep the DOM for it.
 * In production every one of those signatures is replaced by neutral,
 * non-FireRaid-identifying markup (a plain hidden <input>, an inert
 * <template> with no data-fr-* attribute, generic aria-hidden/tabindex=-1).
 *
 * NOTE (P1-22/P1-23 fork, surfaced to owner): the field NAME (profile.decoyField
 * .fieldName, e.g. "fr_a1b2") and the route PATH PREFIX ("/c/") are profile-
 * and server-bound identifiers, not page attributes. Stripping the "fr_" prefix
 * from the field name and the "/c/" prefix from the route requires changes to
 * profile generation and the canary route binding (canary.ts) and is the
 * outstanding product decision for P1-23 — left intact here so the decoy
 * families stay functionally bound and the ledger proof stays valid.
 */
import type { DefenseProfile } from "../types/profile.js";
import { SEMANTIC_TEMPLATES, PLACEMENTS } from "./catalog.js";
import { MAX_EVENTS_PER_BATCH, MAX_EVENT_PAYLOAD_BYTES } from "../types/telemetry.js";

const LAB_MARKER_ATTR = "data-fr-";

/** Returns the lab-mode carrier attribute/value or a neutral one. */
function carrierAttr(labMode: boolean, labAttr: string, labValue: string): string {
  if (labMode) return `${LAB_MARKER_ATTR}${labAttr}="${labValue}"`;
  // Neutral, non-FireRaid-identifying attribute (still machine-readable).
  return `data-rt-carrier="${labAttr}"`;
}

export function renderRouteNotice(
  profile: DefenseProfile,
  opts: { labMode: boolean }
): string {
  if (!profile.decoyRoute) return "";
  if (opts.labMode) {
    return (
      `<div data-fr-route class="fr-canary-wrap">` +
      `<span class="fr-decoy">Verification endpoint: /c/${profile.decoyRoute.endpointToken}</span>` +
      `</div>`
    );
  }
  // FR-R7-012 + P1-22: production artifact is a zero-layout, AX-inert
  // <template> with NO data-fr-* attribute and NO visible "/c/<token>" text —
  // the token path is still present in the raw HTML for raw-DOM consumers, but
  // carries no FireRaid-identifying signature. It is not a hyperlink and not
  // focusable, so it cannot auto-fire the casual-false-positive gate.
  return (
    `<template data-rt-carrier="route" data-rt-token="${profile.decoyRoute.endpointToken}">` +
    `Verification endpoint issued to this session.` +
    `</template>`
  );
}

export function renderCanaryForProfile(
  profile: DefenseProfile,
  opts: { labMode: boolean }
): string {
  // FR-R7-013: S01–S08 are LAB-ONLY instruction-bearing templates. Production
  // emits NO semantic canary markup (the production semantic carrier, if any,
  // is the P1-23 decision and is NOT an instruction template). This keeps the
  // visible DOM free of the data-fr-canary signature in production.
  if (!profile.semantic || !opts.labMode) return "";
  const template = SEMANTIC_TEMPLATES.find((t) => t.id === profile.semantic!.templateId);
  const placement = PLACEMENTS.find((p) => p.id === profile.semantic!.placementId);
  if (!template || !placement) return "";

  const endpoint = profile.decoyRoute
    ? `/c/${profile.decoyRoute.endpointToken}`
    : "/c/<token>";
  const field = profile.decoyField?.fieldName;

  const body = template.render({
    nonce: profile.semantic.nonce,
    endpoint,
    field,
    mode: profile.semantic.mode,
  });

  if (placement.position === "non-rendered") {
    return `<div ${carrierAttr(opts.labMode, "canary-id", template.id)} class="${opts.labMode ? "fr-decoy" : ""}" aria-hidden="true" tabindex="-1">${body}</div>`;
  }

  switch (placement.position) {
    case "inert":
      return `<div ${carrierAttr(opts.labMode, "canary-id", template.id)} ${carrierAttr(opts.labMode, "placement", placement.id)} ` +
        `role="note" class="${opts.labMode ? "fr-canary-wrap fr-canary-inert" : ""}">${body}</div>`;
    case "server-injected":
      return `<div ${carrierAttr(opts.labMode, "canary-id", template.id)} ${carrierAttr(opts.labMode, "placement", placement.id)} ` +
        `aria-describedby="fr-canary-desc" class="${opts.labMode ? "fr-canary-wrap fr-canary-server-injected" : ""}">` +
        `<span id="fr-canary-desc" class="${opts.labMode ? "fr-decoy" : ""}">Lab verification notice.</span>${body}</div>`;
    default:
      return `<div ${carrierAttr(opts.labMode, "canary-id", template.id)} ${carrierAttr(opts.labMode, "placement", placement.id)} class="${opts.labMode ? "fr-canary-wrap" : ""}">${body}</div>`;
  }
}

export function renderDecoyField(
  profile: DefenseProfile,
  opts: { labMode: boolean }
): string {
  if (!profile.decoyField) return "";
  // FR-R6-029: only the decoy-field family renders an input.
  // P1-22: in production the input carries NO "fr-decoy" class and NO "fr_"
  //   greppable marker in its attributes. P1-AUDIT-2: production MUST NOT be a
  //   visible mystery textbox — the previous output dropped the hiding class
  //   (opacity) and rendered a bare type="text" input that showed on screen.
  //   We now carry a NEUTRAL, non-FireRaid-identifying offscreen utility class
  //   (opacity kept) and rely on the standard visually-hidden technique in
  //   public/signup.css — which also overrides the generic full-width text input
  //   rule (.fr-form-fields input) that would otherwise stretch the decoy.
  //   The field NAME itself (profile.decoyField.fieldName) is profile-bound and
  //   is the P1-23 fork — left as-is so submit.ts still binds it.
  const cls = opts.labMode ? "fr-decoy" : "fr-visually-hidden";
  return `<input type="text" name="${profile.decoyField.fieldName}" id="${profile.decoyField.elementId}" ` +
    `class="${cls}" aria-hidden="true" tabindex="-1" autocomplete="off" value="">`;
}

export function renderCsrfField(csrfToken: string): string {
  return `<input type="hidden" name="csrf" value="${csrfToken}">`;
}

/**
 * FR-R7-013 + P1-22: production-only inert machine-targeted semantic artifact.
 * In production it carries NO data-fr-prod-notice attribute — a neutral
 * <template> only. Lab mode does not emit this artifact (it would dilute the
 * real-template measurement).
 */
export function renderProductionNotice(_profile: DefenseProfile, _labMode = false): string {
  const text = "This site uses same-origin verification challenges. " +
               "Automated clients should expect a verification token to be presented inline.";
  if (_labMode) {
    return `<template data-fr-prod-notice="machine-targeted">${escapeHtml(text)}</template>`;
  }
  return `<template data-rt-carrier="prod-notice">${escapeHtml(text)}</template>`;
}

export function renderTurnstile(siteKey: string): string {
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

  const canary = renderCanaryForProfile(profile, { labMode });
  const routeNotice = renderRouteNotice(profile, { labMode });
  const decoy = renderDecoyField(profile, { labMode });
  const csrf = renderCsrfField(csrfToken);
  const turnstile = turnstileSiteKey ? renderTurnstile(turnstileSiteKey) : "";
  const clientConfig = renderClientConfig(profile);

  let out = html;

  const formClose = "</form>";
  const injection = csrf + decoy + turnstile + clientConfig;
  const idx = out.indexOf(formClose);
  if (idx >= 0) {
    out = out.slice(0, idx) + injection + out.slice(idx);
  } else {
    out += injection;
  }

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
      const formOpen = '<form id="signup-form"';
      out = out.replace(formOpen, canary + formOpen);
    }
  }

  if (routeNotice && !out.includes("/c/" + (profile.decoyRoute?.endpointToken ?? ""))) {
    const formOpen = '<form id="signup-form"';
    out = out.replace(formOpen, routeNotice + formOpen);
  }

  if (labMode) {
    const banner = `<div class="fr-lab-banner">RESEARCH / TEST ENVIRONMENT — USE SYNTHETIC DATA ONLY</div>`;
    out = out.replace("<body>", "<body>" + banner);
  } else {
    out = out.replace("</body>", renderProductionNotice(profile, labMode) + "</body>");
  }

  return out;
}
