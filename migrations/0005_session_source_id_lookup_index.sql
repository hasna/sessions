-- Speed unqualified provider-native session id exact/prefix lookups.
--
-- The natural key index is ordered as (source, source_id), which is ideal for
-- source-qualified lookups but cannot lead unqualified source_id probes.
-- Keep this as a forward migration so checksum-tracked historical migrations
-- remain immutable.

CREATE INDEX IF NOT EXISTS idx_sessions_source_id ON sessions(source_id);
