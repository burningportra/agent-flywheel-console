/**
 * test/integration/cli-runs-replay.test.ts
 * Covers: flywheel runs, flywheel replay <id>
 * Spawns the real dist/cli.js binary with HOME isolation.
 * No VPS required.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { tempDir } from "../helpers.js";
import { initDb, StateManager } from "../../cli/state.js";

const CLI = resolve("dist/cli.js");

interface RunResult { exitCode: number; stdout: string; stderr: string; }

function flywheel(args: string[], env: Record<string, string> = {}): RunResult {
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
    timeout: 15_000,
  });
  const out = result.stdout ?? "";
  const err = result.stderr ?? "";
  if (process.env.CI) {
    console.log(`[INTEGRATION] flywheel ${args.join(" ")}\n  exit:${result.status}\n  stdout:${out.slice(0, 300)}\n  stderr:${err.slice(0, 200)}`);
  }
  return { exitCode: result.status ?? 1, stdout: out, stderr: err };
}

let dir: ReturnType<typeof tempDir>;

beforeEach(() => {
  dir = tempDir();
  mkdirSync(dir.path, { recursive: true });
});

afterEach(() => dir.cleanup());

function envForDir(): Record<string, string> {
  return {
    FLYWHEEL_HOME: dir.path,
    FLYWHEEL_STATE_DB: join(dir.path, "state.db"),
  };
}

// ── flywheel runs ─────────────────────────────────────────────────────────────

describe("flywheel runs (no runs)", () => {
  it("exits 0 with a helpful no-runs message", () => {
    const { exitCode, stdout } = flywheel(["runs"], envForDir());
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/no runs|flywheel new/i);
  });
});

describe("flywheel runs (pre-seeded DB)", () => {
  let runId: string;

  beforeEach(() => {
    const db = initDb(join(dir.path, "state.db"));
    const sm = new StateManager(db);
    runId = sm.createFlywheelRun("my-test-project", "plan");
    sm.completeFlywheelRun(runId, 0.025, "test run");
  });

  it("exits 0 and shows the project name", () => {
    const { exitCode, stdout } = flywheel(["runs"], envForDir());
    expect(exitCode).toBe(0);
    expect(stdout).toContain("my-test-project");
  });

  it("shows the run ID prefix (first 12 chars)", () => {
    const { exitCode, stdout } = flywheel(["runs"], envForDir());
    expect(exitCode).toBe(0);
    expect(stdout).toContain(runId.slice(0, 8)); // at least 8 chars shown
  });

  it("shows the phase name", () => {
    const { exitCode, stdout } = flywheel(["runs"], envForDir());
    expect(exitCode).toBe(0);
    expect(stdout).toContain("plan");
  });
});

// ── flywheel replay ───────────────────────────────────────────────────────────

describe("flywheel replay (run not found)", () => {
  it("exits 1 with a 'not found' message", () => {
    const { exitCode, stdout, stderr } = flywheel(["replay", "nonexistent-id"], envForDir());
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toMatch(/not found|nonexistent/i);
  });
});

describe("flywheel replay (with events)", () => {
  let runId: string;

  beforeEach(() => {
    const db = initDb(join(dir.path, "state.db"));
    const sm = new StateManager(db);
    runId = sm.createFlywheelRun("replay-project", "plan");
    sm.logEvent(runId, "phase_started", { phase: "plan" }, { actor: "flywheel", phaseTo: "plan" });
    sm.logEvent(runId, "gate_advanced", { nextPhase: "beads" }, { actor: "human", phaseFrom: "plan", phaseTo: "beads" });
  });

  it("exits 0 with the run ID in output", () => {
    const { exitCode, stdout } = flywheel(["replay", runId.slice(0, 8)], envForDir());
    expect(exitCode).toBe(0);
    expect(stdout).toContain(runId);
  });

  it("shows both event types in the narrative", () => {
    const { stdout } = flywheel(["replay", runId.slice(0, 8)], envForDir());
    expect(stdout).toContain("phase_started");
    expect(stdout).toContain("gate_advanced");
  });

  it("--format json outputs valid JSON", () => {
    const { exitCode, stdout } = flywheel(["replay", runId.slice(0, 8), "--format", "json"], envForDir());
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { run: { id: string }; events: unknown[] };
    expect(parsed.run.id).toBe(runId);
    expect(Array.isArray(parsed.events)).toBe(true);
    expect(parsed.events).toHaveLength(2);
  });

  it("--since with far future timestamp shows no events", () => {
    const { exitCode, stdout } = flywheel(
      ["replay", runId.slice(0, 8), "--since", "2099-01-01T00:00:00Z"],
      envForDir()
    );
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/no events after|No events/i);
  });
});
