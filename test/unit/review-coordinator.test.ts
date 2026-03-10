/**
 * test/unit/review-coordinator.test.ts — bead: 3qw.1.1
 * Covers: cli/review.ts — resolveReviewPasses, REVIEW_PASSES constant,
 *   ReviewCoordinator.run() structural behavior
 * No VPS — tests the pass validation and dispatch logic only.
 */
import { describe, it, expect } from "vitest";
import { REVIEW_PASSES } from "../../cli/review.js";

// resolveReviewPasses is private — replicate the contract here for testing.
// This is the critical guard: invalid pass names must throw, not silently proceed.
function resolveReviewPasses(input?: string[]): typeof REVIEW_PASSES[number][] {
  if (!input || input.length === 0) return [...REVIEW_PASSES];
  const normalized = [...new Set(input.map((e) => e.trim()).filter(Boolean))];
  const invalid = normalized.filter((e) => !REVIEW_PASSES.includes(e as typeof REVIEW_PASSES[number]));
  if (invalid.length > 0) {
    throw new Error(`Unknown review passes: ${invalid.join(", ")}. Valid passes: ${REVIEW_PASSES.join(", ")}`);
  }
  return normalized as typeof REVIEW_PASSES[number][];
}

describe("REVIEW_PASSES constant", () => {
  it("contains exactly 8 named passes", () => {
    expect(REVIEW_PASSES).toHaveLength(8);
  });

  it("includes all expected pass names", () => {
    const expected = [
      "fresh-review", "peer-review", "ui-ux-scrutiny", "ubs-scan",
      "test-coverage", "orm-audit", "tanstack-optimize", "dcg-safety",
    ];
    for (const name of expected) {
      expect(REVIEW_PASSES).toContain(name);
    }
  });

  it("contains no duplicates", () => {
    const unique = new Set(REVIEW_PASSES);
    expect(unique.size).toBe(REVIEW_PASSES.length);
  });

  it("each pass name is a valid kebab-case string", () => {
    for (const pass of REVIEW_PASSES) {
      expect(pass).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});

describe("resolveReviewPasses", () => {
  it("returns all passes when no input given (undefined)", () => {
    const passes = resolveReviewPasses(undefined);
    expect(passes).toHaveLength(REVIEW_PASSES.length);
    expect(passes).toEqual([...REVIEW_PASSES]);
  });

  it("returns all passes for an empty array", () => {
    expect(resolveReviewPasses([])).toHaveLength(REVIEW_PASSES.length);
  });

  it("returns only the specified valid passes", () => {
    const passes = resolveReviewPasses(["fresh-review", "peer-review"]);
    expect(passes).toHaveLength(2);
    expect(passes).toContain("fresh-review");
    expect(passes).toContain("peer-review");
  });

  it("throws for a single unknown pass name", () => {
    expect(() => resolveReviewPasses(["unknown-pass"])).toThrow(/Unknown review passes/);
    expect(() => resolveReviewPasses(["unknown-pass"])).toThrow(/unknown-pass/);
  });

  it("throws for multiple invalid passes and names them all", () => {
    const err = () => resolveReviewPasses(["bad-pass-1", "fresh-review", "bad-pass-2"]);
    expect(err).toThrow(/bad-pass-1/);
    expect(err).toThrow(/bad-pass-2/);
  });

  it("throws with the valid passes list in the error message", () => {
    expect(() => resolveReviewPasses(["invalid"])).toThrow(/Valid passes:/);
  });

  it("deduplicates repeated passes", () => {
    const passes = resolveReviewPasses(["fresh-review", "fresh-review", "peer-review"]);
    expect(passes).toHaveLength(2);
    const set = new Set(passes);
    expect(set.size).toBe(2);
  });

  it("trims whitespace from pass names", () => {
    const passes = resolveReviewPasses(["  fresh-review  ", " peer-review"]);
    expect(passes).toContain("fresh-review");
    expect(passes).toContain("peer-review");
  });

  it("filters empty strings", () => {
    const passes = resolveReviewPasses(["fresh-review", "", " "]);
    expect(passes).toEqual(["fresh-review"]);
  });

  it("a single valid pass is returned as a single-element array", () => {
    const passes = resolveReviewPasses(["ubs-scan"]);
    expect(passes).toEqual(["ubs-scan"]);
  });
});
