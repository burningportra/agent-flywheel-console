// flywheel runs — list all past runs with phase, duration, cost
// flywheel replay <run-id> — render phase_events as human-readable narrative or JSON

import chalk from "chalk";
import { initDb, StateManager, type FlywheelRun, type PhaseEvent } from "./state.js";
import { phaseColor, truncate } from "./utils.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns a plain (un-colored) duration string for column-safe padding. */
export function durationStr(startedAt: string, completedAt: string | null): string {
  if (!completedAt) return "in progress";
  // Guard against negative durations from clock skew or corrupted timestamps:
  // Math.max(0, ...) ensures we never display "-45s" or similar nonsense.
  const ms = Math.max(
    0,
    new Date(completedAt).getTime() - new Date(startedAt).getTime()
  );
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

/** Returns a plain (un-colored) cost string for column-safe padding. */
export function costStr(costUsd: number | null): string {
  if (costUsd === null) return "—";
  return `$${costUsd.toFixed(4)}`;
}

// ─── Column constants ─────────────────────────────────────────────────────────
// Widths are for plain text; coloring is applied AFTER padding so ANSI codes
// don't inflate the visual column width.

const COL_ID      = 14; // 12-char hex prefix + "…" padded to 14
const COL_PROJECT = 20;
const COL_PHASE   = 10;
const COL_DUR     = 14;
const COL_COST    = 12;
const COL_NOTES   = 24; // truncated to keep total width manageable

// ─── List runs ────────────────────────────────────────────────────────────────

/** Print all flywheel runs as a table. */
export function listRuns(): void {
  const db = initDb();
  const state = new StateManager(db);
  const runs = state.listFlywheelRuns();

  if (runs.length === 0) {
    console.log(chalk.gray("No runs yet. Start with: flywheel new \"<idea>\""));
    return;
  }

  const totalWidth = COL_ID + COL_PROJECT + COL_PHASE + COL_DUR + COL_COST + COL_NOTES;
  const SEP = "─".repeat(totalWidth);

  console.log(
    chalk.bold(
      "ID".padEnd(COL_ID) +
      "PROJECT".padEnd(COL_PROJECT) +
      "PHASE".padEnd(COL_PHASE) +
      "DURATION".padEnd(COL_DUR) +
      "COST".padEnd(COL_COST) +
      "NOTES"
    )
  );
  console.log(SEP);

  for (const run of runs) {
    // Pad ALL columns with plain strings first, THEN apply color.
    // padEnd() counts bytes including ANSI escape codes, so coloring must
    // come last to keep column widths visually correct.
    const idRaw  = (run.id.slice(0, 12) + "…").padEnd(COL_ID);
    const proj   = truncate(run.project_name, COL_PROJECT - 2).padEnd(COL_PROJECT);
    const phase  = run.phase.padEnd(COL_PHASE);
    const dur    = durationStr(run.started_at, run.completed_at).padEnd(COL_DUR);
    const cost   = costStr(run.cost_usd).padEnd(COL_COST);
    const notes  = truncate(run.notes ?? "", COL_NOTES);

    console.log(
      chalk.dim(idRaw) +
      proj +
      phaseColor(phase) +
      (run.completed_at ? dur : chalk.dim(dur)) +
      (run.cost_usd !== null ? cost : chalk.dim(cost)) +
      chalk.dim(notes)
    );
  }

  console.log();
}

// ─── Replay ───────────────────────────────────────────────────────────────────

export interface ReplayOptions {
  format?: "text" | "json";
  /** ISO duration string or shorthand like "1h", "30m", "10s" */
  since?: string;
}

export function parseSinceDuration(since: string): string {
  // Try shorthand first: 1h, 30m, 10s
  const shorthand = since.match(/^(\d+)(h|m|s)$/);
  if (shorthand) {
    const value = parseInt(shorthand[1], 10);
    const unit = shorthand[2];
    const msPerUnit: Record<string, number> = { h: 3600000, m: 60000, s: 1000 };
    const cutoff = new Date(Date.now() - value * msPerUnit[unit]);
    return cutoff.toISOString();
  }

  // Validate as ISO 8601 date/datetime (must start with 4-digit year)
  if (/^\d{4}-\d{2}-\d{2}/.test(since)) {
    const ts = new Date(since);
    if (!Number.isNaN(ts.getTime())) return since;
  }

  throw new Error(
    `Invalid --since value: "${since}". Use ISO timestamp (e.g. 2026-03-10T03:00:00Z) or shorthand like "1h", "30m", "10s".`
  );
}

/** Render a run's events as text narrative or JSON. */
export function replayRun(runId: string, opts: ReplayOptions = {}): void {
  const db = initDb();
  const state = new StateManager(db);

  // Find run — try full ID first, then prefix match
  let run = state.getFlywheelRun(runId);
  if (!run) {
    // Try prefix match
    const all = state.listFlywheelRuns();
    run = all.find((r) => r.id.startsWith(runId));
  }
  if (!run) {
    console.error(chalk.red(`Run not found: ${runId}`));
    process.exit(1);
    return;
  }

  const sinceTs = opts.since ? parseSinceDuration(opts.since) : undefined;
  const events = state.getEvents(run.id, sinceTs);

  if (opts.format === "json") {
    console.log(JSON.stringify({ run, events }, null, 2));
    return;
  }

  // Text narrative
  console.log(chalk.bold(`\n📜 Replay: ${run.id}`));
  console.log(
    chalk.gray(
      `Project: ${run.project_name} | Phase: ${run.phase} | Started: ${run.started_at}`
    )
  );
  if (run.completed_at) {
    console.log(
      chalk.gray(`Completed: ${run.completed_at} | Cost: ${costStr(run.cost_usd)}`)
    );
  }
  console.log();

  if (events.length === 0) {
    console.log(chalk.gray(sinceTs ? `No events after ${sinceTs}` : "No events recorded."));
    return;
  }

  for (const event of events) {
    renderEvent(event);
  }

  console.log();
}

function renderEvent(event: PhaseEvent): void {
  const time = chalk.gray(event.timestamp.slice(11, 19)); // HH:MM:SS
  const actor = event.actor ? chalk.cyan(`@${event.actor}`) : "";
  const transition =
    event.phase_from && event.phase_to
      ? chalk.gray(` [${event.phase_from} → ${event.phase_to}]`)
      : "";

  let payload = "";
  if (event.payload_json) {
    try {
      const parsed = JSON.parse(event.payload_json);
      payload = " " + chalk.gray(JSON.stringify(parsed));
    } catch {
      payload = " " + chalk.gray(event.payload_json);
    }
  }

  console.log(
    `${time} ${chalk.bold(event.event_type)}${transition} ${actor}${payload}`
  );
}
