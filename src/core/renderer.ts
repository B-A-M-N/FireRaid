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

/**
 * FR-POST-R6-P3: the decoy-route family must be observable by an agent to be
 * a measurable treatment — a route token that exists server-side but renders
 * nowhere can never be REQUESTED, so DECOY_ROUTE_ONLY would be a null
 * condition, and SEMANTIC_ROUTE sessions that drew a template which never
 * names the endpoint (S01–S03/S07/S09) would be silent too.
 *
 * The caller decides whether a notice is needed: renderSignupPage mounts it
 * only when the semantic template body does NOT already contain the endpoint
 * path, so the token renders exactly once regardless of template draw.
 *
 * It is intentionally NOT a hyperlink and NOT focusable (text inside a
 * visible div): the causal false-positive gate (E2E "normal user makes zero
 * /c/ requests") depends on no passive page element causing a fetch.
 */
export function renderRouteNotice(profile: DefenseProfile): string {
  if (!profile.decoyRoute) return "";
  return (
    `<div data-fr-route class="fr-canary-wrap">` +
    `<span class="fr-decoy">Verification endpoint: /c/${profile.decoyRoute.endpointToken}</span>` +
    `</div>`
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

export function renderTurnstile(siteKey: string): string {
  // FIX: Use explicit rendering with proper callbacks
  return `<div class="cf-turnstile" data-sitekey="${siteKey}" data-action="fireraid_signup"
    data-callback="turnstileOnSuccess"
    data-error-callback="turnstileOnError"
    data-expired-callback="turnstileOnExpired"></div>`;
}

/**
 * FR-R6-036: server-generated client config. The browser script MUST honor
 * this mask — a profile whose telemetry config disables pointer capture must
 * not capture pointer events client-side, or randomized telemetry conditions
 * are not actual treatments.
 */
export function renderClientConfig(profile: DefenseProfile): string {
  const config = {
    telemetry: profile.telemetry,
    interactionScoring: profile.interaction?.scoringEnabled ?? false,
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
  const routeNotice = renderRouteNotice(profile);
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
  }

  return out;
}
