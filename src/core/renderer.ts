/**
 * HTML renderer (Worker presentation mapper) — injects defense profile into
 * the signup page.
 *
 * P1-AUDIT-2 Phase D (audit item 5): this module makes NO what-to-emit
 * decisions. Every artifact (decoy field, decoy route, semantic canary,
 * client config, production notice) and its opacity posture comes from the
 * shared core, buildArtifactSet() (core/artifacts.ts) — the exact source the
 * host-adapter reference renderer consumes. The two-divergent-renderers
 * defect class (the host renderer re-deriving policy and drifting: visible
 * production decoys, production semantic canaries, greppable signatures)
 * is structurally eliminated; semantic parity is pinned in
 * tests/unit/artifact-parity.test.ts.
 *
 * What remains here is Worker-only PRESENTATION:
 *   - hiding via the public/signup.css utility class (fr-visually-hidden) —
 *     the Worker ships its stylesheet; the host mapper uses inline styles.
 *   - Cloudflare Turnstile slot markup (verification is Worker-path-only).
 *   - CSS-class lab markers (research greppability).
 *
 * Prior invariants retained: FR-INV-003 (client never classifies),
 * FR-R6-046 (no inline <style>), FR-R6-047 (P01–P05 distinct structures),
 * FR-R6-048 (template text never rewritten — substitutions now happen once,
 * in buildArtifactSet), FR-R6-036 (server-generated client config),
 * P1-22 (production carries no greppable data-fr-* signature).
 */
import type { DefenseProfile } from "../types/profile.js";
import { PLACEMENTS } from "./catalog.js";
import { buildArtifactSet } from "./artifacts.js";

export function renderCanaryForProfile(
  profile: DefenseProfile,
  opts: { labMode: boolean }
): string {
  const artifacts = buildArtifactSet(profile, opts);
  if (!artifacts.semantic) return "";
  const s = artifacts.semantic;

  // FR-R6-047: distinct DOM structures per placement (experimental variables).
  // Lab-only path: artifacts.semantic is null in production (FR-R7-013).
  if (s.position === "non-rendered") {
    return `<div data-fr-canary-id="${s.templateId}" class="fr-decoy" aria-hidden="true" tabindex="-1">${s.bodyHtml}</div>`;
  }

  switch (s.position) {
    case "inert":
      return `<div data-fr-canary-id="${s.templateId}" data-fr-placement="${s.placementId}" ` +
        `role="note" class="fr-canary-wrap fr-canary-inert">${s.bodyHtml}</div>`;
    case "server-injected":
      return `<div data-fr-canary-id="${s.templateId}" data-fr-placement="${s.placementId}" ` +
        `aria-describedby="fr-canary-desc" class="fr-canary-wrap fr-canary-server-injected">` +
        `<span id="fr-canary-desc" class="fr-decoy">Lab verification notice.</span>${s.bodyHtml}</div>`;
    default:
      return `<div data-fr-canary-id="${s.templateId}" data-fr-placement="${s.placementId}" class="fr-canary-wrap">${s.bodyHtml}</div>`;
  }
}

export function renderDecoyField(
  profile: DefenseProfile,
  opts: { labMode: boolean }
): string {
  const artifacts = buildArtifactSet(profile, opts);
  if (!artifacts.decoyField) return "";
  const d = artifacts.decoyField;
  // P1-AUDIT-2 blocker 1: the field is VISUALLY HIDDEN in production
  // (fr-visually-hidden utility from public/signup.css, which also overrides
  // the full-width .fr-form-fields input rule). The field NAME is
  // profile-bound (P1-23 fork) so submit.ts still binds it.
  const cls = d.presentation === "lab-marked" ? "fr-decoy" : "fr-visually-hidden";
  return `<input type="text" name="${d.fieldName}" id="${d.elementId}" ` +
    `class="${cls}" aria-hidden="true" tabindex="-1" autocomplete="off" value="">`;
}

export function renderRouteNotice(
  profile: DefenseProfile,
  opts: { labMode: boolean }
): string {
  const artifacts = buildArtifactSet(profile, opts);
  if (!artifacts.decoyRoute) return "";
  const token = artifacts.decoyRoute.endpointToken;
  if (artifacts.decoyRoute.presentation === "lab-marked") {
    return (
      `<div data-fr-route class="fr-canary-wrap">` +
      `<span class="fr-decoy">Verification endpoint: /c/${token}</span>` +
      `</div>`
    );
  }
  // P1-22 neutral production carrier: zero-layout AX-inert <template>, no
  // data-fr-* attribute, no visible "/c/<token>" text.
  return (
    `<template data-rt-carrier="route" data-rt-token="${token}">` +
    `Verification endpoint issued to this session.` +
    `</template>`
  );
}

export function renderCsrfField(csrfToken: string): string {
  return `<input type="hidden" name="csrf" value="${csrfToken}">`;
}

export function renderTurnstile(siteKey: string): string {
  return `<div class="cf-turnstile" data-sitekey="${siteKey}" data-action="fireraid_signup"
    data-callback="turnstileOnSuccess"
    data-error-callback="turnstileOnError"
    data-expired-callback="turnstileOnExpired"></div>`;
}

export function renderProductionNotice(profile: DefenseProfile, labMode = false): string {
  const artifacts = buildArtifactSet(profile, { labMode });
  if (!artifacts.productionNotice) return "";
  // Lab test hook keeps the historical attribute (only reachable with
  // labMode=true, which the real page never uses for this artifact).
  if (labMode) return `<template data-fr-prod-notice="machine-targeted">${artifacts.productionNotice}</template>`;
  return `<template data-rt-carrier="prod-notice">${artifacts.productionNotice}</template>`;
}

/**
 * FR-R6-036: server-generated client config — the ONE shared-core artifact
 * both renderers embed identically (Worker keeps the id=fr-client-config
 * script tag; presentation is the contract).
 */
export function renderClientConfig(profile: DefenseProfile): string {
  const artifacts = buildArtifactSet(profile, { labMode: true });
  return `<script type="application/json" id="fr-client-config">${JSON.stringify(artifacts.clientConfig)}</script>`;
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
