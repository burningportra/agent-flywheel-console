// flywheel autopilot — continuous maintenance loop
// Polls bead state, captures snapshots, shows velocity ETA.
// Supports --tmux to detach into a persistent session.

import { spawn } from "node:child_process";
import chalk from "chalk";
import { initDb, StateManager } from "./state.js";
import { SSHManager } from "./ssh.js";
import { RemoteCommandRunner } from "./remote.js";
import { shellQuote } from "./utils.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AutopilotOptions {
  /** Poll interval in seconds (default: 300 = 5 min) */
  intervalSeconds?: number;
  /** Detach into a tmux window named "flywheel-autopilot" */
  tmux?: boolean;
  /** Project scope — "current" (default) or "all" (not yet supported) */
  projects?: string;
}

export interface BeadStats {
  total: number;
  closed: number;
  open: number;
  inProgress: number;
  blocked: number;
}

/**
 * Parse bead stats from the JSON output of `br list --all --json`.
 * Exported for unit testing without SSH.
 *
 * Closed    = status === "closed"  (completed work)
 * Tombstone = deleted/cancelled    (NOT counted as closed)
 * Blocked   = status === "blocked"
 * InProgress = status === "in_progress"
 * Open      = everything else minus closed/blocked/inProgress
 */
export function parseBeadStats(
  issues: Array<{ status?: string }>
): BeadStats {
  const total = issues.length;
  const closed = issues.filter((i) => i.status === "closed").length;
  const blocked = issues.filter((i) => i.status === "blocked").length;
  const inProgress = issues.filter((i) => i.status === "in_progress").length;
  const open = Math.max(total - closed - blocked - inProgress, 0);
  return { total, closed, open, inProgress, blocked };
}

// ── Remote bead stats ─────────────────────────────────────────────────────────

async function fetchBeadStats(
  remote: RemoteCommandRunner,
  remoteProjectPath: string
): Promise<BeadStats | null> {
  try {
    const result = await remote.runRemote("br list --all --json", {
      cwd: remoteProjectPath,
      timeoutMs: 15_000,
      silent: true,
    });
    if (result.exitCode !== 0) return null;

    let issues: Array<{ status?: string }>;
    try {
      issues = JSON.parse(result.stdout) as Array<{ status?: string }>;
    } catch {
      return null;
    }
    return parseBeadStats(issues);
  } catch {
    return null;
  }
}

// ── Display ───────────────────────────────────────────────────────────────────

function clearAndHeader(tick: number): void {
  // Only clear from the second tick — the first tick should let the startup
  // message ("Starting flywheel autopilot…") remain visible briefly.
  if (tick > 1) {
    process.stdout.write("\x1b[2J\x1b[H"); // clear screen, cursor to top-left
  } else {
    console.log(); // one blank line after startup message
  }
  const now = new Date().toLocaleTimeString();
  console.log(chalk.bold("Flywheel Autopilot") + chalk.dim(` — poll ${tick} · ${now}\n`));
}

function showGateStatus(sm: StateManager): void {
  const runs = sm.listFlywheelRuns();
  if (runs.length === 0) {
    console.log(chalk.dim("  No flywheel runs yet.\n"));
    return;
  }
  const run = runs[0];
  const gateStr = run.gate_passed_at ? chalk.green("✓ passed") : chalk.yellow("⏳ waiting");
  console.log(chalk.bold("Current run:"));
  console.log(`  Phase: ${chalk.cyan(run.phase)}  Gate: ${gateStr}`);
  console.log(`  Project: ${run.project_name ?? "—"}  Started: ${run.started_at.slice(0, 19)}`);
  console.log();
}

function showVelocity(sm: StateManager, runId: string): void {
  const velocity = sm.beadVelocity(runId);
  const snapshots = sm.getBeadSnapshots(runId);
  if (snapshots.length === 0) {
    console.log(chalk.dim("  No bead snapshots yet (polls accumulate over time).\n"));
    return;
  }
  const latest = snapshots[snapshots.length - 1];
  const remaining = Math.max(0, latest.bead_count - latest.closed_count);
  console.log(chalk.bold("Bead velocity:"));
  console.log(`  Snapshots: ${snapshots.length}  Velocity: ${velocity.toFixed(1)} beads/hr`);
  if (velocity > 0) {
    const etaHours = remaining / velocity;
    const etaMins = Math.round(etaHours * 60);
    console.log(chalk.green(`  ETA: ~${etaMins} min (${remaining} remaining)`));
  } else {
    console.log(chalk.dim(`  ${remaining} bead(s) remaining — insufficient data for ETA`));
  }
  console.log();
}

