-- Migration 0003: canary hit deduplication at the storage layer (FR-R4-004).
-- At most one VERIFIED hit per (session, family, expected token hash).
-- Unverified rows (expected_hash NULL) are never collapsed: SQLite UNIQUE
-- treats NULLs as distinct. The application-layer SELECT-then-INSERT pre-check
-- in canary.ts is replaced by INSERT OR IGNORE relying on this index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_canary_unique_verified
ON canary_hits(session_id, family, expected_hash);
