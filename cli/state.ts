// SQLite State Machine — local-only persistence
// 7 tables: wizard_runs, flywheel_runs, ssh_connections,
//           prompt_sends, phase_events, bead_snapshots, api_calls
// No ORM. Raw SQLite with prepared statements.

import Database from "better-sqlite3";
import { dirname, join } from "path";
import { mkdirSync } from "fs";
import { randomUUID } from "crypto";
import { defaultStateDbPath } from "./config.js";

// ─── Phase types ──────────────────────────────────────────────────────────────

export type Phase = "plan" | "beads" | "swarm" | "review" | "deploy";
export type RunStatus = "running" | "completed" | "failed" | "partial";
export type GateStatus = "waiting" | "passed" | "skipped";

// ─── Row types ────────────────────────────────────────────────────────────────

export interface WizardRun {
  id: string;
  project_name: string;
  idea: string;
  started_at: string;
  completed_at: string | null;
  plan_path: string | null;
  status: RunStatus;
}

export interface FlywheelRun {
  id: string;
  project_name: string;
  phase: Phase;
  started_at: string;
  completed_at: string | null;
  gate_passed_at: string | null;
  checkpoint_sha: string | null;
  cost_usd: number | null;
  notes: string | null;
}

export interface PhaseEvent {
  id: number;
  run_id: string;
  event_type: string;
  phase_from: Phase | null;
  phase_to: Phase | null;
  actor: string | null;
  payload_json: string | null;
  timestamp: string;
}

export interface BeadSnapshot {
  id: number;
  run_id: string;
  captured_at: string;
  bead_count: number;
  closed_count: number;
  blocked_count: number;
  bead_graph_json: string | null;
}

