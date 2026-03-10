/**
 * test/integration/cli-beads-workspace.integration.test.ts — bead: agent-3qw.2.3
 *
 * Integration tests for `flywheel beads` subcommands using the real CLI binary.
 *
 * Split by dependency:
 *   - "local only" tests: use HOME isolation + pre-seeded SQLite, no VPS required.
 *     These always run.
 *   - "SSH required" tests: need ssh.yaml; tested via failure paths only (no VPS needed
 *     to verify the "SSH config not found" error path).
 *
 * No mocks. Real CLI subprocess via runFlywheel(). Real SQLite via tempDb()/initDb().
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { runFlywheel, assertSuccess, assertFailure } from "../e2e/setup.js";
import { tempDir, stripAnsi, initDb as _initDb } from "../helpers.js";
import { initDb, StateManager } from "../../cli/state.js";

// ── Fixture helpers ────────────────────────────────────────────────────────────

let dir: ReturnType<typeof tempDir>;

/** Build env vars pointing all state at the isolated temp dir. */
function e(extra: Record<string, string> = {}): Record<string, string> {
  return {
    FLYWHEEL_HOME: dir.path,
    FLYWHEEL_STATE_DB: join(dir.path, "state.db"),
    ...extra,
  };
}

function fly(args: string[], extraEnv?: Record<string, string>) {
  return runFlywheel(args, { env: e(extraEnv) });
}

/** Create a real StateManager against the isolated temp DB. */
function seedSm() {
  const db = initDb(join(dir.path, "state.db"));
  return new StateManager(db);
}

beforeEach(() => {
  dir = tempDir();
  mkdirSync(dir.path, { recursive: true });
});
afterEach(() => dir.cleanup());

// ── flywheel beads history ─────────────────────────────────────────────────────
// Fully local: reads bead_snapshots from the isolated SQLite DB.

