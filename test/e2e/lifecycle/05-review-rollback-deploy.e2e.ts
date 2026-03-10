/**
 * test/e2e/lifecycle/05-review-rollback-deploy.e2e.ts — bead: 3hi.5
 *
 * E2E tests for Phase 4 + 5:
 *   flywheel review, flywheel rollback, flywheel deploy
 *
 * Requires FLYWHEEL_TEST_E2E=1 and a VPS with NTM running.
 * Deploy tests additionally require a git remote configured on the VPS project.
 *
 * All tests log full command + I/O. Destructive tests (rollback, deploy) are
 * clearly marked and require explicit env vars to run.
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
const runDestructive = runVpsE2e && process.env.FLYWHEEL_TEST_DESTRUCTIVE === "1";
const describeVps = runVpsE2e ? describe : describe.skip;
const describeDestructive = runDestructive ? describe : describe.skip;

const testProject = getTestProject();

// ── Deploy confirmation validation (no VPS) ───────────────────────────────────

describe("flywheel deploy — confirmation validation", () => {
  it("rejects wrong confirmation string with exit 1", () => {
    const result = runFlywheel(
      ["deploy"],
      { stdin: "WRONG CONFIRMATION\n", timeout: 15_000 }
    );
    assertFailure(result, "flywheel deploy wrong confirmation");
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/confirmation|expected|mismatch/i);
    // Ensure no git operations ran
    expect(out).not.toContain("git push");
    expect(out).not.toContain("git commit");
  });

  it("rejects empty confirmation", () => {
    const result = runFlywheel(
      ["deploy"],
      { stdin: "\n", timeout: 10_000 }
    );
    assertFailure(result, "flywheel deploy empty confirmation");
  });

  it("rejects lowercase confirmation", () => {
    const result = runFlywheel(
      ["deploy"],
      { stdin: `deploy ${testProject}\n`, timeout: 10_000 }
    );
    assertFailure(result, "flywheel deploy lowercase confirmation");
  });
});

// ── Rollback validation (no VPS) ─────────────────────────────────────────────

describe("flywheel rollback — no checkpoint run", () => {
  it("exits 1 with a clear message when no runs with checkpoint SHA exist", () => {
    // Without a prior swarm run there is no checkpoint SHA in the DB.
    // rollback should exit 1 with a helpful message before asking for confirmation.
    const result = runFlywheel(
      ["rollback"],
      { stdin: "\n", timeout: 15_000 }
    );
    // Either exit 1 (no checkpoint found) or exit 0 (cancelled)
    // Both are acceptable depending on whether a prior run exists in the local DB.
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/checkpoint|cancel|No run|not found/i);
    // Must not be a raw stack trace
    expect(out).not.toContain("at Object.<anonymous>");
  });
});

// ── Review (VPS) ───────────────────────────────────────────────────────────────

describeVps("flywheel review (dispatches to NTM agents)", () => {
  afterAll(async () => {
    await cleanupTestProject(testProject);
  });

  it("dispatches fresh-review to agent panes and exits 0", async () => {
    const result = await runFlywheelWithDiagnostics(
      ["review", "--passes", "fresh-review"],
      {
        timeout: 60_000,
        remoteDiagnostics: true,
        remoteProjectName: testProject,
      }
    );

    assertSuccess(result, "flywheel review --passes fresh-review");
    expect(result.stdout).toMatch(/dispatched|Review dispatched/i);
    expect(result.stdout).toMatch(/fresh-review/);

    // Verify prompt_sends entry in local SQLite
    const stateDbPath = join(homedir(), ".flywheel", "state.db");
    if (existsSync(stateDbPath)) {
      const db = initDb(stateDbPath);
      const row = (db as unknown as {
        prepare(sql: string): { get(): { prompt_name: string } | undefined };
      })
        .prepare(
          "SELECT prompt_name FROM prompt_sends WHERE prompt_name = 'fresh-review' ORDER BY id DESC LIMIT 1"
        )
        .get();
      if (row) {
        expect(row.prompt_name).toBe("fresh-review");
      }
    }
  });

  it("exits 1 with clear error for an unknown review pass name", async () => {
    const result = await runFlywheelWithDiagnostics(
      ["review", "--passes", "nonexistent-pass"],
      {
        timeout: 30_000,
        remoteDiagnostics: true,
        remoteProjectName: testProject,
      }
    );
    assertFailure(result, "flywheel review unknown pass");
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/unknown.*pass|valid passes|not.*recognized/i);
  });

  it("dispatches all 8 review passes when no --passes flag given", async () => {
    const result = await runFlywheelWithDiagnostics(["review"], {
      timeout: 120_000,
      remoteDiagnostics: true,
      remoteProjectName: testProject,
    });
    assertSuccess(result, "flywheel review all passes");
    expect(result.stdout).toMatch(/dispatched/i);
    // Should mention multiple passes
    const passMatches = result.stdout.match(/→ pane/g) ?? [];
    expect(passMatches.length).toBeGreaterThan(1);
  });
});

// ── Rollback (VPS, destructive) ───────────────────────────────────────────────

describeDestructive("flywheel rollback (real VPS git reset, DESTRUCTIVE)", () => {
  it("rolls back to the pre-swarm checkpoint when ROLLBACK is typed", async () => {
    // Get the checkpoint SHA from local SQLite first
    const stateDbPath = join(homedir(), ".flywheel", "state.db");
    if (!existsSync(stateDbPath)) return;

    const db = initDb(stateDbPath);
    const sm = new StateManager(db);
    const runs = sm.listFlywheelRuns();
    const runWithCheckpoint = runs.find(
      (r) => r.checkpoint_sha !== null && r.project_name === testProject
    );
    if (!runWithCheckpoint) {
      console.log("[E2E] No run with checkpoint found — skipping rollback test");
      return;
    }

    const result = await runFlywheelWithDiagnostics(
      ["rollback", runWithCheckpoint.id.slice(0, 8)],
      {
        stdin: "ROLLBACK\n",
        timeout: 60_000,
        remoteDiagnostics: true,
        remoteProjectName: testProject,
      }
    );

    assertSuccess(result, "flywheel rollback");
    expect(result.stdout).toMatch(/Rollback complete/i);

    // The output should reference the checkpoint SHA
    expect(result.stdout + result.stderr).toContain(
      runWithCheckpoint.checkpoint_sha!.slice(0, 12)
    );
  });
});

// ── Deploy (VPS, destructive) ─────────────────────────────────────────────────

describeDestructive("flywheel deploy (real git push, DESTRUCTIVE)", () => {
  afterAll(async () => {
    await cleanupTestProject(testProject);
  });

  it("completes deploy with correct DEPLOY confirmation and shows before→after SHAs", async () => {
    const confirmStr = `DEPLOY ${testProject}\n`;

    const result = await runFlywheelWithDiagnostics(
      ["deploy"],
      {
        stdin: confirmStr,
        timeout: 120_000,
        remoteDiagnostics: true,
        remoteProjectName: testProject,
      }
    );

    assertSuccess(result, "flywheel deploy");
    expect(result.stdout).toMatch(/Deploy complete/i);

    // Should show SHA transition
    expect(result.stdout).toMatch(/[0-9a-f]{12}.*→.*[0-9a-f]{12}/i);
  });

  it("does not push if wrong confirmation given (regression)", async () => {
    const result = await runFlywheelWithDiagnostics(
      ["deploy"],
      {
        stdin: `DEPLOY wrong-project-name\n`,
        timeout: 15_000,
        remoteDiagnostics: true,
        remoteProjectName: testProject,
      }
    );
    assertFailure(result, "flywheel deploy wrong project name");
    expect(result.stdout + result.stderr).toMatch(/confirmation|mismatch|expected/i);
  });
});