function showBeadStats(stats: BeadStats): void {
  const pct = stats.total > 0 ? Math.min(100, Math.round((stats.closed / stats.total) * 100)) : 0;
  const filled = Math.floor(pct / 5);
  const bar = "█".repeat(filled) + "░".repeat(20 - filled);
  console.log(chalk.bold("Beads (remote):"));
  console.log(`  [${bar}] ${pct}%  ${stats.closed}/${stats.total} closed`);
  if (stats.inProgress > 0) {
    console.log(chalk.cyan(`  ⟳ ${stats.inProgress} in progress`));
  }
  if (stats.open > 0) {
    console.log(chalk.gray(`  ○ ${stats.open} open`));
  }
  if (stats.blocked > 0) {
    console.log(chalk.yellow(`  ⚠ ${stats.blocked} blocked`));
  }
  console.log();
}

// ── Tmux launcher ─────────────────────────────────────────────────────────────

function launchInTmux(options: AutopilotOptions): void {
  const parts = ["flywheel autopilot"];
  if (options.intervalSeconds !== undefined) parts.push(`--interval ${options.intervalSeconds}`);
  if (options.projects) parts.push(`--projects ${shellQuote(options.projects)}`);
  const cmd = parts.join(" ");

  const tmuxArgs = [
    "new-window",
    "-n", "flywheel-autopilot",
    cmd,
  ];

  const child = spawn("tmux", tmuxArgs, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  console.log(chalk.green(`✓ Autopilot launched in tmux window "flywheel-autopilot"`));
  console.log(chalk.dim(`  Attach with: tmux select-window -t flywheel-autopilot`));
}

// ── Main loop ─────────────────────────────────────────────────────────────────

export async function runAutopilot(options: AutopilotOptions = {}): Promise<void> {
  const intervalMs = (options.intervalSeconds ?? 300) * 1_000;

  if (options.tmux) {
    launchInTmux(options);
    return;
  }

  const db = initDb();
  const sm = new StateManager(db);
  const ssh = new SSHManager();
  const remote = new RemoteCommandRunner(ssh);

  let tick = 0;
  let sshOk = false;

  console.log(chalk.bold("Starting flywheel autopilot…"));
  console.log(chalk.dim(`  Polling every ${(intervalMs / 60_000).toFixed(0)} min — Ctrl+C to stop\n`));

  // Connect SSH once
  try {
    const config = await ssh.connect();
    sshOk = true;
    const remoteProjectPath = resolveRemoteProjectPath(
      config.remoteRepoRoot,
      sm.listFlywheelRuns()[0]?.project_name
    );
    if (!remoteProjectPath) {
      sshOk = false;
      console.log(chalk.yellow("⚠ No project context available — running in local-only mode\n"));
    }
  } catch {
    console.log(chalk.yellow("⚠ SSH not configured or unreachable — running in local-only mode\n"));
  }

  const getRemoteProjectPath = (): string | undefined => {
    const config = ssh.getConfig();
    return config
      ? resolveRemoteProjectPath(config.remoteRepoRoot, sm.listFlywheelRuns()[0]?.project_name)
      : undefined;
  };

  const loop = async (): Promise<void> => {
    tick++;
    clearAndHeader(tick);

    // Gate/phase status from local SQLite
    showGateStatus(sm);

    // Bead velocity from local snapshots
    const runs = sm.listFlywheelRuns();
    if (runs.length > 0) {
      showVelocity(sm, runs[0].id);
    }

    // Remote bead stats
    if (sshOk) {
      const remoteProjectPath = getRemoteProjectPath();
      const stats = remoteProjectPath ? await fetchBeadStats(remote, remoteProjectPath) : null;
      if (stats) {
        // Capture snapshot for velocity tracking
        if (runs.length > 0) {
          sm.captureBeadSnapshot(runs[0].id, {
            bead_count: stats.total,
            closed_count: stats.closed,
            blocked_count: stats.blocked,
          });
        }
        showBeadStats(stats);
      } else {
        console.log(chalk.dim("  Remote bead stats unavailable\n"));
      }
    } else {
      console.log(chalk.dim("  SSH offline — no remote bead stats\n"));
    }

    console.log(chalk.dim(`Next poll in ${(intervalMs / 60_000).toFixed(0)} min…`));
  };

  let running = true;

  // Clean up on exit — set flag so the loop exits cleanly
  process.on("SIGINT", () => {
    running = false;
    ssh.disconnect();
    console.log(chalk.dim("\nAutopilot stopped."));
    process.exit(0);
  });

  // Sequential poll loop: wait for each iteration to finish before sleeping.
  // setInterval with an async callback would cause concurrent executions if a
  // poll takes longer than the interval.
  while (running) {
    // Re-check SSH connection health each tick and reconnect if dropped.
    if (sshOk && !ssh.isConnected()) {
      try {
        await ssh.connect();
      } catch {
        sshOk = false;
      }
    }

    await loop();

    // Sleep between polls without blocking the event loop
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function resolveRemoteProjectPath(
  remoteRepoRoot: string,
  projectName: string | undefined
): string | undefined {
  if (!projectName) {
    return undefined;
  }
  return `${remoteRepoRoot.replace(/\/+$/, "")}/${projectName}`;
}
