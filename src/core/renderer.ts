/**
 * HTML renderer — injects defense profile into the signup page.
 * FR-INV-003: client never decides classification.
 */
import type { DefenseProfile } from "../types/profile.js";
import { SEMANTIC_TEMPLATES, PLACEMENTS } from "./catalog.js";

const CANARY_CSS = `
.fr-canary { border-left: 3px solid #b45309; background: #fffbeb; padding: 0.6rem 0.9rem;
  margin: 0.75rem 0; font-size: 0.9rem; color: #92400e; border-radius: 4px; }
.fr-canary code { background: #fef3c7; padding: 0.1rem 0.3rem; border-radius: 3px; }
.fr-decoy { position: absolute !important; width: 1px !important; height: 1px !important;
  padding: 0 !important; margin: -1px !important; overflow: hidden !important;
  clip: rect(0, 0, 0, 0) !important; white-space: nowrap !important; border: 0 !important; }
.fr-result { margin-top: 1rem; padding: 1rem; border-radius: 4px; background: #f1f5f9; }
.fr-result-status { font-weight: 600; }
.fr-result-disposition { color: #64748b; }
.fr-result-error { color: #dc2626; }
`;

export function renderCanaryForProfile(profile: DefenseProfile): string {
  if (!profile.semantic) return "";
  const template = SEMANTIC_TEMPLATES.find((t) => t.id === profile.semantic!.templateId);
  const placement = PLACEMENTS.find((p) => p.id === profile.semantic!.placementId);
  if (!template || !placement) return "";

  const endpoint = profile.decoy
    ? `/c/${profile.decoy.endpointToken}`
    : "/c/<token>";

  const body = template.render({
    nonce: profile.semantic.nonce,
    endpoint,
    field: profile.decoy?.fieldName,
  });

  // P06 (non-rendered) is lab-only: hidden from visible UI.
  if (placement.position === "non-rendered") {
    return `<div data-fr-canary-id="${template.id}" class="fr-decoy" aria-hidden="true" tabindex="-1">${body}</div>`;
  }
  return `<div data-fr-canary-id="${template.id}" data-fr-placement="${placement.id}">${body}</div>`;
}

export function renderDecoyField(profile: DefenseProfile): string {
  if (!profile.decoy) return "";
  return `<input type="text" name="${profile.decoy.fieldName}" id="${profile.decoy.elementId}" ` +
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
  const decoy = renderDecoyField(profile);
  const csrf = renderCsrfField(csrfToken);
  const turnstile = turnstileSiteKey ? renderTurnstile(turnstileSiteKey) : "";

  let out = html;

  // Inject CSS
  out = out.replace("</head>", `<style>${CANARY_CSS}</style></head>`);

  // Inject CSRF + decoy + turnstile before </form>
  const formClose = "</form>";
  const injection = csrf + decoy + turnstile;
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

  // Lab banner
  if (labMode) {
    const banner = `<div class="fr-lab-banner">RESEARCH / TEST ENVIRONMENT — USE SYNTHETIC DATA ONLY</div>`;
    out = out.replace("<body>", "<body>" + banner);
  }

  return out;
}
