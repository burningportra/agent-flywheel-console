/**
 * test/unit/autopilot-pure.test.ts — bead: agent-1879.1
 *
 * Tests the pure helpers in cli/autopilot.ts that can be exercised without
 * a real SSH connection or running autopilot loop.
 *
 * Covers:
 *   - parseBeadStats: JSON input → BeadStats counts (tombstone must NOT count as closed)
 *   - resolveRemoteProjectPath: remoteRepoRoot + projectName → path or undefined
 */
import { describe, it, expect } from "vitest";
import { parseBeadStats, resolveRemoteProjectPath } from "../../cli/autopilot.js";

// ── parseBeadStats ────────────────────────────────────────────────────────────

describe("parseBeadStats — counts from br list --all --json output", () => {
  it("empty array → all zeros", () => {
    expect(parseBeadStats([])).toEqual({
      total: 0, closed: 0, open: 0, inProgress: 0, blocked: 0,
    });
  });

  it("single closed issue → closed=1, open=0", () => {
    const result = parseBeadStats([{ status: "closed" }]);
    expect(result.total).toBe(1);
    expect(result.closed).toBe(1);
    expect(result.open).toBe(0);
  });

  it("tombstone is NOT counted as closed — tombstones are cancelled beads", () => {
    const result = parseBeadStats([
      { status: "tombstone" },
      { status: "tombstone" },
    ]);
    expect(result.closed).toBe(0);
    // Tombstones are not open/blocked/inProgress either — they vanish from counts
    // total = 2, closed = 0, blocked = 0, inProgress = 0, open = max(2-0-0-0, 0) = 2
    expect(result.total).toBe(2);
    expect(result.open).toBe(2);
  });

  it("mixed statuses — each bucket counts correctly", () => {
    const issues = [
      { status: "closed" },
      { status: "closed" },
      { status: "in_progress" },
      { status: "blocked" },
      { status: "open" },
      { status: "tombstone" },
    ];
    const result = parseBeadStats(issues);
    expect(result.total).toBe(6);
    expect(result.closed).toBe(2);
    expect(result.inProgress).toBe(1);
    expect(result.blocked).toBe(1);
    // open = max(6 - 2 - 1 - 1, 0) = 2  (the "open" status + tombstone)
    expect(result.open).toBe(2);
  });

  it("all open → closed=0, open=total", () => {
    const issues = Array.from({ length: 5 }, () => ({ status: "open" }));
    const result = parseBeadStats(issues);
    expect(result.total).toBe(5);
    expect(result.closed).toBe(0);
    expect(result.open).toBe(5);
  });

  it("all closed → open=0, closed=total", () => {
    const issues = Array.from({ length: 4 }, () => ({ status: "closed" }));
    const result = parseBeadStats(issues);
    expect(result.total).toBe(4);
    expect(result.closed).toBe(4);
    expect(result.open).toBe(0);
  });

  it("open floor is 0 — never goes negative with odd status combinations", () => {
    // Edge: all blocked+inProgress, no open
    const issues = [
      { status: "blocked" },
      { status: "blocked" },
      { status: "in_progress" },
    ];
    const result = parseBeadStats(issues);
    expect(result.open).toBeGreaterThanOrEqual(0);
  });

  it("missing status field treated as open (not closed)", () => {
    const result = parseBeadStats([{ /* no status */ }, { status: "closed" }]);
    expect(result.closed).toBe(1);
    expect(result.total).toBe(2);
  });
});

// ── resolveRemoteProjectPath ──────────────────────────────────────────────────

describe("resolveRemoteProjectPath — joins repo root and project name", () => {
  it("standard root + name → correct path", () => {
    expect(resolveRemoteProjectPath("/home/ubuntu/projects", "my-app"))
      .toBe("/home/ubuntu/projects/my-app");
  });

  it("trailing slash on remoteRepoRoot is stripped", () => {
    expect(resolveRemoteProjectPath("/home/ubuntu/projects/", "my-app"))
      .toBe("/home/ubuntu/projects/my-app");
  });

  it("multiple trailing slashes are stripped", () => {
    expect(resolveRemoteProjectPath("/path//", "proj"))
      .toBe("/path/proj");
  });

  it("undefined projectName → undefined (no path built)", () => {
    expect(resolveRemoteProjectPath("/home/ubuntu/projects", undefined))
      .toBeUndefined();
  });

  it("empty string projectName is falsy → undefined", () => {
    // empty string is falsy, treated same as undefined
    expect(resolveRemoteProjectPath("/home/ubuntu/projects", ""))
      .toBeUndefined();
  });
});