export interface ApiCall {
  id: number;
  run_id: string;
  phase: Phase;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  called_at: string;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

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
  run_id TEXT, -- references wizard_runs or flywheel_runs; not FK-constrained so wizard costs can be logged
  phase TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  called_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * Initialize (or open) the local SQLite database.
 * Path resolution order:
 *   1. explicit dbPath argument (used by tests: ':memory:' or a temp file)
 *   2. FLYWHEEL_STATE_DB env var (set to ':memory:' for lightweight unit tests)
 *   3. $FLYWHEEL_HOME/state.db   (set FLYWHEEL_HOME for per-test isolation)
 *   4. ~/.flywheel/state.db      (production default)
 */
export function initDb(dbPath?: string): Database.Database {
  const path = dbPath ?? defaultStateDbPath();
  // ':memory:' is a valid SQLite path — skip mkdir for in-memory DBs
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

// ─── StateManager ─────────────────────────────────────────────────────────────

export class StateManager {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // ── Wizard runs ─────────────────────────────────────────────────────────────

  createWizardRun(projectName: string, idea: string): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO wizard_runs (id, project_name, idea, started_at, status)
         VALUES (?, ?, ?, ?, 'running')`
      )
      .run(id, projectName, idea, now());
    return id;
  }

  completeWizardRun(id: string, planPath: string): void {
    this.db
      .prepare(
        `UPDATE wizard_runs SET status = 'completed', completed_at = ?, plan_path = ? WHERE id = ?`
      )
      .run(now(), planPath, id);
  }

  failWizardRun(id: string): void {
    this.db
      .prepare(
        `UPDATE wizard_runs SET status = 'failed', completed_at = ? WHERE id = ?`
      )
      .run(now(), id);
  }

  getWizardRun(id: string): WizardRun | undefined {
    return this.db
      .prepare(`SELECT * FROM wizard_runs WHERE id = ?`)
      .get(id) as WizardRun | undefined;
  }

  listWizardRuns(): WizardRun[] {
    return this.db
      .prepare(`SELECT * FROM wizard_runs ORDER BY started_at DESC`)
      .all() as WizardRun[];
  }

  // ── Flywheel runs ───────────────────────────────────────────────────────────

  createFlywheelRun(projectName: string, phase: Phase): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO flywheel_runs (id, project_name, phase, started_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(id, projectName, phase, now());
    return id;
  }

  setCheckpointSha(runId: string, checkpointSha: string): void {
    this.db
      .prepare(`UPDATE flywheel_runs SET checkpoint_sha = ? WHERE id = ?`)
      .run(checkpointSha, runId);
  }

  /** Advance the human gate to the next phase and optionally record a checkpoint SHA. */
  advanceGate(runId: string, nextPhase: Phase, checkpointSha?: string): void {
    // Capture current phase before overwriting it so the event log is complete.
    const currentRun = this.getFlywheelRun(runId);
    const previousPhase = currentRun?.phase;
    this.db
      .prepare(
        `UPDATE flywheel_runs SET gate_passed_at = ?, phase = ?, checkpoint_sha = ? WHERE id = ?`
      )
      .run(now(), nextPhase, checkpointSha ?? null, runId);
    this.logEvent(runId, "gate_advanced", { previousPhase, nextPhase, checkpointSha }, {
      phaseFrom: previousPhase,
      phaseTo: nextPhase,
      actor: "human",
    });
  }

  completeFlywheelRun(runId: string, costUsd: number, notes?: string): void {
    this.db
      .prepare(
        `UPDATE flywheel_runs SET completed_at = ?, cost_usd = ?, notes = ? WHERE id = ?`
      )
      .run(now(), costUsd, notes ?? null, runId);
  }

  getFlywheelRun(runId: string): FlywheelRun | undefined {
    return this.db
      .prepare(`SELECT * FROM flywheel_runs WHERE id = ?`)
      .get(runId) as FlywheelRun | undefined;
  }

  listFlywheelRuns(): FlywheelRun[] {
    return this.db
      .prepare(`SELECT * FROM flywheel_runs ORDER BY started_at DESC`)
      .all() as FlywheelRun[];
  }

  // ── SSH connections ─────────────────────────────────────────────────────────

  recordSshConnect(host: string): number {
    const result = this.db
      .prepare(`INSERT INTO ssh_connections (host, connected_at) VALUES (?, ?)`)
      .run(host, now());
    return result.lastInsertRowid as number;
  }

  recordSshDisconnect(id: number, latencyMs?: number): void {
    this.db
      .prepare(
        `UPDATE ssh_connections SET disconnected_at = ?, latency_ms = ? WHERE id = ?`
      )
      .run(now(), latencyMs ?? null, id);
  }

  // ── Phase events (append-only, source of truth for replay) ─────────────────

  logEvent(
    runId: string,
    eventType: string,
    payload?: unknown,
    opts?: { phaseFrom?: Phase; phaseTo?: Phase; actor?: string }
  ): void {
    this.db
      .prepare(
        `INSERT INTO phase_events (run_id, event_type, phase_from, phase_to, actor, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        runId,
        eventType,
        opts?.phaseFrom ?? null,
        opts?.phaseTo ?? null,
        opts?.actor ?? null,
        payload !== undefined ? JSON.stringify(payload) : null
      );
  }

  getEvents(runId: string, since?: string): PhaseEvent[] {
    if (since) {
      return this.db
        .prepare(
          `SELECT * FROM phase_events WHERE run_id = ? AND timestamp > ? ORDER BY timestamp ASC`
        )
        .all(runId, since) as PhaseEvent[];
    }
    return this.db
      .prepare(
        `SELECT * FROM phase_events WHERE run_id = ? ORDER BY timestamp ASC`
      )
      .all(runId) as PhaseEvent[];
  }

  /** Render events as a human-readable narrative (for flywheel replay). */
  renderNarrative(runId: string): string {
    const events = this.getEvents(runId);
    if (events.length === 0) return `No events found for run ${runId}.`;
    const lines = events.map((e) => {
      const ts = e.timestamp;
      let payload: unknown = null;
      if (e.payload_json) {
        try {
          payload = JSON.parse(e.payload_json);
        } catch {
          payload = e.payload_json;
        }
      }
      const detail = payload ? ` — ${JSON.stringify(payload)}` : "";
      return `[${ts}] ${e.event_type}${e.actor ? ` (${e.actor})` : ""}${detail}`;
    });
    return lines.join("\n");
  }

  // ── Bead snapshots ──────────────────────────────────────────────────────────

  captureBeadSnapshot(
    runId: string,
    stats: {
      bead_count: number;
      closed_count: number;
      blocked_count: number;
      bead_graph_json?: string;
    }
  ): void {
    this.db
      .prepare(
        `INSERT INTO bead_snapshots (run_id, bead_count, closed_count, blocked_count, bead_graph_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        runId,
        stats.bead_count,
        stats.closed_count,
        stats.blocked_count,
        stats.bead_graph_json ?? null
      );
  }

  getBeadSnapshots(runId: string): BeadSnapshot[] {
    return this.db
      .prepare(
        `SELECT * FROM bead_snapshots WHERE run_id = ? ORDER BY captured_at ASC`
      )
      .all(runId) as BeadSnapshot[];
  }

  /** Compute velocity: beads closed per hour over the last N snapshots. */
  beadVelocity(runId: string, windowSize = 5): number {
    // Fetch only the window we need — avoids a full table scan on long-running projects.
    const snapshots = this.db
      .prepare(
        `SELECT * FROM bead_snapshots WHERE run_id = ?
         ORDER BY captured_at DESC LIMIT ?`
      )
      .all(runId, windowSize) as BeadSnapshot[];
    if (snapshots.length < 2) return 0;
    // DESC order → oldest is last; reverse so first < last by time.
    const window = snapshots.slice().reverse();
    const first = window[0];
    const last = window[window.length - 1];
    const hours =
      (new Date(last.captured_at).getTime() -
        new Date(first.captured_at).getTime()) /
      3_600_000;
    // Guard against zero or negative (clock skew / out-of-order snapshots).
    if (hours <= 0) return 0;
    return Math.max(0, last.closed_count - first.closed_count) / hours;
  }

  // ── Cost tracking ───────────────────────────────────────────────────────────

  logApiCall(
    runId: string,
    phase: Phase,
    model: string,
    tokens: { input: number; output: number },
    costUsd: number
  ): void {
    this.db
      .prepare(
        `INSERT INTO api_calls (run_id, phase, model, input_tokens, output_tokens, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(runId, phase, model, tokens.input, tokens.output, costUsd);
  }

  getTotalCost(runId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM api_calls WHERE run_id = ?`
      )
      .get(runId) as { total: number };
    return row.total;
  }

  getApiCalls(runId: string): ApiCall[] {
    return this.db
      .prepare(
        `SELECT * FROM api_calls WHERE run_id = ? ORDER BY called_at ASC`
      )
      .all(runId) as ApiCall[];
  }

  // ── Prompt sends ────────────────────────────────────────────────────────────

  logPromptSend(
    promptName: string,
    agentTarget: string,
    runId?: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO prompt_sends (prompt_name, agent_target, sent_at, run_id)
         VALUES (?, ?, ?, ?)`
      )
      .run(promptName, agentTarget, now(), runId ?? null);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

export { SCHEMA };
