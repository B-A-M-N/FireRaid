-- Migration 0005: lab run lifecycle + atomic telemetry watermark (FR-R5).
-- lab_runs gains: server-side provenance (experiment/trial/recipe), expiry
-- bookkeeping, and terminal state tracking (FR-R5-036/037).
ALTER TABLE lab_runs ADD COLUMN experiment_id TEXT;
ALTER TABLE lab_runs ADD COLUMN trial_key TEXT;
ALTER TABLE lab_runs ADD COLUMN recipe_id TEXT;
ALTER TABLE lab_runs ADD COLUMN outcome TEXT;
ALTER TABLE lab_runs ADD COLUMN expires_at INTEGER;
ALTER TABLE lab_runs ADD COLUMN terminal_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_lab_runs_experiment ON lab_runs(experiment_id);
CREATE INDEX IF NOT EXISTS idx_lab_runs_expires ON lab_runs(expires_at);

-- FR-R5-018: per-session telemetry watermark claimed atomically via
-- conditional UPDATE (replaces race-prone SELECT MAX(last_seq) then INSERT).
ALTER TABLE sessions ADD COLUMN last_event_seq INTEGER;
