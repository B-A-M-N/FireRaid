/**
 * Reference HostRenderAdapter — Node/Express-style HTML string injection.
 *
 * P1-AUDIT-2 Phase D (audit item 5): this is a PRESENTATION MAPPER over the
 * shared artifact-generation core (core/artifacts.ts). It makes NO policy
 * decisions — what artifacts exist, their opacity posture, and the semantic
 * template body all come from buildArtifactSet(), the same source the
 * Worker renderer (core/renderer.ts) consumes. Divergence between the two
 * renderers is now structurally impossible (parity is pinned in
 * tests/unit/artifact-parity.test.ts).
 *
 * What remains host-specific is only PRESENTATION: string replacement into
 * the upstream page (no HTMLRewriter), inline styles instead of the Worker's
 * stylesheet classes (a host page does not ship signup.css), and no
 * Turnstile slot (verification is a HostVerificationAdapter concern).
 */
import type { DefenseProfile } from "../types/profile.js";
import { buildArtifactSet } from "../core/artifacts.js";

/** Standard visually-hidden technique as INLINE styles — no host CSS dependency. */
const VISUALLY_HIDDEN_STYLE =
  "position:absolute!important;width:1px!important;height:1px!important;" +
  "padding:0!important;margin:-1px!important;overflow:hidden!important;" +
  "clip:rect(0,0,0,0)!important;clip-path:inset(50%)!important;" +
  "white-space:nowrap!important;border:0!important";

export function referenceInject(
  html: string,
  profile: DefenseProfile,
  csrfToken: string,
  labMode: boolean
): string {
  // THE shared core — same source the Worker renderer consumes.
  const artifacts = buildArtifactSet(profile, { labMode });

  let out = html;

  // --- Inside-form injection: CSRF + decoy field + client config ---------
  const csrfInput = `<input type="hidden" name="csrf" value="${csrfToken}">`;
  const decoyInput = artifacts.decoyField
    ? (artifacts.decoyField.presentation === "lab-marked"
        ? `<input type="text" name="${artifacts.decoyField.fieldName}" id="${artifacts.decoyField.elementId}" class="fr-decoy" aria-hidden="true" tabindex="-1" autocomplete="off" value="">`
        : `<input type="text" name="${artifacts.decoyField.fieldName}" id="${artifacts.decoyField.elementId}" style="${VISUALLY_HIDDEN_STYLE}" class="" aria-hidden="true" tabindex="-1" autocomplete="off" value="">`)
    : "";
  const clientConfigScript = `<script type="application/json" id="fr-client-config">${JSON.stringify(artifacts.clientConfig)}</script>`;
  const injection = csrfInput + decoyInput + clientConfigScript;

  const formClose = "</form>";
  const idx = out.indexOf(formClose);
  if (idx >= 0) {
    out = out.slice(0, idx) + injection + out.slice(idx);
  } else {
    out += injection;
  }

  // --- Semantic canary (lab-only; artifacts.semantic is null in prod) ----
  if (artifacts.semantic) {
    const s = artifacts.semantic;
    const carrier =
      s.position === "non-rendered"
        ? `<div data-fr-canary-id="${s.templateId}" class="fr-decoy" aria-hidden="true" tabindex="-1">${s.bodyHtml}</div>`
        : `<div data-fr-canary-id="${s.templateId}" data-fr-placement="${s.placementId}" class="fr-canary-wrap">${s.bodyHtml}</div>`;
    if (s.position === "submit-adjacent") {
      out = out.replace("</form>", carrier + "</form>");
    } else if (s.position === "form-metadata") {
      const marker = '<fieldset class="fr-form-fields">';
      out = out.replace(marker, marker + carrier);
    } else {
      const formOpen = '<form id="signup-form"';
      out = out.replace(formOpen, carrier + formOpen);
    }
  }

  // --- Route notice -------------------------------------------------------
  if (artifacts.decoyRoute) {
    const token = artifacts.decoyRoute.endpointToken;
    if (artifacts.decoyRoute.presentation === "lab-marked") {
      if (!out.includes("/c/" + token)) {
        out = out.replace(
          '<form id="signup-form"',
          `<div data-fr-route class="fr-canary-wrap">` +
            `<span class="fr-decoy">Verification endpoint: /c/${token}</span></div>` +
            '<form id="signup-form"'
        );
      }
    } else if (!out.includes(token)) {
      // P1-22 neutral production carrier: inert <template>, no data-fr-*.
      out = out.replace(
        '<form id="signup-form"',
        `<template data-rt-carrier="route" data-rt-token="${token}">` +
          `Verification endpoint issued to this session.</template>` +
          '<form id="signup-form"'
      );
    }
  }

  // --- Mode banner / production notice ------------------------------------
  if (labMode) {
    out = out.replace(
      "<body>",
      `<body><div class="fr-lab-banner">RESEARCH / TEST ENVIRONMENT — USE SYNTHETIC DATA ONLY</div>`
    );
  } else if (artifacts.productionNotice) {
    out = out.replace(
      "</body>",
      `<template data-rt-carrier="prod-notice">${artifacts.productionNotice}</template></body>`
    );
  }

  return out;
}
