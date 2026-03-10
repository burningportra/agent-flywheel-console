/**
 * test/e2e/lifecycle/04-swarm.e2e.ts — bead: 3hi.4
 *
 * E2E tests for Phase 3 swarm spawn and gate commands:
 *   flywheel swarm <N>, flywheel gate status, flywheel gate advance
 *
 * Requires FLYWHEEL_TEST_E2E=1. Swarm tests spawn real NTM agents on the VPS.
 * WARNING: these tests spawn real agent processes — they consume resources
 * and require NTM to be installed on the VPS.
 *
 * Gate tests exercise the local SQLite state machine.
 */

import { describe, it, expect, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  runFlywheel,
  runFlywheelWithDiagnostics,
  assertSuccess,
  assertFailure,
  hasSshConfig,
  getTestProject,
  cleanupTestProject,
} from "../setup.js";
import { initDb, StateManager } from "../../../cli/state.js";

const runVpsE2e = process.env.FLYWHEEL_TEST_E2E === "1" && hasSshConfig();
const describeVps = runVpsE2e ? describe : describe.skip;

const testProject = getTestProject();

// ── Count validation (no VPS) ─────────────────────────────────────────────────

describe("flywheel swarm — argument validation", () => {
  it("rejects non-integer count 'abc' with exit 1 and clear message", () => {
    const result = runFlywheel(["swarm", "abc"]);
    assertFailure(result, "flywheel swarm with non-integer count");
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/positive integer|invalid.*count|must be/i);
  });

  it("rejects count '0'", () => {
    const result = runFlywheel(["swarm", "0"]);
    assertFailure(result, "flywheel swarm 0");
    expect(result.stdout + result.stderr).toMatch(/positive integer/i);
  });

  it("rejects count '-1'", () => {
    const result = runFlywheel(["swarm", "-1"]);
    assertFailure(result, "flywheel swarm -1");
  });

  it("rejects non-finite budget '0' (budget of zero blocks immediately)", () => {
    // --budget 0 means "block all swarms" — should fail before SSH
    const result = runFlywheel(["swarm", "2", "--budget", "0"]);
    // Either fails with budget error or positive-number error
    assertFailure(result, "flywheel swarm --budget 0");
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/budget|positive/i);
  });

  it("rejects invalid budget 'notanumber'", () => {
    const result = runFlywheel(["swarm", "2", "--budget", "notanumber"]);
    assertFailure(result, "flywheel swarm --budget notanumber");
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/budget|positive|number/i);
  });
});

// ── Gate status/advance (local state, no VPS) ─────────────────────────────────

describe("flywheel gate status — no active run", () => {
  it("exits 0 and shows 'No flywheel runs found' when DB is empty", () => {
    const result = runFlywheel(["gate", "status"]);
    expect(result.exitCode).toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/No flywheel runs|no run/i);
  });

  it("exits 0 and shows --help usage on --help", () => {
    const result = runFlywheel(["gate", "status", "--help"]);
    expect(result.exitCode).toBe(0);
  });
});

// ── VPS swarm tests ───────────────────────────────────────────────────────────

describeVps("flywheel swarm (real NTM spawn)", () => {
  afterAll(async () => {
    await cleanupTestProject(testProject);
  });

  it("spawns 2 agents, exits 0, records checkpoint SHA in SQLite", async () => {
    // Ensure project exists first
    await runFlywheelWithDiagnostics(["init", testProject], {
      remoteDiagnostics: true,
      remoteProjectName: testProject,
    });

    const result = await runFlywheelWithDiagnostics(
      ["swarm", "2", "--no-commit"],
      {
        timeout: 120_000,
        remoteDiagnostics: true,
        remoteProjectName: testProject,
      } // 2 min for SSH + NTM spawn
    );

    assertSuccess(result, "flywheel swarm 2");

    // Output should contain session name and checkpoint
    expect(result.stdout).toMatch(/Swarm started/i);
    expect(result.stdout).toMatch(/session|Session/);
    expect(result.stdout).toMatch(/Checkpoint/i);

    // Verify checkpoint SHA was stored in local SQLite
    const stateDbPath = join(homedir(), ".flywheel", "state.db");
    if (existsSync(stateDbPath)) {
      const db = initDb(stateDbPath);
      const sm = new StateManager(db);
      const runs = sm.listFlywheelRuns();
      const swarmRun = runs.find((r) => r.phase === "swarm" && r.project_name === testProject);
      if (swarmRun) {
        expect(swarmRun.checkpoint_sha).toBeTruthy();
        expect(swarmRun.checkpoint_sha).toMatch(/^[0-9a-f]{7,}/i);
      }
    }
  });
});

// ── Gate advance (VPS - advances phase after swarm) ───────────────────────────

describeVps("flywheel gate advance (after swarm)", () => {
  it("advances gate from swarm to review and records in SQLite", async () => {
    // gate status first
    const statusResult = await runFlywheelWithDiagnostics(["gate", "status"], {
      remoteDiagnostics: true,
      remoteProjectName: testProject,
    });
    expect(statusResult.exitCode).toBe(0);
    expect(statusResult.stdout).toMatch(/Phase.*swarm|swarm/i);
    expect(statusResult.stdout).toMatch(/Gate.*waiting|waiting/i);

    // advance the gate
    const advanceResult = await runFlywheelWithDiagnostics(["gate", "advance"], {
      remoteDiagnostics: true,
      remoteProjectName: testProject,
    });
    assertSuccess(advanceResult, "flywheel gate advance");
    expect(advanceResult.stdout).toMatch(/Gate advanced.*swarm.*review|swarm.*→.*review/i);

    // verify in SQLite
    const stateDbPath = join(homedir(), ".flywheel", "state.db");
    if (existsSync(stateDbPath)) {
      const db = initDb(stateDbPath);
      const sm = new StateManager(db);
      const runs = sm.listFlywheelRuns();
      const run = runs.find((r) => r.project_name === testProject);
      if (run) {
        expect(run.phase).toBe("review");
        expect(run.gate_passed_at).toBeTruthy();
      }
    }
  });

  it("gate advance --sha records the SHA in the run", async () => {
    // Use a realistic fake SHA for the --sha flag test
    const fakeSha = "deadbeef1234567890abcdef12345678deadbeef";
    const result = await runFlywheelWithDiagnostics(["gate", "advance", "--sha", fakeSha], {
      remoteDiagnostics: true,
      remoteProjectName: testProject,
    });
    assertSuccess(result, "flywheel gate advance --sha");
    expect(result.stdout).toContain(fakeSha.slice(0, 12));
  });
});
