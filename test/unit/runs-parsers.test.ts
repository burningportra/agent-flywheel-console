/**
 * test/unit/runs-parsers.test.ts
 * Covers exported helpers in cli/runs.ts:
 *   durationStr, costStr, parseSinceDuration
 * Imports the real implementations — no inline copies.
 */
import { describe, it, expect } from "vitest";
import { stripAnsi } from "../helpers.js";
import { durationStr, costStr, parseSinceDuration } from "../../cli/runs.js";

describe("durationStr (runs table formatter — must return PLAIN text, no ANSI)", () => {
  it("returns 'in progress' for null completedAt", () => {
    expect(durationStr("2026-01-01T00:00:00Z", null)).toBe("in progress");
  });
  it("formats seconds-only duration", () => {
    expect(durationStr("2026-01-01T00:00:00Z", "2026-01-01T00:00:30Z")).toBe("30s");
  });
  it("formats minutes and seconds", () => {
    expect(durationStr("2026-01-01T00:00:00Z", "2026-01-01T00:01:30Z")).toBe("1m 30s");
  });
  it("formats hours and minutes", () => {
    // 1 hour and 1 minute = 3660s
    expect(durationStr("2026-01-01T00:00:00Z", "2026-01-01T01:01:00Z")).toBe("1h 1m");
  });
  it("returns a plain string (no ANSI escape codes)", () => {
    const result = durationStr("2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z");
    expect(stripAnsi(result)).toBe(result); // no ANSI codes
    expect(result.length).toBe(result.length); // trivially true, but documents expectation
  });
  it("returns a plain string even for in progress (no chalk)", () => {
    const result = durationStr("2026-01-01T00:00:00Z", null);
    expect(stripAnsi(result)).toBe(result);
  });
});

describe("costStr (runs table formatter — must return PLAIN text)", () => {
  it("returns '—' for null cost", () => {
    expect(costStr(null)).toBe("—");
  });
  it("formats zero to four decimal places", () => {
    expect(costStr(0)).toBe("$0.0000");
  });
  it("formats a positive amount", () => {
    expect(costStr(1.2345)).toBe("$1.2345");
  });
  it("returns a plain string with no ANSI codes", () => {
    const result = costStr(0.5);
    expect(stripAnsi(result)).toBe(result);
  });
  it("the null case '—' is also plain text (no chalk.gray)", () => {
    const result = costStr(null);
    expect(stripAnsi(result)).toBe(result);
  });
});

describe("parseSinceDuration", () => {
  const within = (result: string, msAgo: number, tolerance = 5_000) =>
    Math.abs(Date.now() - new Date(result).getTime() - msAgo) < tolerance;

  it("passes through an ISO timestamp unchanged", () => {
    const ts = "2026-03-10T03:00:00Z";
    expect(parseSinceDuration(ts)).toBe(ts);
  });
  it("passes through a date-only string unchanged", () => {
    expect(parseSinceDuration("2026-03-10")).toBe("2026-03-10");
  });
  it("parses '1h' to ~1 hour ago", () => {
    expect(within(parseSinceDuration("1h"), 3_600_000)).toBe(true);
  });
  it("parses '30m' to ~30 minutes ago", () => {
    expect(within(parseSinceDuration("30m"), 1_800_000)).toBe(true);
  });
  it("parses '10s' to ~10 seconds ago", () => {
    expect(within(parseSinceDuration("10s"), 10_000, 3_000)).toBe(true);
  });
  it("throws on compound duration '2h30m'", () => {
    expect(() => parseSinceDuration("2h30m")).toThrow(/Invalid/);
  });
  it("throws on non-duration string 'yesterday'", () => {
    expect(() => parseSinceDuration("yesterday")).toThrow(/Invalid/);
  });
});
