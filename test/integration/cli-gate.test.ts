/**
 * test/integration/cli-gate.test.ts
 * Covers: flywheel gate status, flywheel gate advance
 * Spawns real dist/cli.js with HOME isolation. No VPS required.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { tempDir } from "../helpers.js";
import { initDb, StateManager } from "../../cli/state.js";

const CLI = resolve("dist/cli.js");

function flywheel(args: string[], env: Record<string, string> = {}): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
    timeout: 10_000,
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

let dir: ReturnType<typeof tempDir>;

beforeEach(() => {
  dir = tempDir();
  mkdirSync(dir.path, { recursive: true });
});
afterEach(() => dir.cleanup());

function env(): Record<string, string> {
  return { FLYWHEEL_HOME: dir.path, FLYWHEEL_STATE_DB: join(dir.path, "state.db") };
}

// ── gate status ───────────────────────────────────────────────────────────────

describe("flywheel gate status — no runs", () => {
  it("exits 0 with a no-runs message", () => {
    const { exitCode, stdout } = flywheel(["gate", "status"], env());
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/no flywheel runs/i);
  });
});

describe("flywheel gate status — run in plan phase", () => {
  beforeEach(() => {
    const sm = new StateManager(initDb(join(dir.path, "state.db")));
    sm.createFlywheelRun("status-project", "plan");
  });

  it("exits 0 and shows the current phase", () => {
    const { exitCode, stdout } = flywheel(["gate", "status"], env());
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/phase.*plan|plan.*phase/i);
  });

  it("shows gate as 'waiting'", () => {
    const { stdout } = flywheel(["gate", "status"], env());
    expect(stdout).toMatch(/waiting/i);
  });

  it("shows the next phase hint", () => {
    const { stdout } = flywheel(["gate", "status"], env());
    expect(stdout).toMatch(/next.*beads|beads/i);
  });
});

describe("flywheel gate status — gate already passed", () => {
  beforeEach(() => {
    const sm = new StateManager(initDb(join(dir.path, "state.db")));
    const id = sm.createFlywheelRun("p", "plan");
    sm.advanceGate(id, "beads");
  });

  it("shows gate as passed", () => {
    const { exitCode, stdout } = flywheel(["gate", "status"], env());
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/passed/i);
  });
});

// ── gate advance ──────────────────────────────────────────────────────────────

describe("flywheel gate advance — no runs", () => {
  it("exits 1 with a no-runs error", () => {
    const { exitCode, stdout, stderr } = flywheel(["gate", "advance"], env());
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toMatch(/no flywheel runs/i);
  });
});

describe("flywheel gate advance — from plan phase", () => {
  let runId: string;
  beforeEach(() => {
    const sm = new StateManager(initDb(join(dir.path, "state.db")));
    runId = sm.createFlywheelRun("advance-project", "plan");
  });

  it("exits 0 and shows the phase transition", () => {
    const { exitCode, stdout } = flywheel(["gate", "advance"], env());
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/gate advanced.*plan.*beads|plan.*→.*beads/i);
  });

  it("updates phase to beads in the DB", () => {
    flywheel(["gate", "advance"], env());
    const sm = new StateManager(initDb(join(dir.path, "state.db")));
    const run = sm.getFlywheelRun(runId);
    expect(run?.phase).toBe("beads");
    expect(run?.gate_passed_at).not.toBeNull();
  });

  it("--sha stores the checkpoint SHA in the DB", () => {
    const sha = "abc1234567890abc";
    flywheel(["gate", "advance", "--sha", sha], env());
    const sm = new StateManager(initDb(join(dir.path, "state.db")));
    const run = sm.getFlywheelRun(runId);
    expect(run?.checkpoint_sha).toBe(sha);
  });

  it("--sha with any value is stored (gate just persists it; validation is in rollback)", () => {
    // gate advance --sha stores the value in SQLite — it does not execute it in a shell
    // command. SHA validation only occurs in rollback.ts. Any value is accepted here.
    const { exitCode } = flywheel(
      ["gate", "advance", "--sha", "abc1234"],
      env()
    );
    expect(exitCode).toBe(0);
    const sm = new StateManager(initDb(join(dir.path, "state.db")));
    const run = sm.getFlywheelRun(runId);
    expect(run?.checkpoint_sha).toBe("abc1234");
  });
});

describe("flywheel gate advance — on deploy (terminal phase)", () => {
  beforeEach(() => {
    const sm = new StateManager(initDb(join(dir.path, "state.db")));
    const id = sm.createFlywheelRun("p", "review");
    sm.advanceGate(id, "deploy");
  });

  it("exits 0 with a terminal phase message", () => {
    const { exitCode, stdout } = flywheel(["gate", "advance"], env());
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/terminal|nothing to advance|deploy/i);
  });
});
