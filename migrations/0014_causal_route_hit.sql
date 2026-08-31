-- Migration 0014: compact production causal-hit state (P1-AUDIT-2 P1-9).
--
-- The Worker previously re-derived "did this session verify a canary route
-- hit" at SUBMIT time with `SELECT COUNT(*) FROM canary_hits WHERE
-- session_id = ? AND verified = 1` — an extra D1 round-trip on every
-- defended submission, only to collapse the answer to a boolean. The hit
-- already lands through a dedicated persistence path; capture the boolean
-- on the session row AT HIT TIME so submit reads it from the session SELECT
-- it performs anyway (zero additional reads).
--
-- NULL means "never hit" and stays the value for legacy rows; 1 is set
-- once and never cleared.

ALTER TABLE sessions ADD COLUMN causal_route_hit INTEGER;

-- Backfill from the authoritative hit log: any verified decoy-route hit
-- marks the session. Idempotent (WHERE causal_route_hit IS NULL).
UPDATE sessions
   SET causal_route_hit = 1
 WHERE causal_route_hit IS NULL
   AND id IN (SELECT session_id FROM canary_hits WHERE verified = 1);
