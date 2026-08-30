-- FR-P0-1: session_metrics v2 — true incremental aggregation state.
--
-- The 0010 schema stored AGGREGATES (per-batch outputs OR-ed / MAX-ed
-- together), which is not an aggregate function over the event stream:
--   - focus state is lost across batches (focused_targets is a Set);
--   - no_pointer_events / no_key_events used MAX, so a later pointer/key
--     event could never clear an earlier "none seen";
--   - completion_ms / page_to_submit_ms were never updated (submit_dt from
--     a later batch can't revise an earlier batch's 0);
--   - direct_fill OR is correct, but was derived from per-batch aggregates
--     that had already lost the focus context.
--
-- v2 stores the RAW STATE instead: the running aggregation state machine
-- lives in src/telemetry/state.ts and folds each new batch into this row.
-- A parity test (tests/unit/session-metrics-parity.test.ts) proves
-- fold-by-fold equals aggregateTelemetry(fullStream) for every batch
-- boundary partition.

DROP TABLE IF EXISTS session_metrics;

CREATE TABLE session_metrics (
  session_id TEXT PRIMARY KEY,
  -- Running aggregation state (fold of every accepted event, in seq order).
  focused_targets_json TEXT NOT NULL DEFAULT '[]',
  pointer_count INTEGER NOT NULL DEFAULT 0,
  focus_transitions INTEGER NOT NULL DEFAULT 0,
  key_count INTEGER NOT NULL DEFAULT 0,
  input_without_focus INTEGER NOT NULL DEFAULT 0,
  first_event_dt INTEGER,
  first_meaningful_dt INTEGER,
  submit_dt INTEGER,
  last_event_dt INTEGER,
  -- Capture config actually in force (from the profile, not assumed).
  capture_pointer INTEGER NOT NULL DEFAULT 0,
  capture_key INTEGER NOT NULL DEFAULT 0,
  -- Watermark: highest seq folded into this row.
  last_event_seq INTEGER NOT NULL DEFAULT -1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_session_metrics_updated ON session_metrics(updated_at);
