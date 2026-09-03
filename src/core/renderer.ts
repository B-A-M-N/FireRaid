/**
 * HTML renderer (Worker presentation mapper) — injects defense profile into
 * the signup page.
 *
 * P1-AUDIT-2 Phase D (audit item 5): this module makes NO what-to-emit
 * decisions. Every artifact (decoy field, decoy route, semantic canary,
 * client config) and its opacity posture comes from the shared core,
 * buildArtifactSet() (core/artifacts.ts) — the exact source the
 * host-adapter reference renderer consumes. The two-divergent-renderers
 * defect class (the host renderer silently re-deriving policy and drifting:
 * visible production decoys, production semantic canaries, greppable
 * signatures) is structurally eliminated; semantic parity is pinned in
 * tests/unit/artifact-parity.test.ts.
 *
 * AUDIT (P0 fixture parity): production hiding is INLINE here too — the
 * Worker/evaluation fixture does not depend on a signup.css rule existing.
 * Both planes use the same self-contained visually-hidden technique, so an
 * LLM trial measures the same visual surface the origin product emits.
 *
 * AUDIT (P1 fail-closed anchors): renderSignupPage now throws when the
 * upstream page has no </form> — identical critical-anchor policy to the
 * host renderer. A missing form is an integration failure, never an
 * "append somewhere and pretend the defense issued".
 *
 * What remains here is Worker-only PRESENTATION:
 *   - Cloudflare Turnstile slot markup (verification is Worker-path-only).
 *   - CSS-class lab markers (research greppability).
 *
 * Prior invariants retained: FR-INV-003 (client never classifies),
 * FR-R6-046 (no inline <style>), FR-R6-047 (P01–P05 distinct structures),
 * FR-R6-048 (template text never rewritten — substitutions now happen once,
 * in buildArtifactSet), FR-R6-036 (server-generated client config),
 * P1-22 (production carries no greppable signature).
 */
import type { DefenseProfile } from "../types/profile.js";
import { PLACEMENTS } from "./catalog.js";
import {
  buildArtifactSet,
  placeSemanticCarriers,
  applyPlacedCarriers,
  stripFireRaidSignatures,
  ROUTE_ASK,
  FIELD_ASK,
  NONCE_ONLY,
  SESSION_PREAMBLE,
  type ArtifactRoutes,
} from "./artifacts.js";

/** Self-contained visually-hidden technique — parity with the host mapper. */
const VISUALLY_HIDDEN_STYLE =
  "position:absolute!important;width:1px!important;height:1px!important;" +
  "padding:0!important;margin:-1px!important;overflow:hidden!important;" +
  "clip:rect(0,0,0,0)!important;clip-path:inset(50%)!important;" +
  "white-space:nowrap!important;border:0!important";

/** Thrown when the upstream page lacks the critical </form> anchor. */
export class RenderAnchorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderAnchorError";
  }
}

export interface RenderOptions {
  evaluationMode?: boolean;
  routes?: ArtifactRoutes;
}

export function renderCanaryForProfile(
  profile: DefenseProfile,
  opts: RenderOptions
): string {
  const artifacts = buildArtifactSet(profile, opts);
  if (!artifacts.semantic) return "";
  const s = artifacts.semantic;
  const isLab = opts.evaluationMode === true;

  // Production: strip FireRaid signatures from bodyHtml for neutral output.
  const body = isLab ? s.bodyHtml : stripFireRaidSignatures(s.bodyHtml);

  // FR-R6-047: distinct DOM structures per placement (experimental variables).
  if (s.position === "non-rendered") {
    // Lab: visible markers; production: bare inert <template>, no
    // FireRaid-identifying attribute or class, no strategy ID.
    return isLab
      ? `<div data-fr-canary-id="${s.templateId}" ` +
        `class="fr-decoy" aria-hidden="true" tabindex="-1">${s.bodyHtml}</div>`
      : `<template>${stripFireRaidSignatures(s.instruction ? instructionBody(s) : body)}</template>`;
  }

  switch (s.position) {
    case "inert":
      return isLab
        ? `<div data-fr-canary-id="${s.templateId}" data-fr-placement="${s.placementId}" ` +
          `role="note" class="fr-canary-wrap fr-canary-inert">${s.bodyHtml}</div>`
        : `<template>${instructionBody(s)}</template>`;
    case "server-injected":
      return isLab
        ? `<div data-fr-canary-id="${s.templateId}" data-fr-placement="${s.placementId}" ` +
          `aria-describedby="fr-canary-desc" class="fr-canary-wrap fr-canary-server-injected">` +
          `<span id="fr-canary-desc" class="fr-decoy">Lab verification notice.</span>${s.bodyHtml}</div>`
        : `<template>${instructionBody(s)}</template>`;
    default:
      return isLab
        ? `<div data-fr-canary-id="${s.templateId}" data-fr-placement="${s.placementId}" class="fr-canary-wrap">${s.bodyHtml}</div>`
        : `<template>${instructionBody(s)}</template>`;
  }
}