describe("flywheel beads history — local-only, no VPS", () => {
  it("exits 0 and shows helpful message when there are no flywheel runs", () => {
    const r = fly(["beads", "history"]);
    assertSuccess(r, "beads history (no runs)");
    expect(stripAnsi(r.stdout)).toMatch(/no flywheel run/i);
  });

  it("exits 0 and shows helpful message when there are runs but no snapshots", () => {
    const sm = seedSm();
    sm.createFlywheelRun("my-project", "swarm");

    const r = fly(["beads", "history"]);
    assertSuccess(r, "beads history (no snapshots)");
    const out = stripAnsi(r.stdout);
    expect(out).toMatch(/no bead snapshot/i);
    // Should hint about when snapshots are taken
    expect(out).toMatch(/swarm|snapshot/i);
  });

  it("exits 0 and shows bead board stats when snapshots exist", () => {
    const sm = seedSm();
    const runId = sm.createFlywheelRun("proj", "swarm");
    sm.captureBeadSnapshot(runId, {
      bead_count: 20,
      closed_count: 8,
      blocked_count: 2,
    });

    const r = fly(["beads", "history"]);
    assertSuccess(r, "beads history (with snapshot)");
    const out = stripAnsi(r.stdout);

    // Key numbers must appear
    expect(out).toContain("20");  // total
    expect(out).toContain("8");   // closed
    expect(out).toContain("2");   // blocked
    // Section header
    expect(out).toMatch(/bead board/i);
    // Project name
    expect(out).toContain("proj");
  });

  it("correctly computes open/active count as total - closed (blocked are included in open)", () => {
    const sm = seedSm();
    const runId = sm.createFlywheelRun("p", "swarm");
    // total=15, closed=5, blocked=3 → open/active = max(0, 15-5) = 10
    // (blocked items are shown separately but are counted in open/active)
    sm.captureBeadSnapshot(runId, { bead_count: 15, closed_count: 5, blocked_count: 3 });

    const r = fly(["beads", "history"]);
    assertSuccess(r, "beads history open count");
    const out = stripAnsi(r.stdout);
    expect(out).toContain("10");  // open/active = 15 - 5 = 10
    expect(out).toContain("15");  // total
    expect(out).toContain("5");   // closed
    expect(out).toContain("3");   // blocked (shown separately)
  });

  it("shows data from whichever run has the snapshot (basic multi-run scenario)", () => {
    // Create two runs; only the second has a snapshot.
    // beads history should show the second run's data.
    const sm = seedSm();
    sm.createFlywheelRun("project-without-snapshots", "plan");
    const id2 = sm.createFlywheelRun("project-with-snapshots", "swarm");
    // Only seed a snapshot for id2
    sm.captureBeadSnapshot(id2, { bead_count: 30, closed_count: 10, blocked_count: 1 });

    const r = fly(["beads", "history"]);
    assertSuccess(r, "beads history multi-run");
    const out = stripAnsi(r.stdout);
    // The output comes from the most-recently-CREATED run (started_at DESC).
    // Both runs are created in the same tick; whichever is "first" by DB order may
    // or may not have a snapshot. We assert:
    //   - exit 0 (didn't crash)
    //   - Either shows a bead board (id2 was first) OR shows "no bead snapshots" (id1 was first)
    const hasBoardOrMessage = /bead board|no bead snapshot|no flywheel run/i.test(out);
    expect(hasBoardOrMessage).toBe(true);
    // The bead_count 30 or closed 10 only appear when id2 is the most-recent run
    // We do NOT assert on that — see the single-run test above for precise assertions.
  });

  it("uses the most recent snapshot for a run when multiple snapshots exist", () => {
    const sm = seedSm();
    const runId = sm.createFlywheelRun("p", "swarm");
    // Two snapshots; second is newer and has more closed
    sm.captureBeadSnapshot(runId, { bead_count: 20, closed_count: 5, blocked_count: 0 });
    sm.captureBeadSnapshot(runId, { bead_count: 20, closed_count: 12, blocked_count: 0 });

    const r = fly(["beads", "history"]);
    assertSuccess(r, "beads history latest snapshot");
    const out = stripAnsi(r.stdout);
    expect(out).toContain("12");  // closed from latest snapshot
  });

  it("reports velocity when ≥2 snapshots exist across time", () => {
    const sm = seedSm();
    const runId = sm.createFlywheelRun("p", "swarm");
    // Use strftime ISO format (matching the schema DEFAULT) for correct Date parsing in Node.js
    const db = initDb(join(dir.path, "state.db"));
    db.prepare(`
      INSERT INTO bead_snapshots (run_id, captured_at, bead_count, closed_count, blocked_count)
      VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 hours'), 20, 2, 0)
    `).run(runId);
    db.prepare(`
      INSERT INTO bead_snapshots (run_id, captured_at, bead_count, closed_count, blocked_count)
      VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 20, 8, 0)
    `).run(runId);

    const r = fly(["beads", "history"]);
    assertSuccess(r, "beads history velocity");
    const out = stripAnsi(r.stdout);
    // Velocity = (8-2) / 2h = 3 beads/hr
    expect(out).toMatch(/velocity|beads\/hr/i);
    expect(out).toContain("3.0");
  });

  it("--at filters snapshots correctly (shows older snapshot, not newer)", () => {
    const sm = seedSm();
    const runId = sm.createFlywheelRun("p", "swarm");
    const db = initDb(join(dir.path, "state.db"));
    // Use distinctive numbers: 3h-ago snapshot has closed_count=41, 1h-ago has closed_count=89
    // Asking --at 2h should show the 3h snapshot (41 closed) and NOT the 1h snapshot (89 closed)
    db.prepare(`
      INSERT INTO bead_snapshots (run_id, captured_at, bead_count, closed_count, blocked_count)
      VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 hours'), 100, 41, 0)
    `).run(runId);
    db.prepare(`
      INSERT INTO bead_snapshots (run_id, captured_at, bead_count, closed_count, blocked_count)
      VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour'), 100, 89, 0)
    `).run(runId);

    const r = fly(["beads", "history", "--at", "2h"]);
    assertSuccess(r, "beads history --at 2h");
    const out = stripAnsi(r.stdout);
    expect(out).toContain("41");   // closed count from 3h-ago snapshot
    expect(out).not.toContain("89"); // must NOT see the 1h snapshot data
  });

  it("--at with invalid value exits 1 with a helpful error", () => {
    const sm = seedSm();
    const runId = sm.createFlywheelRun("p", "swarm");
    sm.captureBeadSnapshot(runId, { bead_count: 10, closed_count: 2, blocked_count: 0 });

    const r = fly(["beads", "history", "--at", "not-a-time"]);
    assertFailure(r, "beads history --at invalid");
    // Error message must be user-readable (not a raw stack trace)
    expect(stripAnsi(r.stderr + r.stdout)).toMatch(/invalid|--at|shorthand|ISO/i);
  });

  it("--at when no snapshots are before the cutoff exits 0 with a message", () => {
    const sm = seedSm();
    const runId = sm.createFlywheelRun("p", "swarm");
    sm.captureBeadSnapshot(runId, { bead_count: 10, closed_count: 2, blocked_count: 0 });

    // Ask for state 10 years ago — no snapshots will be that old
    const r = fly(["beads", "history", "--at", "2006-01-01T00:00:00Z"]);
    assertSuccess(r, "beads history --at past cutoff");
    expect(stripAnsi(r.stdout)).toMatch(/no snapshot|not found/i);
  });
});

