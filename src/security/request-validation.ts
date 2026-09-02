/**
 * P1-AUDIT-2 (P1-3) — shared request validators for BOTH planes.
 *
 * The Worker submit route and the host middleware each validated inbound
 * signups independently, and the audit found the host side much weaker: no
 * form field caps, no key/value byte caps, a hand-rolled event normalizer
 * that fabricated timestamps, and no shared contract. Two "production"
 * implementations drifting on validation is exactly how the host plane
 * stops being evidence about the Worker plane.
 *
 * One implementation, both callers:
 *   - validateSignupForm()   — bounded form object (count/key/value caps)
 *   - validateTelemetryBatch — re-exported unchanged (routes/telemetry.ts)
 *
 * The submit-batch shape (submitInbound) is the full Worker /api/submit
 * body; the host urlencoded carrier folds into the same shape upstream of
 * these validators.
 */
import { payloadByteLength, validateTelemetryBatch, type ValidatedEvent } from "../telemetry/validate.js";

export { validateTelemetryBatch };
export type { ValidatedEvent };

/** FR-R6-025: bounded form validation (count / key length / value length). */
export const MAX_FORM_FIELDS = 64;
export const MAX_FORM_KEY_BYTES = 64;
export const MAX_FORM_VALUE_BYTES = 4096;

export type FormValidation =
  | { ok: true; form: Record<string, string> }
  | { ok: false; reason: string };

export function validateSignupForm(form: unknown): FormValidation {
  if (typeof form !== "object" || form === null || Array.isArray(form)) {
    return { ok: false, reason: "form must be an object" };
  }
  const entries = Object.entries(form as Record<string, unknown>);
  if (entries.length > MAX_FORM_FIELDS) {
    return { ok: false, reason: "too many form fields" };
  }
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (typeof value !== "string") {
      return { ok: false, reason: `form value for "${key}" is not a string` };
    }
    if (payloadByteLength(key) > MAX_FORM_KEY_BYTES) {
      return { ok: false, reason: "form key too long" };
    }
    if (payloadByteLength(value) > MAX_FORM_VALUE_BYTES) {
      return { ok: false, reason: `form value for "${key}" too long` };
    }
    out[key] = value;
  }
  return { ok: true, form: out };
}

/** Canonical /api/submit body shape shared by the Worker route and the host
 * middleware (the urlencoded carrier folds csrf into the top level). */
export interface SubmitInbound {
  csrf?: string;
  turnstileToken?: string;
  form?: Record<string, string>;
  eventBatch?: unknown;
}

/** Validate the full inbound submit body; returns the canonical shape. */
export type SubmitValidation =
  | { ok: true; body: SubmitInbound; events: ValidatedEvent[] }
  | { ok: false; reason: string; code: "FORM" | "TELEMETRY" | "TELEMETRY_SIZE" };

export function validateSubmitBody(raw: unknown): SubmitValidation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "body must be an object", code: "FORM" };
  }
  const b = raw as Record<string, unknown>;
  const formCheck = validateSignupForm(b.form ?? {});
  if (!formCheck.ok) {
    return { ok: false, reason: formCheck.reason, code: "FORM" };
  }
  let events: ValidatedEvent[] = [];
  if (b.eventBatch !== undefined) {
    if (!Array.isArray(b.eventBatch)) {
      return { ok: false, reason: "eventBatch must be an array", code: "TELEMETRY" };
    }
    const check = validateTelemetryBatch(b.eventBatch);
    if (!check.ok) {
      return {
        ok: false,
        reason: `telemetry rejected: ${check.code}${check.detail ? ` (${check.detail})` : ""}`,
        code: check.code === "TOO_MANY_EVENTS" ? "TELEMETRY_SIZE" : "TELEMETRY",
      };
    }
    events = check.events;
  }
  return {
    ok: true,
    body: {
      csrf: typeof b.csrf === "string" ? b.csrf : undefined,
      turnstileToken: typeof b.turnstileToken === "string" ? b.turnstileToken : undefined,
      form: formCheck.form,
      eventBatch: b.eventBatch,
    },
    events,
  };
}
