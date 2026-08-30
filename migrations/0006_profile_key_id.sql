-- Migration 0006: profile key id (FR-R5-029 / FR-R6-044).
--
-- FR-R6-044: the profile_key_id column was briefly added by MODIFYING
-- migration 0001 in place. That fixes fresh installs but silently breaks
-- every database that already applied the original 0001 (applied migrations
-- are immutable). The lineage is restored: 0001 is back to its released
-- form, and the column is introduced HERE as a proper forward migration.
ALTER TABLE sessions ADD COLUMN profile_key_id TEXT;
