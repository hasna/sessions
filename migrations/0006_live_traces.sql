-- Bounded, redacted, operator-visible event streams for OpenLoops workflow runs.

CREATE TABLE IF NOT EXISTS live_traces (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'failed', 'cancelled')),
  workflow_run_id TEXT NOT NULL,
  loop_run_id TEXT NOT NULL,
  step_id TEXT,
  task_id TEXT,
  provider TEXT,
  worktree_path TEXT,
  worktree_policy TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  next_sequence BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS live_trace_events (
  trace_id TEXT NOT NULL REFERENCES live_traces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('message', 'tool_call', 'command', 'validation', 'verifier', 'status')),
  level TEXT NOT NULL CHECK(level IN ('info', 'warn', 'error')),
  message TEXT NOT NULL,
  event_status TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  workflow_run_id TEXT NOT NULL,
  loop_run_id TEXT NOT NULL,
  step_id TEXT,
  task_id TEXT,
  provider TEXT,
  worktree_path TEXT,
  worktree_policy TEXT,
  occurred_at TEXT NOT NULL,
  stored_at TEXT NOT NULL,
  redacted BOOLEAN NOT NULL DEFAULT FALSE,
  truncated BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (trace_id, id),
  UNIQUE(trace_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_live_traces_workflow_run ON live_traces(workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_live_traces_loop_run ON live_traces(loop_run_id);
CREATE INDEX IF NOT EXISTS idx_live_traces_expires_at ON live_traces(expires_at);
CREATE INDEX IF NOT EXISTS idx_live_trace_events_sequence ON live_trace_events(trace_id, sequence);
