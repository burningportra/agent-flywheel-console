/**
 * test/unit/index-helpers.test.ts — bead: agent-1879.6
 *
 * Tests parsePositiveInt() from cli/utils.ts.
 * (Extracted from the inline parseInt pattern used in cli/index.ts option parsing.)
 *
 * Covers:
 *   - Valid positive integers → parsed number returned
 *   - Invalid inputs → throws with flag name and bad value in message
 *   - Edge cases: 0, negative, float (parseInt truncates), NaN, empty
 */
import { describe, it, expect } from "vitest";
import { parsePositiveInt } from "../../cli/utils.js";

describe("parsePositiveInt — parse CLI option string as positive integer", () => {
  // ── Valid inputs ────────────────────────────────────────────────────────────

  it("'1' → 1", () => {
    expect(parsePositiveInt("1")).toBe(1);
  });

  it("'5' → 5", () => {
    expect(parsePositiveInt("5")).toBe(5);
  });

  it("'300' → 300 (large value)", () => {
    expect(parsePositiveInt("300")).toBe(300);
  });

  it("'1' with flagName → still returns 1", () => {
    expect(parsePositiveInt("1", "--top")).toBe(1);
  });

  it("'1.9' → 1 (parseInt truncates, 1 > 0 so it is accepted)", () => {
    // Document this edge case: parseInt('1.9') = 1, which passes > 0 check.
    // This is intentional — '--top 1.9' silently becomes --top 1.
    expect(parsePositiveInt("1.9")).toBe(1);
  });

  // ── Invalid inputs ──────────────────────────────────────────────────────────

  it("'0' → throws (not positive)", () => {
    expect(() => parsePositiveInt("0")).toThrow();
  });

  it("'-5' → throws (negative)", () => {
    expect(() => parsePositiveInt("-5")).toThrow();
  });

  it("'foo' → throws (NaN)", () => {
    expect(() => parsePositiveInt("foo")).toThrow();
  });

  it("'' (empty string) → throws", () => {
    expect(() => parsePositiveInt("")).toThrow();
  });

  it("'0.9' → throws (parseInt('0.9') = 0, not positive)", () => {
    expect(() => parsePositiveInt("0.9")).toThrow();
  });

  it("'-0' → throws (parseInt gives 0, not positive)", () => {
    expect(() => parsePositiveInt("-0")).toThrow();
  });

  // ── Error message quality ───────────────────────────────────────────────────

  it("error message includes the bad input value", () => {
    try {
      parsePositiveInt("abc", "--count");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e instanceof Error).toBe(true);
      expect((e as Error).message).toContain("abc");
    }
  });

  it("error message includes the flag name when provided", () => {
    try {
      parsePositiveInt("0", "--top");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("--top");
    }
  });

  it("error message includes a generic label when no flagName given", () => {
    try {
      parsePositiveInt("bad");
      expect.fail("should have thrown");
    } catch (e) {
      // Should still have a useful message
      expect((e as Error).message.length).toBeGreaterThan(0);
    }
  });
});
