-- Migration 0012: record which verification provider adjudicated a submission.
--
-- FR-P0-16: `turnstile_ok` previously encoded TWO facts ambiguously — "a
-- challenge was required" and "it passed". When Turnstile is disabled
-- (no TURNSTILE_SECRET_KEY), the submit path stores turnstile_ok=1 with no
-- challenge having run, which reads as a passed challenge in analysis.
-- The provider NAME disambiguates: "turnstile" = a real verification ran;
-- "none" = no provider configured (challenge not required), turnstile_ok
-- then reflects reality (no challenge), not a pass.

ALTER TABLE submissions ADD COLUMN verification_provider TEXT;

-- Existing rows predate the column: they were all written by the Turnstile
-- path (a submission row only ever existed after the challenge gate).
UPDATE submissions SET verification_provider = 'turnstile' WHERE verification_provider IS NULL;
