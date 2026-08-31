/**
 * Reference HostRenderAdapter — Node/Express-style HTML string injection.
 *
 * This is the host-neutral counterpart to Cloudflare's HTMLRewriter path
 * (src/core/renderer.ts). It performs the SAME injection contract using
 * plain string replacement so a non-Cloudflare host (the P1-24 ordinary
 * upstream app) can sit FireRaid in front without a Worker.
 *
 * The injection mirrors renderSignupPage(): CSRF + decoy field + route
 * notice + client config before </form>, canary by placement, and a
 * production-only inert notice at the end of <body>.
 *
 * FR-R7-035: the reference adapter MUST strip nothing on the way in and
 * inject the same artifacts the core renders — divergence from the
 * canonical renderer would invalidate the middleware proof.
 */
import type { DefenseProfile } from "../types/profile.js";
import { SEMANTIC_TEMPLATES, PLACEMENTS } from "../core/catalog.js";
import { MAX_EVENTS_PER_BATCH, MAX_EVENT_PAYLOAD_BYTES } from "../types/telemetry.js";

function renderDecoyField(profile: DefenseProfile, labMode: boolean): string {
  if (!profile.decoyField) return "";
  // P1-AUDIT-2: mirror the canonical renderer's production opacity — the
  // decoy field must be VISUALLY HIDDEN in production, not a visible text
  // input. Inline styles (not a class): a host page's stylesheet does not
  // carry our CSS, so a class-based hide would silently degrade to visible.
  const cls = labMode ? "fr-decoy" : "";
  const style = labMode
    ? ""
    : ' style="position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;clip-path:inset(50%)!important;white-space:nowrap!important;border:0!important"';
  return `<input type="text" name="${profile.decoyField.fieldName}" id="${profile.decoyField.elementId}"` +
    `${style} class="${cls}" aria-hidden="true" tabindex="-1" autocomplete="off" value="">`;
}

function renderRouteNotice(profile: DefenseProfile, labMode: boolean): string {
  if (!profile.decoyRoute) return "";
  if (labMode) {
    return `<div data-fr-route class="fr-canary-wrap">` +
      `<span class="fr-decoy">Verification endpoint: /c/${profile.decoyRoute.endpointToken}</span></div>`;
  }
  // P1-AUDIT-2: production route notice mirrors the canonical renderer's
  // P1-22 carrier — NO data-fr-* signature, NO greppable token attribute,
  // NO visible "/c/<token>" text.
  return `<template data-rt-carrier="route" data-rt-token="${profile.decoyRoute.endpointToken}">` +
    `Verification endpoint issued to this session.</template>`;
}

function renderCanary(profile: DefenseProfile, labMode: boolean): string {
  // P1-AUDIT-2: mirror the canonical renderer (FR-R7-013) — S01–S08 are
  // LAB-ONLY instruction templates; production emits NO semantic canary.
  if (!profile.semantic || !labMode) return "";
  const template = SEMANTIC_TEMPLATES.find((t) => t.id === profile.semantic!.templateId);
  const placement = PLACEMENTS.find((p) => p.id === profile.semantic!.placementId);
  if (!template || !placement) return "";
  const endpoint = profile.decoyRoute ? `/c/${profile.decoyRoute.endpointToken}` : "/c/<token>";
  const field = profile.decoyField?.fieldName;
  const body = template.render({ nonce: profile.semantic.nonce, endpoint, field, mode: profile.semantic.mode });
  if (placement.position === "non-rendered") {
    return `<div data-fr-canary-id="${template.id}" class="fr-decoy" aria-hidden="true" tabindex="-1">${body}</div>`;
  }
  return `<div data-fr-canary-id="${template.id}" data-fr-placement="${placement.id}" class="fr-canary-wrap">${body}</div>`;
}

function renderClientConfig(profile: DefenseProfile): string {
  const config = {
    telemetry: profile.telemetry,
    interactionScoring: profile.interaction?.scoringEnabled ?? false,
    limits: { maxEventsPerBatch: MAX_EVENTS_PER_BATCH, maxBatchBytes: MAX_EVENT_PAYLOAD_BYTES },
  };
  return `<script type="application/json" id="fr-client-config">${JSON.stringify(config)}</script>`;
}

function renderProductionNotice(): string {
  const text = "This site uses same-origin verification challenges. " +
    "Automated clients should expect a verification token to be presented inline.";
  // P1-AUDIT-2: neutral carrier — the prior data-fr-prod-notice attribute was
  // a greppable data-fr-* production signature (leaks FireRaid identity).
  return `<template data-rt-carrier="notice">${text}</template>`;
}

export function referenceInject(
  html: string,
  profile: DefenseProfile,
  csrfToken: string,
  labMode: boolean
): string {
  const canary = renderCanary(profile, labMode);
  const routeNotice = renderRouteNotice(profile, labMode);
  const decoy = renderDecoyField(profile, labMode);
  const clientConfig = renderClientConfig(profile);

  let out = html;

  const formClose = "</form>";
  const injection = `<input type="hidden" name="csrf" value="${csrfToken}">` + decoy + clientConfig;
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

  if (!labMode) {
    out = out.replace("</body>", renderProductionNotice() + "</body>");
  }

  return out;
}
