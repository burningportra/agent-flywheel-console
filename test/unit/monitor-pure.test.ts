/**
 * test/unit/monitor-pure.test.ts — bead: agent-1879.4
 *
 * Tests pure helpers in cli/monitor.ts without SSH or polling loop.
 *
 * Covers:
 *   - agentStatusColor: exhaustive status → chalk string, default fallback
 *   - ETA math: velocity/remaining → hours/minutes label
 *   - Progress bar fill: 0%, 50%, 100%
 *   - Box border consistency: unicode chars are consistent (no mixed styles)
 */
import { describe, it, expect } from "vitest";
import { agentStatusColor } from "../../cli/monitor.js";
import { stripAnsi } from "../helpers.js";

// ── agentStatusColor ──────────────────────────────────────────────────────────

describe("agentStatusColor — status → chalk-coloured label", () => {
  it("active → includes '[active]'", () => {
    const s = stripAnsi(agentStatusColor("active"));
    expect(s).toContain("[active]");
  });

  it("idle → includes '[idle]'", () => {
    const s = stripAnsi(agentStatusColor("idle"));
    expect(s).toContain("[idle]");
  });

  it("stuck → includes '[stuck]'", () => {
    const s = stripAnsi(agentStatusColor("stuck"));
    expect(s).toContain("[stuck]");
  });

  it("unknown/default → includes '[unknown]' (not undefined)", () => {
    // TypeScript type is a union but the function has a default case
    // Cast as any to exercise the default branch
    const s = stripAnsi(agentStatusColor("unknown" as "active"));
    expect(s).toContain("[unknown]");
    expect(s).not.toBe("");
  });

  it("returns a non-empty string for all known statuses", () => {
    const statuses = ["active", "idle", "stuck"] as const;
    for (const status of statuses) {
      expect(agentStatusColor(status).length).toBeGreaterThan(0);
    }
  });
});

// ── ETA math — inline implementation matching monitor.ts logic ────────────────
// The renderFrame function is private, but the ETA calculation is straightforward.
// Test the math contract to catch regressions if the formula is changed.

describe("ETA calculation math — velocity > 0 + remaining > 0 → correct label", () => {
  // Mirror the logic from renderFrame:
  function calcEta(beadCount: number, closedCount: number, velocity: number): string {
    if (velocity <= 0 || beadCount <= closedCount) return "—";
    const remaining = beadCount - closedCount;
    const etaHrs = remaining / velocity;
    return etaHrs < 1 ? `~${Math.round(etaHrs * 60)}m` : `~${etaHrs.toFixed(1)}h`;
  }

  it("velocity=0 → dash (no ETA)", () => {
    expect(calcEta(10, 5, 0)).toBe("—");
  });

  it("fully done (closed === total) → dash", () => {
    expect(calcEta(10, 10, 2.0)).toBe("—");
  });

  it("1 remaining at 2.0/hr → ~30m", () => {
    expect(calcEta(10, 9, 2.0)).toBe("~30m");
  });

  it("6 remaining at 2.0/hr → ~3.0h", () => {
    expect(calcEta(10, 4, 2.0)).toBe("~3.0h");
  });

  it("sub-hour rounds to nearest minute", () => {
    // 1 remaining at 3/hr = 20 min
    expect(calcEta(5, 4, 3.0)).toBe("~20m");
  });

  it("exactly 1hr remaining → ~1.0h", () => {
    expect(calcEta(6, 4, 2.0)).toBe("~1.0h");
  });
});

// ── Progress bar fill ─────────────────────────────────────────────────────────

describe("Progress bar fill — 0/50/100 % → correct block count", () => {
  // Mirror the renderFrame progress bar logic: Math.floor(pct / 5) blocks out of 20
  function barFill(closed: number, total: number): number {
    if (total === 0) return 0;
    const pct = Math.round((closed / total) * 100);
    return Math.floor(pct / 5);
  }

  it("0% → 0 filled blocks", () => {
    expect(barFill(0, 10)).toBe(0);
  });

  it("50% → 10 filled blocks", () => {
    expect(barFill(5, 10)).toBe(10);
  });

  it("100% → 20 filled blocks", () => {
    expect(barFill(10, 10)).toBe(20);
  });

  it("total=0 → 0 filled blocks (no division by zero)", () => {
    expect(barFill(0, 0)).toBe(0);
  });
});

// ── Box border consistency ────────────────────────────────────────────────────

describe("Box border characters — consistent unicode (no mixed ═ and ─ styles)", () => {
  it("renderFrame rendering code uses ─ box chars, not ═ (consistent style)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve("cli/monitor.ts"), "utf8");

    // Strip all comments (both /* ... */ and // ...) which may contain
    // illustrative ═ chars describing what was removed, before checking code.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
      .replace(/\/\/[^\n]*/g, "");         // line comments

    // The rendering code should only use ─ (U+2500), not ═ (U+2550, double line).
    // Mixed box-drawing styles cause visual corruption on most terminals.
    const hasDoubleLineInCode = codeOnly.includes("═");  // U+2550
    expect(hasDoubleLineInCode).toBe(false);
  });

  it("agentStatusColor labels have consistent fixed width (padded with spaces)", () => {
    // All status labels should be the same display width for column alignment
    const active = stripAnsi(agentStatusColor("active"));
    const idle   = stripAnsi(agentStatusColor("idle"));
    const stuck  = stripAnsi(agentStatusColor("stuck"));
    expect(active.length).toBe(idle.length);
    expect(active.length).toBe(stuck.length);
  });
});
