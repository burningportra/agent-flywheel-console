// flywheel beads — Phase 2 bead management (generate, refine, triage, history)
// Beads: 2A generate → 2B refine → 2C triage

import chalk from "chalk";

import { RemoteCommandRunner } from "./remote.js";
import { SSHManager } from "./ssh.js";
import { initDb, StateManager } from "./state.js";
import { shellQuote } from "./utils.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BeadTriageOptions {
  /** How many top picks to show (default: 5) */
  top?: number;
}

export interface BeadHistoryOptions {
  /** ISO timestamp or shorthand (1h, 30m) — show state at this point in time */
  at?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parse a duration shorthand like "1h", "30m", "10s" into a past ISO timestamp. */
export function parseDuration(input: string): string {
  if (input.match(/^\d{4}-\d{2}-\d{2}/) || input.includes("T")) {
    return input; // already an ISO timestamp
  }
  const m = input.match(/^(\d+)(h|m|s)$/);
  if (!m) {
    throw new Error(
      `Invalid --at value: "${input}". Use ISO timestamp or shorthand like "1h", "30m", "10s".`
    );
  }
  const ms: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000 };
  return new Date(Date.now() - parseInt(m[1], 10) * ms[m[2]]).toISOString();
}

// ─── Triage (2C) ──────────────────────────────────────────────────────────────

/**
 * `flywheel beads triage` — SSH to VPS, run `bv --robot-triage --format json`,
 * and display the top N prioritized bead picks.
 */
export async function runBeadTriage(opts: BeadTriageOptions = {}): Promise<void> {
  const manager = new SSHManager();
  const limit = opts.top ?? 5;

  try {
    const config = await manager.connect();
    const remote = new RemoteCommandRunner(manager);
    const projectPath = resolveRemoteProjectPath(config.remoteRepoRoot);

    console.log(chalk.bold("\nBead Triage (Phase 2C)\n"));
    console.log(chalk.gray(`Running bv --robot-triage in ${projectPath} …\n`));

    let raw: string;
    try {
      const result = await remote.runRemote(
        `cd ${shellQuote(projectPath)} && bv --robot-triage --format json 2>/dev/null`,
        { timeoutMs: 30_000 }
      );
      raw = result.stdout.trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red("✗") + ` bv triage failed: ${msg}`);
      console.error(chalk.gray("  Is bv installed on the VPS? Run: flywheel preflight"));
      process.exit(1);
      return;
    }

    // Parse JSON output from bv
    let triageData: Record<string, unknown>;
    try {
      triageData = JSON.parse(raw);
    } catch {
      // If not JSON, bv may have printed text — show it raw
      console.log(raw);
      process.exit(0);
      return;
    }

    const triage = (triageData.triage ?? triageData) as Record<string, unknown>;
    const quickRef = triage.quick_ref as Record<string, unknown> | undefined;
    const picks = (
      (quickRef?.top_picks as unknown[]) ??
      (triage.recommendations as unknown[])?.slice(0, limit) ??
      []
    ) as Array<Record<string, unknown>>;

    if (picks.length === 0) {
      console.log(chalk.green("✓ No open beads — board is clear."));
      console.log(chalk.dim("  Run flywheel review to begin the review phase."));
      process.exit(0);
      return;
    }

    const shown = Math.min(limit, picks.length);
    console.log(chalk.bold(`Top ${shown} priority beads:\n`));

    for (let i = 0; i < shown; i++) {
      const pick = picks[i];
      const id = String(pick.id ?? "?");
      const title = String(pick.title ?? "untitled");
      const score = typeof pick.score === "number" ? pick.score : null;
      const reasons = (pick.reasons as string[] | undefined) ?? [];

      const scoreStr = score !== null ? chalk.gray(` [${score.toFixed(3)}]`) : "";
      console.log(`${chalk.bold(String(i + 1) + ".")} ${chalk.cyan(id)}${scoreStr}`);
      console.log(`   ${chalk.white(title)}`);
      for (const reason of reasons.slice(0, 2)) {
        console.log(chalk.gray(`   ${reason}`));
      }
      console.log();
    }

    // Show project health summary if available
    const health = (triage.project_health as Record<string, unknown> | undefined)?.counts as
      | Record<string, unknown>
      | undefined;
    if (health) {
      const total = health.total ?? "?";
      const closed = health.closed ?? "?";
      const open = (health.by_status as Record<string, number> | undefined)?.open ?? "?";
      const inProg =
        (health.by_status as Record<string, number> | undefined)?.in_progress ?? "?";
      console.log(
        chalk.gray(
          `Board: ${total} total, ${open} open, ${inProg} in-progress, ${closed} closed`
        )
      );
    }

    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(chalk.red("✗") + ` Triage failed: ${message}`);
    process.exit(1);
  } finally {
    manager.disconnect();
  }
}

