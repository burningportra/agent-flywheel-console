// SQLite State Machine — local-only persistence
// 7 tables: wizard_runs, flywheel_runs, ssh_connections,
//           prompt_sends, phase_events, bead_snapshots, api_calls
// No ORM. Raw SQLite with prepared statements.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wizard_runs (
  id TEXT PRIMARY KEY,
  project_name TEXT,
  idea TEXT,
  started_at TEXT,
  completed_at TEXT,
  plan_path TEXT,
  status TEXT -- running | completed | failed | partial
);

CREATE TABLE IF NOT EXISTS flywheel_runs (
  id TEXT PRIMARY KEY,
  project_name TEXT,
  phase TEXT,
  started_at TEXT,
  completed_at TEXT,
  gate_passed_at TEXT,
  checkpoint_sha TEXT,
  cost_usd REAL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS ssh_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT,
  connected_at TEXT,
  disconnected_at TEXT,
  latency_ms INTEGER
);

CREATE TABLE IF NOT EXISTS prompt_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_name TEXT,
  agent_target TEXT,
  sent_at TEXT,
  run_id TEXT REFERENCES flywheel_runs(id)
);

CREATE TABLE IF NOT EXISTS phase_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT REFERENCES flywheel_runs(id),
  event_type TEXT,
  phase_from TEXT,
  phase_to TEXT,
  actor TEXT,
  payload_json TEXT,
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_phase_events_run_ts ON phase_events(run_id, timestamp);

CREATE TABLE IF NOT EXISTS bead_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT REFERENCES flywheel_runs(id),
  captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  bead_count INTEGER,
  closed_count INTEGER,
  blocked_count INTEGER,
  bead_graph_json TEXT
);

CREATE TABLE IF NOT EXISTS api_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT REFERENCES flywheel_runs(id),
  phase TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  called_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

// TODO: Implement state manager
// - initDb() — run schema, return db handle
// - Phase gate state machine
// - Event logging (append-only to phase_events)
// - Bead snapshot persistence
// - Cost tracking wrapper

export { SCHEMA };
