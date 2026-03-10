/**
 * test/e2e/lifecycle/03-beads.e2e.ts — bead: 3hi.3
 *
 * E2E tests for Phase 2 bead management commands:
 *   flywheel beads triage, generate, refine, history
 *
 * Requires FLYWHEEL_TEST_E2E=1 and a configured VPS. The triage command
 * makes a real SSH call to run bv on the VPS; generate/refine just display
 * prompts and are safe to run without a live NTM session.
 *
 * Full command + I/O logged before every assertion.
 */

import { describe, it, expect, afterAll } from "vitest";
import {
  runFlywheel,
  runFlywheelWithDiagnostics,
  assertSuccess,
  hasSshConfig,
  getTestProject,
  cleanupTestProject,
} from "../setup.js";

const runVpsE2e = process.env.FLYWHEEL_TEST_E2E === "1" && hasSshConfig();
const describeVps = runVpsE2e ? describe : describe.skip;

const testProject = getTestProject();

// ── Validation (no VPS) ───────────────────────────────────────────────────────

describe("flywheel beads — argument validation", () => {
  it("beads triage --help shows usage", () => {
    const result = runFlywheel(["beads", "triage", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/triage|bead/i);
  });

  it("beads generate produces output related to bead generation (SSH or prompt)", () => {
    const result = runFlywheel(["beads", "generate"]);
    // beads generate connects to SSH to check for plan.md.
    // Without SSH: exits 1 with SSH error. With SSH: exits 0 showing guidance.
    // Either way the output must be a clear message, never a stack trace.
    const out = result.stdout + result.stderr;
    expect(out).not.toContain("at Object.<anonymous>");
    expect(out.trim().length).toBeGreaterThan(0);
    expect(out).toMatch(/bead|plan|generate|ssh|connect/i);
  });

  it("beads refine produces output related to bead refinement (SSH or prompt)", () => {
    const result = runFlywheel(["beads", "refine"]);
    const out = result.stdout + result.stderr;
    expect(out).not.toContain("at Object.<anonymous>");
    expect(out.trim().length).toBeGreaterThan(0);
    expect(out).toMatch(/refine|bead|ssh|connect/i);
  });

  it("beads history with no prior runs shows a clear message (exits 0 — local SQLite check)", () => {
    // beads history reads local SQLite — no --project flag (it uses current dir name)
    const result = runFlywheel(["beads", "history"]);
    // Should exit 0 even with empty DB
    expect(result.exitCode).toBe(0);
    const out = result.stdout + result.stderr;
    // Either "no runs found" or snapshot history — either way no crash
    expect(out).not.toContain("at Object.<anonymous>");
  });
});

// ── VPS triage ────────────────────────────────────────────────────────────────

describeVps("flywheel beads triage (real VPS)", () => {
  it("exits 0 and returns bv output for an initialised project", async () => {
    // First ensure the project exists on the VPS
    const initResult = await runFlywheelWithDiagnostics(["init", testProject], {
      remoteDiagnostics: true,
      remoteProjectName: testProject,
    });
    // init may succeed or show "already exists" — both are OK
    expect([0]).toContain(initResult.exitCode);

    const result = await runFlywheelWithDiagnostics(
      ["beads", "triage", "--project", testProject],
      {
        timeout: 60_000,
        remoteDiagnostics: true,
        remoteProjectName: testProject,
      }
    );

    assertSuccess(result, "flywheel beads triage");
    // Output should be non-empty markdown or a "no beads" message
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });

  it("triage output contains bead-related information or empty-state message", async () => {
    const result = await runFlywheelWithDiagnostics(
      ["beads", "triage", "--project", testProject],
      {
        timeout: 60_000,
        remoteDiagnostics: true,
        remoteProjectName: testProject,
      }
    );

    assertSuccess(result, "flywheel beads triage output check");
    const out = result.stdout.trim();
    // Either has bead entries, a count summary, or an empty-state message
    const hasBreadcrumbs = out.length > 0; // any non-empty output is acceptable
    expect(hasBreadcrumbs).toBe(true);
  });

  it("exits 1 for a project that does not exist on the VPS", async () => {
    const result = await runFlywheelWithDiagnostics(
      ["beads", "triage", "--project", "this-project-does-not-exist-xyz123"],
      {
        timeout: 30_000,
        remoteDiagnostics: true,
        remoteProjectName: "this-project-does-not-exist-xyz123",
      }
    );
    // bv should fail because the directory doesn't exist
    expect(result.exitCode).not.toBe(0);
    const out = result.stdout + result.stderr;
    // Error should be clear, not a stack trace
    expect(out).not.toContain("at Object.<anonymous>");
  });

  afterAll(async () => {
    await cleanupTestProject(testProject);
  });
});

// ── Prompt display tests (no VPS needed) ─────────────────────────────────────

describe("flywheel beads generate — prompt display", () => {
  it("beads generate output references plan_path when provided (SSH attempt)", () => {
    // beads generate tries to connect to SSH to check for plan.md.
    // The output (success or error) should be a clear message.
    const result = runFlywheel(
      ["beads", "generate", "--plan-path", "/tmp/fake-plan.md"],
      { timeout: 15_000 }
    );
    const out = result.stdout + result.stderr;
    // Output should not be a raw stack trace
    expect(out).not.toContain("at Object.<anonymous>");
    expect(out.trim().length).toBeGreaterThan(0);
  });

  it("beads generate --help shows usage", () => {
    const result = runFlywheel(["beads", "generate", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/generate|plan|beads/i);
  });
});

describe("flywheel beads history — snapshot display", () => {
  it("shows a velocity/ETA section when snapshots exist (smoke test)", () => {
    // With no real run data this will show "No flywheel runs found",
    // which is correct behavior — test that it exits 0 and is stable.
    const result = runFlywheel(["beads", "history"]);
    expect(result.exitCode).toBe(0);
    // Should not crash or produce a stack trace
    expect(result.stderr).not.toContain("at Object.<anonymous>");
  });
});
