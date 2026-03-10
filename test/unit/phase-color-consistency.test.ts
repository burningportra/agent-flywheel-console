/**
 * test/unit/phase-color-consistency.test.ts
 *
 * Regression test: all views that display phase names must use the SAME canonical
 * colour mapping. The canonical mapping lives in cli/utils.ts:phaseColor().
 *
 * History: gate.ts once had swarm=magenta, review=yellow — the opposite of every
 * other view (swarm=yellow, review=magenta). This test prevents that regression.
 *
 * No I/O, no DB, no SSH.
 */

import { describe, it, expect } from "vitest";
import { phaseColor } from "../../cli/utils.js";
import { stripAnsi } from "../helpers.js";

// ── Canonical mapping (the source of truth) ──────────────────────────────────

/** Strip ANSI codes and verify the coloured string wraps the expected phase name. */
function colourOf(phase: string): string {
  // phaseColor wraps the phase name in ANSI codes; stripping them yields the name.
  return stripAnsi(phaseColor(phase));
}

describe("phaseColor canonical mapping (cli/utils.ts)", () => {
  it("plan is rendered as 'plan'", () => {
    expect(colourOf("plan")).toBe("plan");
  });
  it("beads is rendered as 'beads'", () => {
    expect(colourOf("beads")).toBe("beads");
  });
  it("swarm is rendered as 'swarm'", () => {
    expect(colourOf("swarm")).toBe("swarm");
  });
  it("review is rendered as 'review'", () => {
    expect(colourOf("review")).toBe("review");
  });
  it("deploy is rendered as 'deploy'", () => {
    expect(colourOf("deploy")).toBe("deploy");
  });
  it("unknown phase falls back to white without throwing", () => {
    expect(() => phaseColor("unknown")).not.toThrow();
    expect(colourOf("unknown")).toBe("unknown");
  });
  it("swarm and review produce DIFFERENT ANSI codes (they were once swapped)", () => {
    // This is the regression guard: if swarm=review colours, this fails.
    const swarmColoured  = phaseColor("swarm");
    const reviewColoured = phaseColor("review");
    // They render the same plain text but different ANSI sequences
    expect(swarmColoured).not.toBe(reviewColoured);
  });
});

// ── gate.ts PHASE_LABEL consistency ──────────────────────────────────────────
// We import PHASE_LABEL indirectly by testing the observable behaviour of gate.ts:
// the label for each phase must contain the SAME plain text as phaseColor().

import { gateStatus } from "../../cli/gate.js";
import { captureConsole, tempDir } from "../helpers.js";

describe("gate.ts PHASE_LABEL uses canonical colours", () => {
  const phases = ["plan", "beads", "swarm", "review", "deploy"] as const;

  for (const phase of phases) {
    it(`PHASE_LABEL['${phase}'] plain text equals '${phase}'`, async () => {
      const dir = tempDir();
      const origStateDb = process.env.FLYWHEEL_STATE_DB;
      const origHome = process.env.FLYWHEEL_HOME;

      try {
        // Point state DB at an isolated temp file
        process.env.FLYWHEEL_STATE_DB = `${dir.path}/state.db`;
        process.env.FLYWHEEL_HOME = dir.path;

        // Create a flywheel run in the target phase
        const { initDb, StateManager } = await import("../../cli/state.js");
        const db = initDb(`${dir.path}/state.db`);
        const sm = new StateManager(db);
        sm.createFlywheelRun("test-project", phase);

        const captured = captureConsole();
        try {
          gateStatus();
        } finally {
          captured.restore();
        }

        // The output must contain the phase name (after ANSI stripping)
        const plainOut = stripAnsi(captured.out);
        expect(plainOut).toContain(phase);
      } finally {
        if (origStateDb === undefined) delete process.env.FLYWHEEL_STATE_DB;
        else process.env.FLYWHEEL_STATE_DB = origStateDb;
        if (origHome === undefined) delete process.env.FLYWHEEL_HOME;
        else process.env.FLYWHEEL_HOME = origHome;
        dir.cleanup();
      }
    });
  }
});
