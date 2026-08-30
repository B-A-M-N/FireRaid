/**
 * Generic renderer interface (FR-R3-087).
 * Core produces DefenseArtifacts; the host adapter chooses how/where to inject them.
 */
export interface DefenseArtifacts {
  /** Hidden fields to add to the form (decoy fields). */
  hiddenFields: Array<{
    name: string;
    id: string;
  }>;
  
  /** Visible canary content (semantic notices). */
  canary: string | null;
  
  /** Where to inject the canary in the form. */
  canaryPlacement: "before-form" | "form-metadata" | "submit-adjacent" | "none";
  
  /** CSRF token field. */
  csrfToken: string;
  
  /** Turnstile widget configuration. */
  turnstile: {
    siteKey: string;
    action: string;
  } | null;
  
  /** Telemetry configuration for the client. */
  telemetryConfig: {
    captureFocus: boolean;
    captureInput: boolean;
    captureChange: boolean;
    capturePointer: boolean;
    captureKey: boolean;
    captureSubmit: boolean;
  };
}

/**
 * Host rendering interface.
 * Implementations can use HTMLRewriter (Cloudflare), string replacement, or DOM manipulation.
 */
export interface Renderer {
  render(artifacts: DefenseArtifacts, html: string): string;
}

/**
 * Generate defense artifacts from a profile.
 * This is the core function that produces everything needed for injection.
 */
export function generateArtifacts(
  profile: {
    version: number;
    profileId: string;
    sessionId: string;
    families: string[];
    semantic?: {
      templateId: string;
      placementId: string;
      nonce: string;
      mode: string;
    };
    decoyField?: {
      fieldName: string;
      elementId: string;
    };
    decoyRoute?: {
      endpointToken: string;
    };
    telemetry: {
      captureFocus: boolean;
      captureInput: boolean;
      captureChange: boolean;
      capturePointer: boolean;
      captureKey: boolean;
      captureSubmit: boolean;
    };
  },
  options: {
    csrfToken: string;
    turnstileSiteKey?: string;
    turnstileAction?: string;
  }
): DefenseArtifacts {
  return {
    hiddenFields: profile.decoyField
      ? [{ name: profile.decoyField.fieldName, id: profile.decoyField.elementId }]
      : [],
    canary: null, // Would be rendered from template
    canaryPlacement: profile.semantic ? "before-form" : "none",
    csrfToken: options.csrfToken,
    turnstile: options.turnstileSiteKey
      ? { siteKey: options.turnstileSiteKey, action: options.turnstileAction || "signup" }
      : null,
    telemetryConfig: profile.telemetry,
  };
}
