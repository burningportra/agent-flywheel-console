/**
 * test/unit/deploy-confirmation.test.ts
 * Covers: cli/deploy.ts — assertDeployConfirmation, requiredDeployConfirmation
 * Pure logic, no I/O.
 */
import { describe, it, expect } from "vitest";
import {
  requiredDeployConfirmation,
  assertDeployConfirmation,
} from "../../cli/deploy.js";

describe("requiredDeployConfirmation", () => {
  it("returns DEPLOY + project name", () => {
    expect(requiredDeployConfirmation("myproject")).toBe("DEPLOY myproject");
  });
  it("handles hyphenated names", () => {
    expect(requiredDeployConfirmation("my-project")).toBe("DEPLOY my-project");
  });
  it("handles an empty project name", () => {
    expect(requiredDeployConfirmation("")).toBe("DEPLOY ");
  });
});

describe("assertDeployConfirmation", () => {
  it("does not throw on exact match", () => {
    expect(() =>
      assertDeployConfirmation("myproject", "DEPLOY myproject")
    ).not.toThrow();
  });
  it("throws on wrong case", () => {
    expect(() =>
      assertDeployConfirmation("myproject", "deploy myproject")
    ).toThrow(/exactly/);
  });
  it("throws on trailing space", () => {
    expect(() =>
      assertDeployConfirmation("myproject", "DEPLOY myproject ")
    ).toThrow();
  });
  it("throws on wrong project name", () => {
    expect(() =>
      assertDeployConfirmation("myproject", "DEPLOY other")
    ).toThrow();
  });
  it("throws on empty confirmation", () => {
    expect(() => assertDeployConfirmation("myproject", "")).toThrow();
  });
  it("throws on just DEPLOY with no project name", () => {
    expect(() => assertDeployConfirmation("myproject", "DEPLOY")).toThrow();
  });
});
