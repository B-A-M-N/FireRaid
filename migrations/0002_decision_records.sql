-- FireRaid D1 schema
-- Migration 0002: decision records + evidence persistence + verification attempts

ALTER TABLE submissions ADD COLUMN policy TEXT;
ALTER TABLE submissions ADD COLUMN reasons_json TEXT;

-- FR-R4-008/009: submissions get an application-generated UUID so the server
-- knows the id before executing SQL, letting the session claim, submission
-- INSERT, and evidence INSERTs commit in ONE D1 batch. New writes use TEXT ids;
-- the autoincrement id from migration 0001 remains for legacy rows.
ALTER TABLE submissions ADD COLUMN public_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_public_id ON submissions(public_id);

CREATE TABLE IF NOT EXISTS submission_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL,
    evidence_class TEXT NOT NULL,
    source TEXT NOT NULL,
    weight INTEGER NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT,
    FOREIGN KEY(submission_id) REFERENCES submissions(id)
);

CREATE INDEX IF NOT EXISTS idx_submission_evidence_submission ON submission_evidence(submission_id);

CREATE TABLE IF NOT EXISTS verification_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    provider TEXT NOT NULL,
    result TEXT NOT NULL,
    error_codes_json TEXT,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_verification_attempts_session ON verification_attempts(session_id);

-- Enforce exactly one final submission per session
CREATE UNIQUE INDEX IF NOT EXISTS idx_submission_session_unique ON submissions(session_id);
