-- FireRaid D1 schema
-- Migration 0001: initial tables

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    profile_version INTEGER NOT NULL,
    profile_id TEXT NOT NULL,
    profile_hash TEXT NOT NULL,
    experiment_id TEXT,
    submitted INTEGER NOT NULL DEFAULT 0,
    final_score INTEGER,
    final_disposition TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_experiment ON sessions(experiment_id);

CREATE TABLE IF NOT EXISTS event_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    first_seq INTEGER NOT NULL,
    last_seq INTEGER NOT NULL,
    event_count INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_event_batches_session ON event_batches(session_id);

CREATE TABLE IF NOT EXISTS canary_hits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    family TEXT NOT NULL,
    evidence_class TEXT NOT NULL,
    expected_hash TEXT,
    observed_hash TEXT,
    verified INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_canary_hits_session ON canary_hits(session_id);

CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    turnstile_ok INTEGER NOT NULL,
    causal_hits INTEGER NOT NULL,
    strong_hits INTEGER NOT NULL,
    weak_hits INTEGER NOT NULL,
    risk_score INTEGER NOT NULL,
    disposition TEXT NOT NULL,
    form_fixture_id TEXT,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_submissions_session ON submissions(session_id);

CREATE TABLE IF NOT EXISTS experiments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    config_json TEXT NOT NULL,
    status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS harness_runs (
    id TEXT PRIMARY KEY,
    experiment_id TEXT NOT NULL,
    session_id TEXT,
    created_at INTEGER NOT NULL,
    agent TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_variant TEXT NOT NULL,
    profile_id TEXT,
    outcome TEXT,
    submitted INTEGER,
    canary_exposed INTEGER,
    canary_referenced INTEGER,
    canary_triggered INTEGER,
    elapsed_ms INTEGER,
    action_count INTEGER,
    error_code TEXT,
    FOREIGN KEY(experiment_id) REFERENCES experiments(id)
);
