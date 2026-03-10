// flywheel gate advance | status — human gate machine for phase transitions
// Bead: part of ulh gate state machine (StateManager.advanceGate)

import chalk from "chalk";
import { spawnSync } from "node:child_process";
import { initDb, nextPhaseFor, StateManager } from "./state.js";
import type { Phase } from "./state.js";
import { phaseColor } from "./utils.js";

// Use the shared phaseColor for rendering; pre-compute coloured labels for convenience.
const PHASE_LABEL: Record<Phase, string> = {
  plan:   phaseColor("plan"),
  beads:  phaseColor("beads"),
  swarm:  phaseColor("swarm"),   // yellow — matches runs.ts / monitor.ts
  review: phaseColor("review"),  // magenta
  deploy: phaseColor("deploy"),
};

// What to run after advancing to each phase.
const PHASE_NEXT_CMD: Record<Phase, string> = {
  plan:   "flywheel beads generate",
  beads:  "flywheel swarm <count>",
  swarm:  "flywheel review",
  review: "flywheel deploy",
  deploy: "(terminal phase — no further steps)",
};

const GATE_HOOK_ENV = "FLYWHEEL_GATE_HOOK";
const GATE_HOOK_TIMEOUT_ENV = "FLYWHEEL_GATE_HOOK_TIMEOUT_MS";
const DEFAULT_GATE_HOOK_TIMEOUT_MS = 10_000;

interface GateNotificationPayload {
  runId: string;
  projectName: string;
  previousPhase: Phase;
  nextPhase: Phase;
  checkpointSha?: string;
  advancedAt: string;
}

// ── gate status ───────────────────────────────────────────────────────────────

export function gateStatus(): void {
  const sm = new StateManager(initDb());
  const runs = sm.listFlywheelRuns();

  if (runs.length === 0) {
    console.log(chalk.dim("\nNo flywheel runs found."));
    console.log(chalk.dim("Start one with: flywheel new \"your idea\"\n"));
    return;
  }

  // Most recent run is the "current" one
  const run = runs[0];
  const next = nextPhaseFor(run.phase as Phase);

  const SEP = "─".repeat(48);
  console.log(chalk.bold("\nGate Status"));
  console.log(SEP);
  console.log(`  Run:      ${chalk.dim(run.id.slice(0, 12) + "…")}`);
  console.log(`  Project:  ${run.project_name ?? chalk.dim("—")}`);
  console.log(`  Phase:    ${PHASE_LABEL[run.phase as Phase] ?? run.phase}`);

  if (run.gate_passed_at) {
    console.log(`  Gate:     ${chalk.green("✓ passed")}  ${chalk.dim(run.gate_passed_at.slice(0, 19).replace("T", " "))}`);
  } else {
    console.log(`  Gate:     ${chalk.yellow("waiting")}  ${chalk.dim("run: flywheel gate advance")}`);
  }

  if (run.checkpoint_sha) {
    console.log(`  SHA:      ${chalk.dim(run.checkpoint_sha.slice(0, 12))}`);
  }

  console.log(SEP);

  if (next) {
    console.log(`  Next phase: ${PHASE_LABEL[next]}`);
    console.log(chalk.dim(`  Command:    ${PHASE_NEXT_CMD[run.phase as Phase]}`));
    if (!run.gate_passed_at) {
      console.log(chalk.dim(`  Advance:    flywheel gate advance`));
    }
  } else {
    console.log(chalk.dim("  deploy is the terminal phase — no further gates."));
  }

  if (process.env[GATE_HOOK_ENV]?.trim()) {
    console.log(chalk.dim(`\n  Hook: ${GATE_HOOK_ENV} is set`));
  }
  console.log();
}

// ── gate advance ──────────────────────────────────────────────────────────────

export function gateAdvance(opts: { runId?: string; sha?: string } = {}): void {
  const sm = new StateManager(initDb());
  const runs = sm.listFlywheelRuns();

  if (runs.length === 0) {
    console.error(chalk.red("No flywheel runs found. Nothing to advance."));
    process.exit(1);
  }

  let run = runs[0];
  if (opts.runId) {
    // Assign to local const so TypeScript narrows to `string` through the closure.
    const targetId = opts.runId;
    const found = sm.getFlywheelRun(targetId) ??
      runs.find((r) => r.id.startsWith(targetId));
    if (!found) {
      console.error(chalk.red(`Run not found: ${targetId}`));
      process.exit(1);
    }
    run = found;
  }

  const next = nextPhaseFor(run.phase as Phase);
  if (!next) {
    console.log(chalk.yellow(`Phase "${run.phase}" is the terminal phase — nothing to advance.`));
    process.exit(0);
  }

  sm.advanceGate(run.id, next, opts.sha);

  const payload: GateNotificationPayload = {
    runId: run.id,
    projectName: run.project_name ?? "",
    previousPhase: run.phase as Phase,
    nextPhase: next,
    checkpointSha: opts.sha,
    advancedAt: new Date().toISOString(),
  };

  console.log(chalk.green(`\n✓ Gate advanced: ${PHASE_LABEL[run.phase as Phase]} → ${PHASE_LABEL[next]}`));
  console.log(chalk.dim(`  Run: ${run.id.slice(0, 8)} | Project: ${run.project_name ?? "—"}`));
  if (opts.sha) {
    console.log(chalk.dim(`  Checkpoint SHA: ${opts.sha.slice(0, 12)}`));
  }
  const nextCmd = PHASE_NEXT_CMD[next];
  if (nextCmd && !nextCmd.startsWith("(")) {
    console.log();
    console.log(chalk.dim("  Next: ") + chalk.bold(nextCmd));
  }

  runGateNotificationHook(payload);
  console.log();
}

function runGateNotificationHook(payload: GateNotificationPayload): void {
  const hookCommand = process.env[GATE_HOOK_ENV]?.trim();
  if (!hookCommand) {
    return;
  }

  const timeoutMs = parsePositiveInt(process.env[GATE_HOOK_TIMEOUT_ENV], DEFAULT_GATE_HOOK_TIMEOUT_MS);
  const hookEnv = {
    ...process.env,
    FLYWHEEL_GATE_RUN_ID: payload.runId,
    FLYWHEEL_GATE_PROJECT: payload.projectName,
    FLYWHEEL_GATE_FROM: payload.previousPhase,
    FLYWHEEL_GATE_TO: payload.nextPhase,
    FLYWHEEL_GATE_CHECKPOINT_SHA: payload.checkpointSha ?? "",
    FLYWHEEL_GATE_ADVANCED_AT: payload.advancedAt,
    FLYWHEEL_GATE_PAYLOAD_JSON: JSON.stringify(payload),
  };

  const result = spawnSync(hookCommand, {
    shell: true,
    env: hookEnv,
    encoding: "utf8",
    input: `${JSON.stringify(payload)}\n`,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });

  if (result.error) {
    console.warn(
      chalk.yellow(
        `  ⚠ Gate hook failed to execute (${hookCommand}): ${result.error.message}`
      )
    );
    return;
  }

  if (result.signal) {
    console.warn(
      chalk.yellow(
        `  ⚠ Gate hook terminated by signal ${result.signal}`
      )
    );
    return;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    const stderr = result.stderr?.trim();
    const detail = stderr ? `: ${stderr}` : "";
    console.warn(
      chalk.yellow(
        `  ⚠ Gate hook exited with status ${result.status}${detail}`
      )
    );
    return;
  }

  console.log(chalk.dim(`  Hook: notification sent via ${GATE_HOOK_ENV}`));
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return fallback;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}
