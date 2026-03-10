/**
 * test/unit/swarm-session.test.ts
 * Covers: cli/swarm.ts — defaultSessionName (exported pure helper)
 *         cli/beads.ts — parseDuration (exported pure helper)
 * Imports the real implementations — no inline copies.
 */
import { describe, it, expect } from "vitest";
import { defaultSessionName } from "../../cli/swarm.js";
import { parseDuration } from "../../cli/beads.js";

describe("defaultSessionName", () => {
  it("passes through a clean lowercase name unchanged", () => {
    expect(defaultSessionName("agent-flywheel-console")).toBe("agent-flywheel-console");
  });
  it("lowercases uppercase letters", () => {
    expect(defaultSessionName("MyProject")).toBe("myproject");
  });
  it("replaces spaces with dashes", () => {
    expect(defaultSessionName("my project")).toBe("my-project");
  });
  it("collapses multiple spaces into a single dash", () => {
    expect(defaultSessionName("my  project")).toBe("my-project");
  });
  it("trims leading and trailing whitespace", () => {
    expect(defaultSessionName("  myproject  ")).toBe("myproject");
  });
  it("strips special characters", () => {
    expect(defaultSessionName("project!@#name")).toBe("project-name");
  });
  it("strips leading dashes", () => {
    expect(defaultSessionName("-leading-dash")).toBe("leading-dash");
  });
  it("strips trailing dashes", () => {
    expect(defaultSessionName("trailing-dash-")).toBe("trailing-dash");
  });
  it("handles mixed case with dots", () => {
    expect(defaultSessionName("My.Project.v2")).toBe("my-project-v2");
  });
  it("handles an already-valid name", () => {
    expect(defaultSessionName("my-app-2")).toBe("my-app-2");
  });
  it("throws on empty string (all chars stripped)", () => {
    expect(() => defaultSessionName("")).toThrow();
  });
  it("throws when all chars are stripped (e.g. all-special input)", () => {
    expect(() => defaultSessionName("!@#$%^&*()")).toThrow();
  });
});


describe("parseDuration (beads.ts --at flag parser)", () => {
  it("passes through an ISO 8601 datetime unchanged", () => {
    const ts = "2026-03-10T03:00:00Z";
    expect(parseDuration(ts)).toBe(ts);
  });
  it("passes through a date-only string unchanged", () => {
    expect(parseDuration("2026-03-10")).toBe("2026-03-10");
  });

  const within = (result: string, expectedMs: number, toleranceMs = 5_000) => {
    const diff = Math.abs(Date.now() - new Date(result).getTime() - expectedMs);
    return diff < toleranceMs;
  };

  it("converts '1h' to roughly 1 hour ago", () => {
    expect(within(parseDuration("1h"), 3_600_000)).toBe(true);
  });
  it("converts '30m' to roughly 30 minutes ago", () => {
    expect(within(parseDuration("30m"), 1_800_000)).toBe(true);
  });
  it("converts '10s' to roughly 10 seconds ago", () => {
    expect(within(parseDuration("10s"), 10_000, 3_000)).toBe(true);
  });
  it("throws on unsupported compound duration like '1h30m'", () => {
    expect(() => parseDuration("1h30m")).toThrow(/Invalid/);
  });
  it("throws on non-numeric string", () => {
    expect(() => parseDuration("abc")).toThrow(/Invalid/);
  });
  it("'0h' results in a timestamp very close to now", () => {
    expect(within(parseDuration("0h"), 0, 2_000)).toBe(true);
  });
});
