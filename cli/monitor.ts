// flywheel monitor — terminal-mode live view of swarm activity + bead progress
// Polls VPS via SSH on a configurable interval; Ctrl-C to exit.

import chalk from "chalk";

import { NtmBridge, type AgentStatus, type NtmSession } from "./ntm-bridge.js";
import { RemoteCommandRunner } from "./remote.js";
import { SSHManager } from "./ssh.js";
import { initDb, StateManager } from "./state.js";
import { phaseColor } from "./utils.js";

// ─── Options ──────────────────────────────────────────────────────────────────

export interface MonitorOptions {
  /** Poll interval in seconds (default: 15) */
  interval?: number;
  /** NTM session name to monitor (default: auto-detect first session) */
  session?: string;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * `flywheel monitor` — continuously poll the VPS and render a live status view.
 *
 * Layout (refreshed every <interval> seconds):
 *   ╔══════ Flywheel Monitor ══════╗
 *   │ SSH: user@host | Latency: Xms
 *   │ Run: <id> | Phase: swarm | Beads: 12/40 closed
 *   │ Velocity: 3.2/hr | ETA: ~4.5h
 *   ├─────── Active Agents ────────┤
 *   │ pane 0  [active] commit-agent
 *   │ pane 1  [idle]   coding-agent
 *   │ pane 2  [stuck]  coding-agent
 *   └──────────────────────────────┘
 *
 * Exits cleanly on SIGINT (Ctrl-C).
 */
export async function runMonitor(opts: MonitorOptions = {}): Promise<void> {
  const interval = (opts.interval ?? 15) * 1_000;

  const db = initDb();
  const state = new StateManager(db);
  const manager = new SSHManager();

  // ── Connect ──────────────────────────────────────────────────────────────────
  console.log(chalk.bold("Flywheel Monitor") + chalk.gray(" — Ctrl-C to exit\n"));
  console.log(chalk.gray("Connecting to VPS…"));

  try {
    await manager.connect();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(chalk.red("✗") + ` Cannot connect: ${message}`);
    console.error(chalk.gray("  Run: flywheel ssh test"));
    process.exit(1);
  }

  const remote = new RemoteCommandRunner(manager);
  const ntm = new NtmBridge(remote);

  // ── Graceful shutdown ─────────────────────────────────────────────────────────
  let running = true;
  process.on("SIGINT", () => {
    running = false;
    console.log("\n" + chalk.gray("Monitor stopped."));
    manager.disconnect();
    process.exit(0);
  });

  // ── Poll loop ─────────────────────────────────────────────────────────────────
  while (running) {
    const frame = await buildFrame(manager, ntm, state, opts.session);
    renderFrame(frame, interval);

    if (!running) break;
    await sleep(interval);
  }
}

// ─── Frame builder ────────────────────────────────────────────────────────────

interface MonitorFrame {
  timestamp: string;
  sshHost: string;
  latencyMs: number | null;
  run: {
    id: string;
    projectName: string;
    phase: string;
    beadCount: number;
    closedCount: number;
    velocity: number;
  } | null;
  sessions: NtmSession[];
  agents: AgentStatus[];
  error?: string;
}

async function buildFrame(
  manager: SSHManager,
  ntm: NtmBridge,
  state: StateManager,
  sessionName?: string
): Promise<MonitorFrame> {
  const config = manager.getConfig();
  const sshHost = config ? `${config.user}@${config.host}` : "unknown";

  let latencyMs: number | null = null;
  let sessions: NtmSession[] = [];
  let agents: AgentStatus[] = [];
  let error: string | undefined;

  try {
    latencyMs = await manager.getLatency();
  } catch {
    /* latency optional */
  }

  try {
    sessions = await ntm.list();
  } catch {
    error = "NTM unreachable";
  }

  if (!error && sessions.length > 0) {
    const targetSession = sessionName ?? sessions[0].name;
    try {
      agents = await ntm.activity(targetSession);
    } catch {
      /* no agents running */
    }
  }

  // Load most recent run from local SQLite
  const runs = state.listFlywheelRuns();
  let run: MonitorFrame["run"] = null;
  if (runs.length > 0) {
    const r = runs[0];
    const snapshots = state.getBeadSnapshots(r.id);
    const last = snapshots[snapshots.length - 1];
    const velocity = state.beadVelocity(r.id);
    run = {
      id: r.id.slice(0, 8),
      projectName: r.project_name,
      phase: r.phase,
      beadCount: last?.bead_count ?? 0,
      closedCount: last?.closed_count ?? 0,
      velocity,
    };
  }

  return {
    timestamp: new Date().toISOString().slice(11, 19),
    sshHost,
    latencyMs,
    run,
    sessions,
    agents,
    error,
  };
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

function renderFrame(frame: MonitorFrame, intervalMs: number): void {
  // ESC[2J clears screen; ESC[H moves cursor to top-left. More reliable than \x1Bc.
  process.stdout.write("\x1b[2J\x1b[H");

  const width = Math.min(process.stdout.columns ?? 80, 100);
  // Consistent single-style box: ─ everywhere, no mixed ═/─ styles.
  const inner = "─".repeat(width - 2);
  const sep   = "├" + inner + "┤";
  const bot   = "└" + inner + "┘";

  // ── Header ─────────────────────────────────────────────────────────────────
  const title = "  Flywheel Monitor  ";
  const fill = Math.max(0, width - title.length - 2);
  const lf = Math.floor(fill / 2);
  const rf = fill - lf;
  console.log(chalk.bold("┌" + "─".repeat(lf) + title + "─".repeat(rf) + "┐"));

  // ── SSH ────────────────────────────────────────────────────────────────────
  const latency =
    frame.latencyMs !== null
      ? chalk.green(`${frame.latencyMs}ms`)
      : chalk.red("timeout");
  console.log(`│  ${chalk.bold("SSH")} ${chalk.cyan(frame.sshHost)}  latency ${latency}  ${chalk.dim(frame.timestamp)}`);

  // ── Run ────────────────────────────────────────────────────────────────────
  if (frame.run) {
    const r   = frame.run;
    const pct = r.beadCount > 0 ? Math.round((r.closedCount / r.beadCount) * 100) : 0;
    const filled = Math.floor(pct / 5);
    const progressBar = chalk.cyan("█".repeat(filled)) + chalk.dim("░".repeat(20 - filled));
    const velStr = r.velocity > 0 ? chalk.cyan(`${r.velocity.toFixed(1)}/hr`) : chalk.dim("—");

    let etaStr = chalk.dim("—");
    if (r.velocity > 0 && r.beadCount > r.closedCount) {
      const etaHrs = (r.beadCount - r.closedCount) / r.velocity;
      etaStr = chalk.cyan(etaHrs < 1 ? `~${Math.round(etaHrs * 60)}m` : `~${etaHrs.toFixed(1)}h`);
    }

    console.log(
      `│  ${chalk.bold("Run")} ${chalk.dim(r.id + "…")}  ` +
      `phase ${phaseColor(r.phase)}  ` +
      `beads ${chalk.white(`${r.closedCount}/${r.beadCount}`)} (${pct}%)`
    );
    console.log(`│  [${progressBar}]  velocity ${velStr}  ETA ${etaStr}`);
  } else {
    console.log(chalk.dim('│  No active run — start with: flywheel new "<idea>"'));
  }

  // ── Error ──────────────────────────────────────────────────────────────────
  if (frame.error) {
    console.log(`│  ${chalk.red("⚠")}  ${chalk.red(frame.error)}`);
  }

  // ── Sessions ───────────────────────────────────────────────────────────────
  if (frame.sessions.length > 0) {
    console.log(sep);
    console.log(`│  ${chalk.bold("NTM Sessions")}`);
    for (const s of frame.sessions) {
      const counts = [
        s.agentCounts.claude > 0 ? `claude×${s.agentCounts.claude}` : "",
        s.agentCounts.codex  > 0 ? `codex×${s.agentCounts.codex}`  : "",
        s.agentCounts.gemini > 0 ? `gemini×${s.agentCounts.gemini}` : "",
      ].filter(Boolean).join("  ");
      console.log(`│    ${chalk.cyan(s.name)} — ${chalk.white(String(s.agentCounts.total))} agents  ${chalk.dim(counts)}`);
    }
  }

  // ── Agents ─────────────────────────────────────────────────────────────────
  console.log(sep);
  if (frame.agents.length > 0) {
    console.log(`│  ${chalk.bold("Agent Activity")}`);
    for (const a of frame.agents) {
      const statusStr = agentStatusColor(a.status);
      const bead  = a.currentBead ? chalk.dim(`  ← ${a.currentBead}`) : "";
      const aTitle = a.title ? chalk.dim(`  ${a.title}`) : "";
      console.log(`│    pane ${String(a.pane).padStart(2)}  ${statusStr}${aTitle}${bead}`);
    }
  } else {
    console.log(chalk.dim("│  No agents running — start with: flywheel swarm <N>"));
  }

  // ── Footer ─────────────────────────────────────────────────────────────────
  console.log(bot);
  console.log(chalk.dim(`  Refreshing every ${intervalMs / 1_000}s — Ctrl-C to exit`));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function agentStatusColor(status: AgentStatus["status"]): string {
  switch (status) {
    case "active":
      return chalk.green("[active]");
    case "idle":
      return chalk.yellow("[idle]  ");
    case "stuck":
      return chalk.red("[stuck] ");
    default:
      return chalk.gray("[unknown]");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