// ─── History (bead snapshot time-travel) ─────────────────────────────────────

/**
 * `flywheel beads history [--at <time>]` — query local bead_snapshots table
 * and show the board state at a specific point in time with velocity ETA.
 */
export function runBeadHistory(opts: BeadHistoryOptions = {}): void {
  const db = initDb();
  const state = new StateManager(db);
  const runs = state.listFlywheelRuns();

  if (runs.length === 0) {
    console.log(
      chalk.gray('No flywheel runs recorded yet. Start with: flywheel new "<idea>"')
    );
    process.exit(0);
  }

  const run = runs[0]; // most recent run
  const snapshots = state.getBeadSnapshots(run.id);

  if (snapshots.length === 0) {
    console.log(chalk.gray(`No bead snapshots for run ${run.id.slice(0, 8)}…`));
    console.log(chalk.gray("Snapshots are captured during an active swarm run."));
    process.exit(0);
  }

  // Filter to the snapshot at or before --at
  let filtered = snapshots;
  if (opts.at) {
    let cutoffMs: number;
    try {
      cutoffMs = new Date(parseDuration(opts.at)).getTime();
    } catch (err) {
      console.error(chalk.red("✗") + ` ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
      return;
    }
    filtered = snapshots.filter((s) => new Date(s.captured_at).getTime() <= cutoffMs);
    if (filtered.length === 0) {
      console.log(chalk.gray(`No snapshots found at or before ${opts.at}.`));
      process.exit(0);
      return;
    }
  }

  const snap = filtered[filtered.length - 1];
  const velocity = state.beadVelocity(run.id);
  const remaining = Math.max(0, snap.bead_count - snap.closed_count);

  console.log(chalk.bold(`\nBead Board — ${snap.captured_at.slice(0, 19).replace("T", " ")} UTC\n`));
  console.log(
    chalk.gray(`Run: ${run.id.slice(0, 8)}… | Project: ${run.project_name}`)
  );
  console.log();

  const pad = (n: number) => String(n).padStart(4);
  console.log(`  Total beads:  ${chalk.white(pad(snap.bead_count))}`);
  console.log(`  Closed:       ${chalk.green(pad(snap.closed_count))}`);
  console.log(`  Blocked:      ${chalk.red(pad(snap.blocked_count))}`);
  console.log(`  Open/active:  ${chalk.yellow(pad(remaining))}`);

  if (velocity > 0) {
    console.log(`  Velocity:     ${chalk.cyan(velocity.toFixed(1))} beads/hr`);
    if (remaining > 0) {
      const etaHrs = remaining / velocity;
      const etaStr =
        etaHrs < 1 ? `${Math.round(etaHrs * 60)}m` : `${etaHrs.toFixed(1)}h`;
      console.log(`  ETA to done:  ${chalk.cyan(etaStr)}`);
    } else {
      console.log(chalk.green("  All done! ✓"));
    }
  }

  console.log();
  process.exit(0);
}

// ─── Generate (2A) ────────────────────────────────────────────────────────────

/**
 * `flywheel beads generate` — Phase 2A.
 * Verifies that a plan exists on the VPS, then guides the user to inject
 * the bead-generation prompt via NTM or a spawned agent.
 */
export async function runBeadGenerate(): Promise<void> {
  const manager = new SSHManager();

  try {
    const config = await manager.connect();
    const projectPath = resolveRemoteProjectPath(config.remoteRepoRoot);

    console.log(chalk.bold("\nPhase 2A: Generate Beads\n"));

    // Check for plan.md on VPS
    const check = await manager.exec(
      `test -f ${shellQuote(projectPath + "/plan.md")} && echo found || echo missing`,
      { timeoutMs: 10_000 }
    );

    const planExists = check.stdout.trim() === "found";
    if (planExists) {
      console.log(chalk.green("✓") + ` plan.md found at ${projectPath}/plan.md`);
    } else {
      console.log(chalk.red("✗") + ` plan.md not found at ${projectPath}/plan.md`);
      console.log(chalk.gray('  Run "flywheel new <idea>" and use --push-artifacts to upload the plan.'));
      process.exit(1);
      return;
    }

    // Check if br is available
    const brCheck = await manager.exec("which br 2>/dev/null || echo missing", {
      timeoutMs: 5_000,
    });
    const brAvailable = !brCheck.stdout.includes("missing");

    console.log();
    console.log(chalk.bold("Next step: inject the bead-generation prompt into an agent."));
    console.log();
    if (brAvailable) {
      console.log(chalk.gray("  Option 1 (recommended): spawn an agent to parse the plan:"));
      console.log(chalk.gray("    flywheel swarm 1"));
      console.log(chalk.gray("    flywheel prompts send beads-generate-from-plan --all"));
      console.log();
      console.log(chalk.gray("  Option 2: send the prompt to an already-running agent:"));
      console.log(chalk.gray("    flywheel prompts send beads-generate-from-plan --agent <pane>"));
    } else {
      console.log(chalk.yellow("⚠") + " br is not installed on the VPS.");
      console.log(chalk.gray("  Run: flywheel preflight"));
    }
    console.log();
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(chalk.red("✗") + ` Bead generate failed: ${message}`);
    process.exit(1);
  } finally {
    manager.disconnect();
  }
}

// ─── Refine (2B) ─────────────────────────────────────────────────────────────

/**
 * `flywheel beads refine` — Phase 2B.
 * Lists current beads from the VPS and guides the user through refining them.
 */
export async function runBeadRefine(): Promise<void> {
  const manager = new SSHManager();

  try {
    const config = await manager.connect();
    const remote = new RemoteCommandRunner(manager);
    const projectPath = resolveRemoteProjectPath(config.remoteRepoRoot);

    console.log(chalk.bold("\nPhase 2B: Refine Beads\n"));

    // List current beads on VPS
    let beadList = "";
    try {
      const result = await remote.runRemote(
        `cd ${shellQuote(projectPath)} && br list --all 2>/dev/null`,
        { timeoutMs: 15_000 }
      );
      beadList = result.stdout.trim();
    } catch {
      // br might not be initialized; continue with guidance
    }

    if (beadList) {
      console.log(chalk.bold("Current beads on VPS:\n"));
      console.log(beadList);
      console.log();
    } else {
      console.log(chalk.gray("No beads found on VPS, or br is not initialized."));
      console.log(chalk.gray('  Run "flywheel beads generate" first.'));
      console.log();
    }

    console.log(chalk.bold("Refinement guidance:"));
    console.log(chalk.gray("  br show <id>             — inspect a bead"));
    console.log(chalk.gray("  br update <id> -t <text> — update bead title"));
    console.log(chalk.gray("  br dep add <id> <dep>    — add a dependency"));
    console.log(chalk.gray("  bv --export-md /tmp/b.md — export to Markdown for review"));
    console.log(chalk.gray("  flywheel beads triage    — run bv --robot-triage to prioritize"));
    console.log();
    console.log(
      chalk.yellow("Gate:") +
        " When satisfied with the bead board, run " +
        chalk.bold("flywheel gate advance") +
        " to proceed to Phase 3 (Swarm)."
    );
    console.log();
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(chalk.red("✗") + ` Bead refine failed: ${message}`);
    process.exit(1);
  } finally {
    manager.disconnect();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveRemoteProjectPath(remoteRepoRoot: string): string {
  return `${remoteRepoRoot.replace(/\/+$/, "")}/${currentProjectName()}`;
}

function currentProjectName(): string {
  const segments = process.cwd().split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "project";
}
