# FR-POST-R6-P8 — Provenance completion proof

## Claim

Every RunRecord carries real, complete provenance; unavailable values are
OMITTED, never fabricated.

## Gaps found and fixed

1. browser_name / browser_version: declared in RunRecordV1Schema, captured
   NOWHERE — every Playwright-based trial recorded null engines. Now
   resolved once per process from the installed browser binary
   (--version), name/version split, omitted when unresolvable. Verified
   live: human trial → "Google Chrome for Testing / 151.0.7922.34";
   raw-http trial → correctly absent (its engine is fetch, not Chromium).
   (Intermediate bug: the spread first emitted name/version — keys the
   schema strips, caught by a provenance smoke run, fixed, re-proven.)
2. browser-use worker provenance: worker now reports python /
   browser-use / Playwright versions + the browser IT drove; TS adapter
   passes through as [PROVENANCE] JSON in the transcript. E4-blocked
   until browser-use is installed, but the channel is wired.
3. Manifest hash: canonical key-sorted JSON (closes FR-R5-012's
   future-work note). Verified: scrambled-key copy of a manifest hashes
   IDENTICALLY (ae3f2361… both ways), and matches the runner's printed
   hash.

## Per-run provenance now present (verified in pilot + smoke records)

fireraid_git_sha, fireraid_dirty (false — committed tree), manifest_hash
(canonical), node_version, adapter_version, temperature, max_tokens,
browser_name + browser_version (Playwright adapters), model (resolved
concrete id or "none" for model-agnostic agents), lab_mode.

## Environment snapshot

harness/evidence/provenance.json — Node 22.22.3, wrangler 4.127.1,
Playwright 1.62.1, Chrome for Testing 151.0.7922.34, system Python
3.10.12 + python-playwright 1.57.0, browser-use NOT installed, all
FIRERAID_LLM_* unset (fail-closed policy noted).

## Status: PROVEN INTEGRATION (E3) for per-run capture; environment-level
values PROVEN LOCAL. LLM model ids remain honestly absent (credentials
unavailable) — the mission's "do not fabricate" rule enforced in code.
