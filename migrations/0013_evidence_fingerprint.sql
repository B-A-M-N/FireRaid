-- Migration 0013: idempotent evidence replay (P1-AUDIT-2 P1-26).
--
-- The concurrent-loser hardening (OR IGNORE submissions + SELECT-form
-- evidence inserts) makes the loser of a raced finalize write nothing.
-- One hole remained: an EXACT replay of the same finalize batch (same
-- public_id, e.g. a client retry that re-reaches the route) would find
-- its submission row via the evidence SELECT and double-append evidence.
-- A fingerprint over (submission_id, evidence_class, source, weight,
-- verified) + ON CONFLICT DO NOTHING makes the insert idempotent: the
-- same evidence on the same submission lands exactly once, regardless of
-- how many times the finalize batch replays.

-- Normalize prior rows into the fingerprint's shape (no-op semantically —
-- it just makes the column total) and add the uniqueness that the insert's
-- conflict target names.
ALTER TABLE submission_evidence ADD COLUMN weight_verified TEXT;

-- Backfill: canonical text form of (weight, verified) for existing rows.
UPDATE submission_evidence
   SET weight_verified = weight || ':' || (verified = 1)
 WHERE weight_verified IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_fingerprint
ON submission_evidence(submission_id, evidence_class, source, weight_verified);
