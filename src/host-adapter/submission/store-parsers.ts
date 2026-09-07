/**
 * FR-RR-22 / FR-RR-23 — STRICT runtime parsers for the host submission
 * store's results.
 *
 * The submission store is an UNTRUSTED runtime seam: `HostSubmissionStore`
 * is a host-implemented interface, so TypeScript's unions protect nothing
 * at runtime — a JavaScript host can return `{ kind: "claimed" }` with no
 * claimId, a replay record with an invented outcome kind, or `null`
 * outright. Everything that crosses this seam and guards the irreversible
 * forward is parsed here, field by field, with no casts-as-validation.
 *
 * Failure discipline: a malformed result is an OPERATIONAL error
 * (infrastructure, never the applicant's fault) and fails the forward
 * path CLOSED — the coordinator maps a null parse to a forward-failed
 * outcome; the upstream is never called on data nobody could validate.
 */

import type {
  HostSubmissionClaim,
  FinalSubmissionOutcome,
  AssessmentSnapshot,
  DecisionDisposition,
  FinalSubmissionRecord,
} from "../interface.js";

/** Non-empty string with no whitespace-only degenerates (FR-RR-54: trim —
 * a string of spaces is empty for admission purposes). */
function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** The documented business-rejection range: a 4xx answer from the upstream. */
function isBusinessStatus(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 400 && v < 500;
}

/**
 * FR-RR-23: validate an assessment snapshot independently — the parser that
 * owns the outcome kind must not be the one that vouches for the snapshot's
 * fields. `submittedEmail` stays optional (not every evaluation saw a
 * parseable email field); both dispositions, score, and risk are REQUIRED
 * in the V2 record contract (FR-RR-26).
 */
function isDecisionDisposition(value: unknown): value is DecisionDisposition {
  return value === "ACCEPT" || value === "REVIEW" || value === "QUARANTINE";
}

function parseAssessment(value: unknown, expectedSessionId: string): AssessmentSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!nonEmptyString(v.sessionId) || v.sessionId !== expectedSessionId) return null;
  // FR-RR-54: the semantic enums are validated against their documented
  // ranges, not merely "non-empty string" — a store echoing
  // tier:"nonsense" cannot vouch for a risk snapshot.
  if (!isDecisionDisposition(v.coreDisposition) || !isDecisionDisposition(v.runtimeDisposition)) return null;
  if (v.submittedEmail !== undefined && typeof v.submittedEmail !== "string") return null;
  if (typeof v.score !== "number" || !Number.isFinite(v.score)) return null;
  if (typeof v.risk !== "object" || v.risk === null) return null;
  const risk = v.risk as Record<string, unknown>;
  const RISK_TIERS = ["LOW", "ELEVATED", "HIGH", "CAUSAL"]; // core/risk.ts RiskTier
  const CONFIDENCES = ["LOW", "MEDIUM", "HIGH"]; // core/risk.ts Confidence
  if (
    typeof risk.score !== "number" ||
    !Number.isFinite(risk.score) ||
    !RISK_TIERS.includes(risk.tier as string) ||
    !CONFIDENCES.includes(risk.confidence as string) ||
    !nonEmptyString(risk.recommendedAction) ||
    !Array.isArray(risk.evidence)
  ) {
    return null;
  }
  for (const e of risk.evidence) {
    if (typeof e !== "object" || e === null) return null;
    const ev = e as Record<string, unknown>;
    if (
      (ev.class !== "A" && ev.class !== "B" && ev.class !== "C") ||
      !nonEmptyString(ev.source) ||
      typeof ev.weight !== "number" ||
      !Number.isFinite(ev.weight) ||
      typeof ev.verified !== "boolean" ||
      !nonEmptyString(ev.description)
    ) {
      return null;
    }
  }
  return {
    sessionId: v.sessionId,
    ...(typeof v.submittedEmail === "string" ? { submittedEmail: v.submittedEmail } : {}),
    coreDisposition: v.coreDisposition,
    runtimeDisposition: v.runtimeDisposition,
    score: v.score,
    risk: risk as AssessmentSnapshot["risk"],
  };
}

/**
 * FR-RR-23: the ONE validator for a terminal record read back from the
 * store. The outcome-kind whitelist is EXACT — `created`,
 * `business-rejected` (integer status in the documented 4xx range),
 * `queued-for-retry` (non-empty retryId), `decision-denied`
 * (REVIEW|QUARANTINE). Anything else — including an invented
 * `"fabricated-success"` kind a broken JS store can hand back — is null.
 * `transport-failure` is deliberately NOT accepted here: a recorded
 * transport failure releases the claim and never becomes a replayable
 * terminal receipt.
 */
