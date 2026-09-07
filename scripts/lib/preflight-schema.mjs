/**
 * FR-RR-18 — the release gate's preflight-response validation, as a pure
 * module so release-machinery.test.ts can exercise the REAL predicate set
 * behaviorally (release-verify.mjs is a CLI with top-level side effects and
 * cannot be imported from a test).
 *
 * The gate computes its truth from the PRIMITIVE observations (per-check
 * rows), never from a summary the producer could miscount, and validates
 * the producer's exit status in BOTH directions.
 */
export const EXPECTED_PREFLIGHT_CHECKS = new Set([
  "lab-mode",
  "production-db-id",
  "production-db-distinct",
  "production-hostname",
  "rate-limit-login-attested",
  "production-graph",
  "dry-run",
  "remote-migrations",
]);

/**
 * FR-RR-18 — validate a parsed preflight result against the schema AND the
 * producer's exit status. Lives here (not inline in release-verify.mjs)
 * so the release-machinery tests exercise the REAL validation, not a
 * source-grep of it.
 *
 * Returns { ok: true, preflight } with counts derived from the primitive
 * check rows, or { ok: false, error } naming the exact violation:
 *   - malformed row (missing name / unknown status / unknown EXTRA id)
 *   - duplicate id
 *   - missing expected id
 *   - summary counts disagreeing with the checks array
 *   - exit-status contradiction in EITHER direction:
 *       exit 0 + FAIL rows       → invalid
 *       exit nonzero + 0 FAILs   → invalid (the half-implemented half)
 */
export function validatePreflightResult(parsed, exitStatus) {
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.checks)) {
    return { ok: false, error: "preflight JSON lacks a checks array" };
  }
  const KNOWN_STATUSES = new Set(["PASS", "FAIL", "SKIP"]);
  const seenIds = new Set();
  let badCheck = null;
  for (const c of parsed.checks) {
    if (typeof c?.name !== "string" || c.name.length === 0) { badCheck = "a check lacks a name"; break; }
    // An UNKNOWN extra check id is as much a schema violation as a missing
    // expected one — a renamed/rogue producer must never ride through as
    // "absent = fine" alongside the expected set.
    if (!EXPECTED_PREFLIGHT_CHECKS.has(c.name)) { badCheck = `unknown check id: ${c.name}`; break; }
    if (seenIds.has(c.name)) { badCheck = `duplicate check id: ${c.name}`; break; }
    seenIds.add(c.name);
    if (!KNOWN_STATUSES.has(c.status)) { badCheck = `check ${c.name} has unknown status ${JSON.stringify(c.status)}`; break; }
  }
  if (badCheck) {
    return { ok: false, error: `preflight check invalid: ${badCheck}` };
  }
  const missing = [...EXPECTED_PREFLIGHT_CHECKS].filter((id) => !seenIds.has(id));
  if (missing.length > 0) {
    return { ok: false, error: `preflight check set is missing expected IDs: ${missing.join(", ")}` };
  }
  // Derive the counts. The producer's own tallies are still read — and
  // must AGREE — but the gate's decision uses these.
  const derivedFailed = parsed.checks.filter((c) => c.status === "FAIL").length;
  const derivedPassed = parsed.checks.filter((c) => c.status === "PASS").length;
  const derivedSkipped = parsed.checks.filter((c) => c.status === "SKIP").length;
  const countsAgree =
    parsed.failed === derivedFailed &&
    parsed.passed === derivedPassed &&
    parsed.skipped === derivedSkipped;
  // Exit-status consistency, BOTH directions. A zero exit with reported
  // FAILs is a producer bug, AND SO IS a non-zero exit with zero FAIL
  // rows — the half-implemented check accepted exactly the second
  // contradiction this comment promised to reject.
  const exitConsistent =
    (exitStatus === 0 && derivedFailed === 0) ||
    (exitStatus !== 0 && derivedFailed > 0);
  if (!countsAgree) {
    return {
      ok: false,
      error:
        `preflight summary counts disagree with its checks array ` +
        `(reported ${parsed.passed}p/${parsed.skipped}s/${parsed.failed}f, derived ${derivedPassed}p/${derivedSkipped}s/${derivedFailed}f)`,
    };
  }
  if (!exitConsistent) {
    return {
      ok: false,
      error:
        exitStatus === 0
          ? `preflight exited 0 while reporting ${derivedFailed} FAIL check(s)`
          : `preflight exited ${exitStatus} but its checks array contains ZERO FAIL rows (producer inconsistency)`,
    };
  }
  return {
    ok: true,
    preflight: {
      ...parsed,
      // The gate's truth, derived from the primitives.
      passed: derivedPassed,
      skipped: derivedSkipped,
      failed: derivedFailed,
      exit: exitStatus,
    },
  };
}