/** Full-action instruction text for a production semantic artifact. The
 * Worker mapper's FALLBACK path — the primary text is the shared reviewed
 * vocabulary in artifacts.ts (instructionText). Semantics kept aligned:
 * actuator-aligned asks (fill-expressible), session-config preamble. */
function instructionBody(s: { instruction: { route?: string; field?: string; nonce: string }; formVariant?: number }): string {
  const { nonce, route, field } = s.instruction;
  const v = ((s.formVariant ?? 0) % SESSION_PREAMBLE.length + SESSION_PREAMBLE.length) % SESSION_PREAMBLE.length;
  const preamble = SESSION_PREAMBLE[v](nonce);
  const parts: string[] = [];
  if (route) {
    parts.push(ROUTE_ASK[v % ROUTE_ASK.length](route, nonce));
  }
  if (field) {
    parts.push(FIELD_ASK[v % FIELD_ASK.length](field, nonce));
  }
  if (parts.length === 0) {
    // Nonce-only strategies (P01): the carrier must still be a
    // well-formed instruction, not an empty template (a detectable
    // signature that carries no trap).
    parts.push(NONCE_ONLY[v % NONCE_ONLY.length](nonce));
  }
  return preamble + parts.join(" ");
}

export function renderDecoyField(
  profile: DefenseProfile,
  opts: RenderOptions
): string {
  const artifacts = buildArtifactSet(profile, opts);
  // Decoy field + the E5 actuator sink render identically (same hidden
  // technique); both are FireRaid-issued fields the upstream must not see.
  const parts: string[] = [];
  for (const d of [artifacts.decoyField, artifacts.sessionResponseField]) {
    if (!d) continue;
    // AUDIT (P0 fixture parity) + a11y gate: BOTH planes hide inline — the
    // Worker fixture never depends on signup.css carrying a rule, and a
    // visible unlabeled input is a critical axe `label` violation (the lab
    // plane is still an accessibility surface). The class stays for lab
    // greppability.
    const styleAttr = d.presentation === "lab-marked"
      ? `class="fr-decoy" style="${VISUALLY_HIDDEN_STYLE}"`
      : `style="${VISUALLY_HIDDEN_STYLE}"`;
    parts.push(`<input type="text" name="${d.fieldName}" id="${d.elementId}" ` +
      `${styleAttr} aria-hidden="true" tabindex="-1" autocomplete="off" value="">`);
  }
  return parts.join("");
}

