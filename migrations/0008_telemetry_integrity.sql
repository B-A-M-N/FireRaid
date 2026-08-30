-- Migration 0008: telemetry integrity (FR-R6-031/032).
--
-- FR-R6-031: sessions.last_event_seq (0005) is NULL for new rows, and in SQL
-- `NULL < value` is NULL — so the first watermark claim never succeeded and
-- every fresh session 409'd on its first /api/events batch. SQLite cannot
-- ALTER a column's default; the compare/update logic now uses
-- COALESCE(last_event_seq, -1) (see routes/telemetry.ts), and this index
-- supports the watermark lookup.
CREATE INDEX IF NOT EXISTS idx_sessions_last_event_seq ON sessions(last_event_seq);

-- FR-R6-032: batch identity — a (session, first_seq, last_seq) tuple is
-- insertable exactly once, making exact replays of an accepted batch
-- detectable at the storage layer (BATCH_IDENTITY_CONFLICT) instead of
-- trusting application code alone.
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_batches_identity
  ON event_batches(session_id, first_seq, last_seq);
