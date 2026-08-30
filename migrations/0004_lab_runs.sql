-- Migration 0004: D1-backed lab runs (FR-R4-029/030) + harness_runs alignment (FR-R4-069/070).
-- lab_runs is the authoritative server-side lab-run lifecycle record:
--   * id              — server-generated run id (runner never invents one)
--   * bind_token_hash — SHA-256 of the one-time browser bind capability
--   * recipe_json     — server-authorized defense recipe applied to bound sessions
--   * turnstile_required — per-run Turnstile experimental condition (FR-R4-025)
CREATE TABLE IF NOT EXISTS lab_runs (
    id TEXT PRIMARY KEY,
    bind_token_hash TEXT,
    session_id TEXT,
    recipe_json TEXT,
    turnstile_required INTEGER,
    status TEXT NOT NULL DEFAULT 'PENDING',
    created_at INTEGER NOT NULL,
    reconciled_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_lab_runs_session ON lab_runs(session_id);

-- Align harness_runs with canonical RunRecordV1 so admin experiment pages
-- can query fields that actually exist (FR-R4-069).
ALTER TABLE harness_runs ADD COLUMN run_id TEXT;
ALTER TABLE harness_runs ADD COLUMN disposition TEXT;
ALTER TABLE harness_runs ADD COLUMN recipe_id TEXT;
ALTER TABLE harness_runs ADD COLUMN canary_verified INTEGER;
ALTER TABLE harness_runs ADD COLUMN server_reconciled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE harness_runs ADD COLUMN profile_variant_id TEXT;
