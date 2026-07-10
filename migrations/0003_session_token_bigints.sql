-- Preserve large aggregate session token totals from imported provider logs.
ALTER TABLE sessions
  ALTER COLUMN total_input_tokens TYPE BIGINT,
  ALTER COLUMN total_output_tokens TYPE BIGINT,
  ALTER COLUMN total_cache_read_tokens TYPE BIGINT,
  ALTER COLUMN total_cache_write_tokens TYPE BIGINT,
  ALTER COLUMN total_thinking_tokens TYPE BIGINT;