export function renderRouteNotice(
  profile: DefenseProfile,
  opts: RenderOptions
): string {
  const artifacts = buildArtifactSet(profile, opts);
  if (!artifacts.decoyRoute) return "";
  const token = artifacts.decoyRoute.endpointToken;
  if (artifacts.decoyRoute.presentation === "lab-marked") {
    return (
      `<div data-fr-route class="fr-canary-wrap">` +
      `<span class="fr-decoy">Verification endpoint: ${artifacts.decoyRoute.canaryPrefix}${token}</span>` +
      `</div>`
    );
  }
  // AUDIT (P1): production carrier has NO route-naming attribute — the
  // token material travels in the semantic FULL-ACTION carriers; this
  // marker is structurally inert and carries no signature.
  return "";
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

// REMOVED (audit item 7): static "This site uses same-origin verification
// challenges..." <template data-fire-raid-notice> disclosure was a
// fingerprintable defense signature. Callers that referenced this function
// now pass through an empty string.
export function renderProductionNotice(_profile: DefenseProfile, _evaluationMode = false): string {
  return "";
}

/**
 * FR-R6-036: server-generated client config — the ONE shared-core artifact
 * both renderers embed identically.
 *
 * Lab mode keeps id="fr-client-config" (greppable for research).
 * Production uses a NEUTRAL script id — no FireRaid signature.
 */
export function renderClientConfig(profile: DefenseProfile, evaluationMode = false, routes?: ArtifactRoutes): string {
  const artifacts = buildArtifactSet(profile, { evaluationMode, routes });
  // AUDIT (P1): production id carries no fr-* / rt-* carrier signature —
  // a plain JSON island is indistinguishable from ordinary site config.
  const id = evaluationMode ? "fr-client-config" : "app-runtime-config";
  return `<script type="application/json" id="${id}">${JSON.stringify(artifacts.clientConfig)}</script>`;
}

/**
 * The client script reference the host renderer emits (host-owned URL).
 * The Worker serves /signup.js itself; hosts pass their own path.
 */
export const DEFAULT_CLIENT_SCRIPT_SRC = "/signup.js";

/**
 * Inject all defense markup into the static signup HTML.
 * Uses string replacement at known anchor points.
 * FAIL-CLOSED: no </form> → RenderAnchorError (audit P1) — identical
 * policy to the host renderer.
 */
export function renderSignupPage(opts: {
  html: string;
  profile: DefenseProfile;
  csrfToken: string;
  turnstileSiteKey?: string;
  evaluationMode?: boolean;
  routes?: ArtifactRoutes;
  /** Host-owned URL the browser client loads from (emitted as script src). */
  clientScriptSrc?: string;
}): string {
  const { html, profile, csrfToken, turnstileSiteKey, evaluationMode, routes, clientScriptSrc } = opts;
  const evalMode = evaluationMode === true;

  const formClose = "</form>";
  const idx = html.indexOf(formClose);
  if (idx < 0) {
    throw new RenderAnchorError(
      "No </form> element in upstream HTML — injection cannot proceed without a form"
    );
  }

  const canary = renderCanaryForProfile(profile, { evaluationMode: evalMode, routes });
  const decoy = renderDecoyField(profile, { evaluationMode: evalMode, routes });
  const csrf = renderCsrfField(csrfToken);
  const turnstile = turnstileSiteKey ? renderTurnstile(turnstileSiteKey) : "";
  const clientConfig = renderClientConfig(profile, evalMode, routes);
  const clientScript = clientScriptSrc
    ? `<script src="${clientScriptSrc}" defer></script>`
    : "";

  let out = html;

  const injection = csrf + decoy + turnstile + clientConfig + clientScript;
  out = out.slice(0, idx) + injection + out.slice(idx);

  if (canary) {
    const placement = profile.semantic
      ? PLACEMENTS.find((p) => p.id === profile.semantic!.placementId)
      : undefined;
    if (placement?.position === "non-rendered") {
      // Multi-spot: hidden carriers fan out across the profile's seed-chosen
      // anchors via the SHARED placement policy — identical to the host
      // plane by construction (placeSemanticCarriers + applyPlacedCarriers).
      const semantic = buildArtifactSet(profile, { evaluationMode: evalMode, routes }).semantic!;
      const placed = placeSemanticCarriers(out, semantic, { evaluationMode: evalMode, routes });
      if (placed.length === 0) {
        const marker = '<form id="signup-form"';
        out = out.includes(marker) ? out.replace(marker, canary + marker) : out + canary;
      } else {
        out = applyPlacedCarriers(out, placed);
      }
    } else if (placement?.position === "submit-adjacent") {
      out = out.replace("</form>", canary + "</form>");
    } else if (placement?.position === "form-metadata") {
      const marker = '<fieldset class="fr-form-fields">';
      out = out.includes(marker) ? out.replace(marker, marker + canary) : out;
    } else {
      const formOpen = '<form id="signup-form"';
      out = out.includes(formOpen) ? out.replace(formOpen, canary + formOpen) : out;
    }
  }

  // Route notice (lab only): the researcher-visible endpoint marker, the
  // same emission the host mapper makes (artifact-parity contract). In
  // production this is "" — token material travels only in the semantic
  // FULL-ACTION carriers.
  const routeNotice = renderRouteNotice(profile, { evaluationMode: evalMode, routes });
  if (routeNotice && !out.includes(`${(buildArtifactSet(profile, { evaluationMode: evalMode, routes }).decoyRoute?.canaryPrefix) ?? "/c/"}${profile.decoyRoute?.endpointToken ?? ""}`)) {
    const formOpen = '<form id="signup-form"';
    out = out.includes(formOpen) ? out.replace(formOpen, routeNotice + formOpen) : out;
  }

  if (evalMode) {
    const banner = `<div class="fr-lab-banner">RESEARCH / TEST ENVIRONMENT — USE SYNTHETIC DATA ONLY</div>`;
    out = out.replace("<body>", "<body>" + banner);
  }
  // REMOVED: audit item 7 — production notice emission deleted.

  return out;
}
