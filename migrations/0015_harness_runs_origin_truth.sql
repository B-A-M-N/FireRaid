-- Migration 0015: origin truth columns on harness_runs (P1-AUDIT-2 P1-14).
--
-- The lab-run ingest previously dropped the RunRecord's origin truth
-- (origin_account_created / origin_reconciled): admin experiment pages
-- rendered submissionRate with no way to know whether it was the PRIMARY
-- endpoint (origin-ledger experiments) or a labeled PROXY (worker
-- experiments). analyze.py already prints endpoint_basis; admin now can
-- label identically.
--
-- NULL = not measured (worker-mode record, or an origin probe failure that
-- recorded origin_reconciled=false). The columns mirror RunRecordV1Schema.
-- (Experiment-level coverage lives in the experiment.json declaration
-- sidecar, not per run — not a row column.)

ALTER TABLE harness_runs ADD COLUMN origin_account_created INTEGER;
ALTER TABLE harness_runs ADD COLUMN origin_reconciled INTEGER;
