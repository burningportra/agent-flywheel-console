/**
 * test/unit/gate-integration.test.ts
 *
 * Covers: cli/gate.ts — gateStatus(), gateAdvance()
 * Uses a real SQLite DB via FLYWHEEL_STATE_DB env var.
 * No mocks, no stubs. Tests the full gate state machine.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { gateStatus, gateAdvance } from "../../cli/gate.js";
import { initDb, StateManager } from "../../cli/state.js";
import { captureConsole, stripAnsi, tempDir } from "../helpers.js";

type TempDir = ReturnType<typeof tempDir>;

let dir: TempDir;
let sm: StateManager;
let origStateDb: string | undefined;
let origHome: string | undefined;

beforeEach(() => {
  dir = tempDir();
  origStateDb = process.env.FLYWHEEL_STATE_DB;
  origHome = process.env.FLYWHEEL_HOME;
  // Redirect all DB access to an isolated temp file
  process.env.FLYWHEEL_STATE_DB = `${dir.path}/state.db`;
  process.env.FLYWHEEL_HOME = dir.path;
  const db = initDb(`${dir.path}/state.db`);
  sm = new StateManager(db);
});

afterEach(() => {
  if (origStateDb === undefined) delete process.env.FLYWHEEL_STATE_DB;
  else process.env.FLYWHEEL_STATE_DB = origStateDb;
  if (origHome === undefined) delete process.env.FLYWHEEL_HOME;
  else process.env.FLYWHEEL_HOME = origHome;
  dir.cleanup();
});

// ── gateStatus ────────────────────────────────────────────────────────────────

describe("gateStatus()", () => {
  it("shows 'No flywheel runs' message on an empty DB", () => {
    const c = captureConsole();
    gateStatus();
    c.restore();
    expect(stripAnsi(c.out)).toContain("No flywheel runs");
  });

  it("shows the current phase for an existing run", () => {
    sm.createFlywheelRun("my-project", "swarm");
    const c = captureConsole();
    gateStatus();
    c.restore();
    const out = stripAnsi(c.out);
    expect(out).toContain("swarm");
    expect(out).toContain("my-project");
  });

  it("shows 'waiting' gate status before gate is advanced", () => {
    sm.createFlywheelRun("p", "plan");
    const c = captureConsole();
    gateStatus();
    c.restore();
    expect(stripAnsi(c.out)).toContain("waiting");
  });

  it("shows next phase command hint", () => {
    sm.createFlywheelRun("p", "plan");
    const c = captureConsole();
    gateStatus();
    c.restore();
    // After plan phase, next command should reference beads
    const out = stripAnsi(c.out);
    expect(out).toMatch(/beads|generate/i);
  });

  it("shows 'terminal phase' for deploy phase", () => {
    sm.createFlywheelRun("p", "deploy");
    const c = captureConsole();
    gateStatus();
    c.restore();
    expect(stripAnsi(c.out)).toContain("terminal");
  });

  it("shows the run ID (first 12 chars)", () => {
    const id = sm.createFlywheelRun("p", "review");
    const c = captureConsole();
    gateStatus();
    c.restore();
    expect(stripAnsi(c.out)).toContain(id.slice(0, 12));
  });
});

// ── gateAdvance ───────────────────────────────────────────────────────────────

describe("gateAdvance()", () => {
  it("advances from plan → beads and logs the transition", () => {
    const id = sm.createFlywheelRun("p", "plan");
    const c = captureConsole();
    gateAdvance();
    c.restore();

    const run = sm.getFlywheelRun(id);
    expect(run?.phase).toBe("beads");
    expect(run?.gate_passed_at).not.toBeNull();
  });

  it("output confirms the phase transition", () => {
    sm.createFlywheelRun("p", "plan");
    const c = captureConsole();
    gateAdvance();
    c.restore();
    const out = stripAnsi(c.out);
    expect(out).toContain("plan");
    expect(out).toContain("beads");
  });

  it("stores checkpoint SHA when --sha is provided", () => {
    const id = sm.createFlywheelRun("p", "swarm");
    const sha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    gateAdvance({ sha });
    expect(sm.getFlywheelRun(id)?.checkpoint_sha).toBe(sha);
  });

  it("logs a gate_advanced event with phaseFrom recorded", () => {
    const id = sm.createFlywheelRun("p", "plan");
    gateAdvance();
    const events = sm.getEvents(id);
    const evt = events.find((e) => e.event_type === "gate_advanced");
    expect(evt).toBeDefined();
    expect(evt?.phase_from).toBe("plan");
    expect(evt?.phase_to).toBe("beads");
    expect(evt?.actor).toBe("human");
  });

  it("targets a specific run when --run is provided", () => {
    // Create two runs; advance only the second by ID
    sm.createFlywheelRun("project-a", "plan");
    const id2 = sm.createFlywheelRun("project-b", "beads");

    gateAdvance({ runId: id2 });

    const r2 = sm.getFlywheelRun(id2);
    expect(r2?.phase).toBe("swarm");
  });

  it("advances through all phases: plan→beads→swarm→review→deploy", () => {
    const id = sm.createFlywheelRun("p", "plan");
    const sequence = ["beads", "swarm", "review", "deploy"] as const;
    for (const expected of sequence) {
      gateAdvance({ runId: id });
      expect(sm.getFlywheelRun(id)?.phase).toBe(expected);
    }
  });

  it("calls process.exit(0) at terminal phase (deploy) with a user-readable message", () => {
    sm.createFlywheelRun("p", "deploy");
    const c = captureConsole();
    // gateAdvance calls process.exit(0) for the terminal phase — catch it
    let exitCode: number | undefined;
    const origExit = process.exit.bind(process);
    (process as NodeJS.Process & { exit: (code?: number) => never }).exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
    try {
      gateAdvance();
    } catch {
      // expected
    } finally {
      (process as NodeJS.Process & { exit: (code?: number) => never }).exit = origExit as typeof process.exit;
      c.restore();
    }
    // Should have called process.exit(0) (not 1 — not an error)
    expect(exitCode).toBe(0);
    // Output should explain why (terminal phase message)
    const out = stripAnsi(c.out);
    expect(out).toMatch(/terminal|deploy/i);
  });
});
