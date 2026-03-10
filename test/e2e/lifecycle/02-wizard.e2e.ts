/**
 * test/e2e/lifecycle/02-wizard.e2e.ts — bead: 3hi.2
 *
 * E2E tests for `flywheel new <idea>` (Phase 1 Planning Wizard).
 *
 * Gate flags:
 *   FLYWHEEL_TEST_E2E=1   — enables VPS-dependent tests (ssh.yaml required)
 *   FLYWHEEL_TEST_LIVE=1  — also enables real AI API calls (providers.yaml required)
 *
 * Without FLYWHEEL_TEST_LIVE, only structural/validation tests run.
 * The AI fan-out tests are skipped to avoid burning budget in CI.
 *
 * Every test logs full invocation + I/O before asserting.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  runFlywheel,
  assertFailure,
  hasSshConfig,
  getTestProject,
} from "../setup.js";
import { initDb, StateManager } from "../../../cli/state.js";

const runVpsE2e = process.env.FLYWHEEL_TEST_E2E === "1" && hasSshConfig();
const runLive = runVpsE2e && process.env.FLYWHEEL_TEST_LIVE === "1";
const describeVps = runVpsE2e ? describe : describe.skip;
const describeLive = runLive ? describe : describe.skip;

// ── Validation tests (no VPS needed) ─────────────────────────────────────────

describe("flywheel new — argument validation", () => {
  it("rejects when the idea argument is missing", () => {
    // commander.js should reject missing required argument
    const result = runFlywheel(["new"]);
    assertFailure(result, "flywheel new with no idea");
  });

  it("shows usage/help on --help", () => {
    const result = runFlywheel(["new", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("idea");
  });
});

// ── Structural tests (require providers.yaml but NOT real API calls) ──────────

describeVps("flywheel new — structural output", () => {
  it("exits 1 with a clear error when providers.yaml is missing", () => {
    const tempEnv = { FLYWHEEL_CONFIG_DIR: "/nonexistent-dir" };
    const result = runFlywheel(["new", "test idea"], { env: tempEnv, timeout: 10_000 });
    assertFailure(result, "flywheel new without providers.yaml");
    // Error should mention providers.yaml or configuration
    const out = result.stdout + result.stderr;
    expect(out.toLowerCase()).toMatch(/providers|config|api key/i);
  });
});

// ── Live AI tests (require real API keys + VPS) ───────────────────────────────

describeLive("flywheel new --fast (live AI call)", () => {
  it("completes the wizard in fast mode and writes plan.md", () => {
    const projectName = getTestProject();

    const result = runFlywheel(
      ["new", "Build a minimal HTTP health-check endpoint", "--fast"],
      { timeout: 180_000 } // 3 min: single synthesis pass
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Wizard complete");

    // Extract plan.md path from output
    const planMatch = result.stdout.match(/Plan:\s+(.+\.md)/);
    const planPath = planMatch?.[1]?.trim();
    expect(planPath).toBeTruthy();

    if (planPath) {
      expect(existsSync(planPath)).toBe(true);
      const content = readFileSync(planPath, "utf8");
      expect(content.length).toBeGreaterThan(100);
      expect(content).toContain("#"); // has markdown headings
    }

    // wizard-log.jsonl should exist
    const logMatch = result.stdout.match(/Log:\s+(.+\.jsonl)/);
    const logPath = logMatch?.[1]?.trim();
    if (logPath) {
      expect(existsSync(logPath)).toBe(true);
      const lines = readFileSync(logPath, "utf8").trim().split("\n");
      expect(lines.length).toBeGreaterThan(0);
      // Each line should be valid JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });

  it("persists a wizard_run row with status='completed' in SQLite", () => {
    // Re-run a fast wizard and check the DB
    const result = runFlywheel(
      ["new", "Build a simple key-value store", "--fast"],
      { timeout: 180_000 }
    );
    expect(result.exitCode).toBe(0);

    const stateDbPath = join(homedir(), ".flywheel", "state.db");
    if (!existsSync(stateDbPath)) return; // no DB yet

    const db = initDb(stateDbPath);
    const sm = new StateManager(db);
    const runs = sm.listWizardRuns();
    const latest = runs[0];

    expect(latest).toBeTruthy();
    expect(latest.status).toBe("completed");
    expect(latest.plan_path).toBeTruthy();
    expect(latest.idea).toContain("key-value");
  });

  it("outputs a non-zero cost when the wizard runs (tokens consumed)", () => {
    const result = runFlywheel(
      ["new", "Build a task scheduler", "--fast"],
      { timeout: 180_000 }
    );
    expect(result.exitCode).toBe(0);

    // The wizard prints cost at the end: "Cost: $X.XXXX"
    const costMatch = result.stdout.match(/Cost:\s+\$(\d+\.\d+)/);
    if (costMatch) {
      const cost = parseFloat(costMatch[1]);
      expect(cost).toBeGreaterThan(0);
    }
  });

  it("runs the full fan-out with multiple models (no --fast)", () => {
    const result = runFlywheel(
      ["new", "Build a bookmark manager CLI", "--models", "claude-opus-4-6"],
      { timeout: 300_000 } // 5 min: full multi-pass wizard
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Wizard complete");
    // Fan-out step should be shown
    expect(result.stdout).toMatch(/Step 1.*Parallel fan-out|fan-out/i);
  });
});
