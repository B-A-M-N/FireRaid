-- Migration 0002: Add policy and reasons_json columns to submissions
-- This supports full decision auditability (FR-R2-005)

ALTER TABLE submissions ADD COLUMN policy TEXT NOT NULL DEFAULT 'default-v1';
ALTER TABLE submissions ADD COLUMN reasons_json TEXT NOT NULL DEFAULT '[]';
