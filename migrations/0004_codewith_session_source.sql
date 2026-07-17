-- Allow first-class Codewith session metadata/content in the shared Postgres registry.
--
-- This widens the existing sessions.source CHECK constraint only; it does not
-- rewrite rows, touch child tables, or change the (source, source_id) natural
-- key. Existing Codex and Codewith rollouts with the same provider-native id
-- therefore remain distinct by source-qualified identity.
--
-- Rollback guidance:
--   1. Confirm no Codewith rows remain:
--        SELECT COUNT(*) FROM sessions WHERE source = 'codewith';
--   2. If the count is zero, restore the narrower constraint:
--        ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_source_check;
--        ALTER TABLE sessions
--          ADD CONSTRAINT sessions_source_check
--          CHECK (source IN ('claude', 'codex', 'gemini')) NOT VALID;
--        ALTER TABLE sessions VALIDATE CONSTRAINT sessions_source_check;
--   3. If any Codewith rows exist, export/delete or migrate them before rollback.

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_source_check;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_source_check
  CHECK (source IN ('claude', 'codex', 'codewith', 'gemini')) NOT VALID;
ALTER TABLE sessions VALIDATE CONSTRAINT sessions_source_check;
