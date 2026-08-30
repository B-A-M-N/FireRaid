-- Migration 0007: lab run lifecycle timestamps (FR-R6-014).
-- bound_at: when the run transitioned PENDING -> BOUND (bind time, not
-- creation time) so BOUND abandonment TTLs measure from actual binding.
ALTER TABLE lab_runs ADD COLUMN bound_at INTEGER;
ALTER TABLE lab_runs ADD COLUMN completed_at INTEGER;
