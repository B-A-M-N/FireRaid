-- Migration 0010: compact session interaction metrics (FR-R7-022).
--
-- Production can keep ONE compact per-session metrics row updated as each
-- telemetry batch lands, instead of persisting every raw event_batches row.
-- Lab mode still inserts raw event_batches for research; this table is the
-- authoritative scoring source at submit time when it is present.
--
-- The aggregator (src/telemetry/aggregate.ts) merges a single batch into the
-- session's existing row; the row's columns reflect the SAME shape the
-- aggregator returns (TelemetryMetrics), so submit reads it directly.
CREATE TABLE IF NOT EXISTS session_metrics (
    session_id TEXT PRIMARY KEY,
    -- Authoritative-at-submit facts (taken from the latest batch merge):
    direct_fill INTEGER NOT NULL DEFAULT 0,
    completion_ms INTEGER NOT NULL DEFAULT 0,
    page_to_submit_ms INTEGER NOT NULL DEFAULT 0,
    pointer_count INTEGER NOT NULL DEFAULT 0,
    focus_transitions INTEGER NOT NULL DEFAULT 0,
    key_count INTEGER NOT NULL DEFAULT 0,
    missing_interaction_sequence INTEGER,        -- NULL when not known
    no_pointer_events INTEGER,                   -- NULL when capture was off
    no_key_events INTEGER,                       -- NULL when capture was off
    capture_pointer INTEGER NOT NULL DEFAULT 0,
    capture_key INTEGER NOT NULL DEFAULT 0,
    -- Sequence bookkeeping (used to be idempotent against reordered batches):
    first_event_seq INTEGER NOT NULL DEFAULT -1,
    last_event_seq INTEGER NOT NULL DEFAULT -1,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
);

-- A small claimed-retention helper for the scheduled handler — sessions
-- whose final submission already happened are normally reaped by the
-- abandoned-sessions cleanup; the index lets the retention sweep scan
-- candidates cheaply.
CREATE INDEX IF NOT EXISTS idx_session_metrics_updated ON session_metrics(updated_at);