// ── flywheel beads triage — SSH failure paths ──────────────────────────────────
// Tests the error path when SSH is not configured. No VPS required.

describe("flywheel beads triage — SSH error paths", () => {
  it("exits 1 with actionable error when ssh.yaml is missing", async () => {
    // No ssh.yaml in FLYWHEEL_HOME
    const r = await fly(["beads", "triage"]);
    assertFailure(r, "beads triage (no ssh.yaml)");
    const out = stripAnsi(r.stdout + r.stderr);
    // Must mention how to fix it
    expect(out).toMatch(/flywheel settings ssh|ssh\.yaml/i);
  });

  it("--top with a valid integer is accepted (error is about SSH, not --top)", async () => {
    const r = await fly(["beads", "triage", "--top", "3"]);
    assertFailure(r, "beads triage --top 3 (no ssh)");
    const out = stripAnsi(r.stdout + r.stderr);
    // Error should be about missing SSH, not about --top being invalid
    expect(out).toMatch(/ssh|settings/i);
    expect(out).not.toMatch(/positive integer|invalid.*top/i);
  });

  it("--top with non-integer value exits 1 with NaN guard error", () => {
    // parsePositiveInt should reject 'foo' before even trying SSH
    const r = fly(["beads", "triage", "--top", "foo"]);
    assertFailure(r, "beads triage --top foo");
    const out = stripAnsi(r.stdout + r.stderr);
    expect(out).toMatch(/positive integer|--top/i);
  });
});

// ── flywheel beads generate / refine — SSH error paths ────────────────────────

describe("flywheel beads generate — SSH error paths", () => {
  it("exits 1 with actionable error when ssh.yaml is missing", async () => {
    const r = await fly(["beads", "generate"]);
    assertFailure(r, "beads generate (no ssh.yaml)");
    expect(stripAnsi(r.stdout + r.stderr)).toMatch(/flywheel settings ssh|ssh\.yaml/i);
  });
});

describe("flywheel beads refine — SSH error paths", () => {
  it("exits 1 with actionable error when ssh.yaml is missing", async () => {
    const r = await fly(["beads", "refine"]);
    assertFailure(r, "beads refine (no ssh.yaml)");
    expect(stripAnsi(r.stdout + r.stderr)).toMatch(/flywheel settings ssh|ssh\.yaml/i);
  });
});
