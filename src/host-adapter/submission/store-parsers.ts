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
 * parseable email field); disposition, score, and risk are REQUIRED in the
 * v2 record contract (FR-RR-26).
 */
function parseAssessment(value: unknown, expectedSessionId: string): AssessmentSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!nonEmptyString(v.sessionId) || v.sessionId !== expectedSessionId) return null;
  // FR-RR-54: the semantic enums are validated against their documented
  // ranges, not merely "non-empty string" — a store echoing
  // tier:"nonsense" cannot vouch for a risk snapshot.
  if (
    v.disposition !== "ACCEPT" &&
    v.disposition !== "REVIEW" &&
    v.disposition !== "QUARANTINE" &&
    v.disposition !== "REPLAY"
  ) {
    return null;
  }
  if (typeof v.score !== "number" || !Number.isFinite(v.score)) return null;
  if (typeof v.risk !== "object" || v.risk === null) return null;
  const risk = v.risk as Record<string, unknown>;
  const RISK_TIERS = ["LOW", "ELEVATED", "HIGH", "CAUSAL"]; // core/risk.ts RiskTier
  const CONFIDENCES = ["LOW", "MEDIUM", "HIGH"]; // core/risk.ts Confidence
  const ACTIONS = ["CONTINUE", "MANUAL_REVIEW", "SUPPRESS_AUTO_APPROVAL", "QUARANTINE"]; // DEFAULT_RISK_TIERS actions
  if (
    typeof risk.score !== "number" ||
    !Number.isFinite(risk.score) ||
    !RISK_TIERS.includes(risk.tier as string) ||
    !CONFIDENCES.includes(risk.confidence as string) ||
    !ACTIONS.includes(risk.recommendedAction as string) ||
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
    disposition: v.disposition,
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
 * Anything else is malformed: a version-DECLARING record without its
 * assessment is malformed (not degradable), and so is a version-LESS
 * record — the old legacy acceptance reproduced degraded replay (no
 * original score, no risk snapshot, no submitted identity) and has been
 * removed. v0.1.0 has not shipped, so there is no production data carrying
 * assessment-less records; a host with genuine pre-release data migrates it
 * with an explicit reconciliation tool, not by keeping the runtime's
 * acceptance window open forever. Returns null for anything else.
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
  return { outcome, assessment };
}

/**
 * FR-RR-22: parse a claim() result at the irreversible boundary.
 *
 * `claimed` requires a non-empty claimId AND an idempotencyKey that is
 * EXACTLY the key FireRaid requested — a store echoing a different (or
 * absent) key cannot vouch for the upstream deduplication contract, and
 * the forward must not proceed on it. `replay` is validated through
 * parseStoredRecord against the record field (the FR-RR-14 shape) — the
 * only replay shape accepted. `conflict` must be empty of
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
  | { kind: "replay"; outcome: FinalSubmissionOutcome; assessment: AssessmentSnapshot }
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
      // FR-RR-14 shape: { kind: "replay", record } — the ONLY replay shape
      // the claim seam accepts. A store still speaking the pre-FR-RR-14
      // `{ kind: "replay", outcome }` shape carries no parseable terminal
      // RECORD and cannot vouch for what it replays: malformed, fail closed.
      if (v.record === undefined) return null;
      const parsed = parseStoredRecord(v.record, sessionId);
      if (!parsed) return null;
      return { kind: "replay", outcome: parsed.outcome, assessment: parsed.assessment };
    }
    case "conflict":
      return { kind: "conflict" };
    default:
      return null;
  }
}
