-- E5 lever 5: interaction-depth state columns for session_metrics.
--
-- The incremental state machine (src/telemetry/state.ts) gains three
-- causal interaction signals (zeroDwellFill / uniformCadence /
-- noBlurBeforeSubmit). Like 0011, the row stores RAW STATE, not
-- aggregates, so each signal needs its running state persisted:
--   - focus_dt_by_target_json: first-focus dt per target (zero-dwell)
--   - zero_dwell_violation:    any focused-then-instant input seen
--   - input_dts_json:          input event dts (uniform-cadence)
--   - blur_count:              blur events folded (no-blur-before-submit)
--
-- Backward compatibility: existing rows get the documented empty-state
-- defaults (empty maps/arrays, 0). The projections treat them exactly as
-- an empty fold — undefined when not scorable — so a pre-0017 session
-- scores no depth signals rather than a wrong one.

ALTER TABLE session_metrics ADD COLUMN focus_dt_by_target_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE session_metrics ADD COLUMN zero_dwell_violation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_metrics ADD COLUMN input_dts_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE session_metrics ADD COLUMN blur_count INTEGER NOT NULL DEFAULT 0;