export function parseFinalSubmissionOutcome(value: unknown): FinalSubmissionOutcome | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  switch (v.kind) {
    case "created":
      return { kind: "created" };
    case "business-rejected":
      return isBusinessStatus(v.status) ? { kind: "business-rejected", status: v.status } : null;
    case "queued-for-retry":
      return nonEmptyString(v.retryId) ? { kind: "queued-for-retry", retryId: v.retryId } : null;
    case "decision-denied":
      return (v.disposition === "REVIEW" || v.disposition === "QUARANTINE")
        ? { kind: "decision-denied", disposition: v.disposition }
        : null;
    default:
      return null;
  }
}

/**
 * Parse a terminal record. FR-RR-46: EXACTLY one shape is accepted —
 *
 *   v2: { version: 2, outcome, assessment } — the only shape this
 *   codebase writes (FR-RR-26), mandatory snapshot included.
 *
 * Anything else is malformed: the assessment is mandatory, the record must
 * explicitly declare version 2, and all outcome/assessment fields must pass
 * their validators. Returns null for anything else.
 */
export function parseStoredRecord(
  value: unknown,
  sessionId: string | undefined
): { outcome: FinalSubmissionOutcome; assessment: AssessmentSnapshot } | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 2) return null; // the v2 contract, exactly — no legacy window
  const outcome = parseFinalSubmissionOutcome(v.outcome);
  if (!outcome) return null;
  const assessment = parseAssessment(v.assessment, sessionId ?? "");
  if (!assessment) return null;
  if (outcome.kind === "decision-denied" && assessment.runtimeDisposition !== outcome.disposition) return null;
  return { outcome, assessment };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => sameValue(value, b[index]));
  }
  const ak = Object.keys(a as Record<string, unknown>);
  const bk = Object.keys(b as Record<string, unknown>);
  if (ak.length !== bk.length || ak.some((key) => !Object.prototype.hasOwnProperty.call(b, key))) return false;
  return ak.every((key) => sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

export type ParsedFinalizeDecisionResult =
  | { kind: "stored"; record: FinalSubmissionRecord }
  | { kind: "replay"; record: FinalSubmissionRecord }
  | { kind: "conflict"; state: "forward-claimed" | "forward-uncertain" };

/**
 * Strictly validate the result of finalizeDecision at the untrusted host
 * boundary. `stored` is an atomic persistence acknowledgement: it must echo
 * the exact decision-denied v2 record FireRaid submitted. `replay` may carry
 * any valid terminal outcome because a forward can win the race between the
 * initial lookup and this finalizer.
 */
export function parseFinalizeDecisionResult(
  value: unknown,
  sessionId: string,
  expectedRecord: FinalSubmissionRecord
): ParsedFinalizeDecisionResult | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.kind === "conflict") {
    return v.state === "forward-claimed" || v.state === "forward-uncertain"
      ? { kind: "conflict", state: v.state }
      : null;
  }
  if (v.kind !== "stored" && v.kind !== "replay") return null;
  const rawRecord = v.record;
  const parsed = parseStoredRecord(rawRecord, sessionId);
  if (!parsed) return null;
  const record: FinalSubmissionRecord = { version: 2, outcome: parsed.outcome, assessment: parsed.assessment };
  if (v.kind === "stored") {
    if (parsed.outcome.kind !== "decision-denied" || !sameValue(rawRecord, expectedRecord)) return null;
    return { kind: "stored", record };
  }
  return { kind: "replay", record };
}

/**
 * FR-RR-22: parse a claim() result at the irreversible boundary.
 *
 * `claimed` requires a non-empty claimId AND an idempotencyKey that is
 * EXACTLY the key FireRaid requested — a store echoing a different (or
 * absent) key cannot vouch for the upstream deduplication contract, and
 * the forward must not proceed on it. `replay` is validated through
 * parseStoredRecord against its V2 record field. `conflict` must be empty of
 * meaningful payload (any object with kind "conflict" and nothing else
 * to read). Everything else — including null, true, or an unknown kind —
 * is null, and the caller fails closed.
 */
export function parseClaimResult(
  value: unknown,
  expectedIdempotencyKey: string,
  sessionId: string
):
  | { kind: "claimed"; claim: HostSubmissionClaim }
  | { kind: "replay"; record: FinalSubmissionRecord }
  | { kind: "conflict" }
  | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  switch (v.kind) {
    case "claimed": {
      if (!nonEmptyString(v.claimId)) return null;
      if (!nonEmptyString(v.idempotencyKey)) return null;
      if (v.idempotencyKey !== expectedIdempotencyKey) return null;
      return { kind: "claimed", claim: { kind: "claimed", claimId: v.claimId, idempotencyKey: v.idempotencyKey } };
    }
    case "replay": {
      // The claim seam accepts only { kind: "replay", record } with a
      // complete V2 terminal record; an outcome-only answer is malformed.
      if (v.record === undefined) return null;
      const parsed = parseStoredRecord(v.record, sessionId);
      if (!parsed) return null;
      return { kind: "replay", record: { version: 2, outcome: parsed.outcome, assessment: parsed.assessment } };
    }
    case "conflict":
      return { kind: "conflict" };
    default:
      return null;
  }
}
