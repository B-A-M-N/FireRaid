-- Migration 0009: holdout_mode on lab runs (FR-POST-R6-P5).
-- The manifest's holdout_mode flag is a TREATMENT identity component: it
-- restricts the random semantic-template pool to the holdout partition
-- (FR-R5-034). Persisted per lab run so every reconstruction path (signup
-- render, submit scoring, canary verification, lab truth) derives the SAME
-- profile — reconstruction with a different holdout flag would drift the
-- template draw. Mirrors turnstile_required's persistence pattern.
ALTER TABLE lab_runs ADD COLUMN holdout_mode INTEGER;
