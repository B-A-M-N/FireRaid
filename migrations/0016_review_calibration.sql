-- Migration 0016: review queue + calibration log.
--
-- FireRaid's advisory deployment surfaces every submission to a human
-- reviewer and records the reviewer's decision so thresholds can be
-- calibrated against real-world false positives / negatives.

CREATE TABLE IF NOT EXISTS review_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL UNIQUE,
    public_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    -- FireRaid's own assessment
    risk_score INTEGER NOT NULL,
    risk_tier TEXT NOT NULL,
    disposition TEXT NOT NULL,
    policy TEXT NOT NULL,
    reasons_json TEXT NOT NULL,
    -- Current review state
    status TEXT NOT NULL DEFAULT 'pending',
    reviewer_decision TEXT,
    reviewer_note TEXT,
    reviewed_at INTEGER,
    reviewed_by TEXT,
    FOREIGN KEY(session_id) REFERENCES sessions(id),
    FOREIGN KEY(public_id) REFERENCES submissions(public_id)
);

CREATE INDEX IF NOT EXISTS idx_review_queue_status ON review_queue(status);
CREATE INDEX IF NOT EXISTS idx_review_queue_tier ON review_queue(risk_tier);
CREATE INDEX IF NOT EXISTS idx_review_queue_created ON review_queue(created_at);

-- Calibration log: one row per finalized review, used to measure how
-- FireRaid thresholds align with human reviewers.
CREATE TABLE IF NOT EXISTS review_calibration (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    public_id TEXT NOT NULL,
    risk_score INTEGER NOT NULL,
    risk_tier TEXT NOT NULL,
    fireraid_disposition TEXT NOT NULL,
    reviewer_decision TEXT NOT NULL,
    agreed INTEGER NOT NULL,
    reviewed_at INTEGER NOT NULL,
    reviewer_id TEXT,
    note TEXT,
    FOREIGN KEY(session_id) REFERENCES sessions(id),
    FOREIGN KEY(public_id) REFERENCES submissions(public_id)
);

CREATE INDEX IF NOT EXISTS idx_review_calibration_agreed ON review_calibration(agreed);
CREATE INDEX IF NOT EXISTS idx_review_calibration_tier ON review_calibration(risk_tier);
