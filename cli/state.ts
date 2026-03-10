// SQLite State Machine — local-only persistence
// 7 tables: wizard_runs, flywheel_runs, ssh_connections,
//           prompt_sends, phase_events, bead_snapshots, api_calls
// No ORM. Raw SQLite with prepared statements.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

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

export interface FlywheelRunRow {
  id: string;
  project_name: string | null;
  phase: string | null;
  started_at: string | null;
  completed_at: string | null;
  gate_passed_at: string | null;
  checkpoint_sha: string | null;
  cost_usd: number | null;
  notes: string | null;
}

export interface PhaseEventRow {
  id: number;
  run_id: string | null;
  event_type: string | null;
  phase_from: string | null;
  phase_to: string | null;
  actor: string | null;
  payload_json: string | null;
  timestamp: string;
}

export interface CurrentPhaseSnapshot {
  runId: string | null;
  projectName: string | null;
  phase: string | null;
  gatePassedAt: string | null;
  updatedAt: string | null;
}

export function initDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  return db;
}

export function listFlywheelRuns(
  db: Database.Database,
  limit = 50,
): FlywheelRunRow[] {
  return db
    .prepare(
      `
        SELECT
          id,
          project_name,
          phase,
          started_at,
          completed_at,
          gate_passed_at,
          checkpoint_sha,
          cost_usd,
          notes
        FROM flywheel_runs
        ORDER BY
          CASE WHEN completed_at IS NULL THEN 0 ELSE 1 END ASC,
          COALESCE(completed_at, gate_passed_at, started_at, id) DESC
        LIMIT ?
      `,
    )
    .all(limit) as FlywheelRunRow[];
}

export function getLatestFlywheelRun(
  db: Database.Database,
): FlywheelRunRow | null {
  const row = db
    .prepare(
      `
        SELECT
          id,
          project_name,
          phase,
          started_at,
          completed_at,
          gate_passed_at,
          checkpoint_sha,
          cost_usd,
          notes
        FROM flywheel_runs
        ORDER BY
          CASE WHEN completed_at IS NULL THEN 0 ELSE 1 END ASC,
          COALESCE(completed_at, gate_passed_at, started_at, id) DESC
        LIMIT 1
      `,
    )
    .get() as FlywheelRunRow | undefined;

  return row ?? null;
}

export function getCurrentFlywheelRun(
  db: Database.Database,
): FlywheelRunRow | null {
  const row = db
    .prepare(
      `
        SELECT
          id,
          project_name,
          phase,
          started_at,
          completed_at,
          gate_passed_at,
          checkpoint_sha,
          cost_usd,
          notes
        FROM flywheel_runs
        WHERE completed_at IS NULL
        ORDER BY COALESCE(gate_passed_at, started_at, id) DESC
        LIMIT 1
      `,
    )
    .get() as FlywheelRunRow | undefined;

  return row ?? null;
}

export function getLatestPhaseEvent(
  db: Database.Database,
  runId?: string,
): PhaseEventRow | null {
  const row = runId
    ? (db
        .prepare(
          `
            SELECT
              id,
              run_id,
              event_type,
              phase_from,
              phase_to,
              actor,
              payload_json,
              timestamp
            FROM phase_events
            WHERE run_id = ?
            ORDER BY timestamp DESC
            LIMIT 1
          `,
        )
        .get(runId) as PhaseEventRow | undefined)
    : (db
        .prepare(
          `
            SELECT
              id,
              run_id,
              event_type,
              phase_from,
              phase_to,
              actor,
              payload_json,
              timestamp
            FROM phase_events
            ORDER BY timestamp DESC
            LIMIT 1
          `,
        )
        .get() as PhaseEventRow | undefined);

  return row ?? null;
}

export function getCurrentPhaseSnapshot(
  db: Database.Database,
): CurrentPhaseSnapshot {
  const currentRun = getCurrentFlywheelRun(db) ?? getLatestFlywheelRun(db);
  const latestEvent = currentRun
    ? getLatestPhaseEvent(db, currentRun.id)
    : getLatestPhaseEvent(db);

  return {
    runId: currentRun?.id ?? latestEvent?.run_id ?? null,
    projectName: currentRun?.project_name ?? null,
    phase: currentRun?.phase ?? latestEvent?.phase_to ?? null,
    gatePassedAt: currentRun?.gate_passed_at ?? null,
    updatedAt:
      latestEvent?.timestamp ??
      currentRun?.completed_at ??
      currentRun?.started_at ??
      null,
  };
}

export { SCHEMA };
