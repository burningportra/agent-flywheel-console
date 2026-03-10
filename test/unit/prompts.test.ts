/**
 * test/unit/prompts.test.ts
 * Covers: cli/prompts.ts — substituteVariables, parseVarArgs, loadPrompts, getPrompt
 * Uses the real prompts.yaml — no mocking.
 */
import { describe, it, expect } from "vitest";
import {
  substituteVariables,
  parseVarArgs,
  loadPrompts,
  getPrompt,
} from "../../cli/prompts.js";

describe("substituteVariables", () => {
  it("substitutes a single variable", () => {
    expect(substituteVariables("Read the plan at {plan_path}", { plan_path: "/tmp/plan.md" }))
      .toBe("Read the plan at /tmp/plan.md");
  });

  it("substitutes multiple variables", () => {
    expect(
      substituteVariables("{a} and {b}", { a: "hello", b: "world" })
    ).toBe("hello and world");
  });

  it("leaves unresolved variables as-is with braces", () => {
    expect(substituteVariables("{unresolved}", {})).toBe("{unresolved}");
  });

  it("returns text unchanged when no variables present", () => {
    expect(substituteVariables("plain text", { key: "val" })).toBe("plain text");
  });

  it("handles empty string", () => {
    expect(substituteVariables("", { k: "v" })).toBe("");
  });

  it("handles a variable value that contains braces", () => {
    const result = substituteVariables("{var}", { var: "{nested}" });
    // Should NOT double-substitute — result is '{nested}' as a value
    expect(result).toBe("{nested}");
  });
});

describe("parseVarArgs", () => {
  it("parses key=value pairs", () => {
    expect(parseVarArgs(["plan_path=/tmp/plan.md"])).toEqual({ plan_path: "/tmp/plan.md" });
  });

  it("splits on first = only (value may contain =)", () => {
    expect(parseVarArgs(["key=val=ue"])).toEqual({ key: "val=ue" });
  });

  it("handles multiple pairs", () => {
    expect(parseVarArgs(["a=1", "b=2"])).toEqual({ a: "1", b: "2" });
  });

  it("returns empty object for empty array", () => {
    expect(parseVarArgs([])).toEqual({});
  });

  it("skips malformed args with no = sign", () => {
    // Warns but does not throw; malformed arg excluded from result
    const result = parseVarArgs(["noequals"]);
    expect(result).not.toHaveProperty("noequals");
  });
});

describe("loadPrompts / getPrompt (real prompts.yaml)", () => {
  it("loadPrompts returns an object with at least 10 prompts", () => {
    const prompts = loadPrompts();
    expect(Object.keys(prompts).length).toBeGreaterThanOrEqual(10);
  });

  it("each prompt has text, model, effort, phase", () => {
    const prompts = loadPrompts();
    for (const [name, prompt] of Object.entries(prompts)) {
      expect(typeof prompt.text, `${name}.text`).toBe("string");
      expect(prompt.text.length, `${name}.text is non-empty`).toBeGreaterThan(0);
      expect(["opus", "sonnet", "haiku", "any"], `${name}.model`).toContain(prompt.model);
      expect(["low", "high", "max"], `${name}.effort`).toContain(prompt.effort);
      expect(["plan", "beads", "swarm", "review"], `${name}.phase`).toContain(prompt.phase);
    }
  });

  it("getPrompt returns the correct prompt by name", () => {
    const prompt = getPrompt("commit-work");
    expect(prompt).toBeDefined();
    expect(prompt?.phase).toBe("swarm");
    expect(prompt?.text).toMatch(/commit/i);
  });

  it("getPrompt returns undefined for a nonexistent name", () => {
    expect(getPrompt("this-does-not-exist")).toBeUndefined();
  });

  it("loadPrompts is cached — same reference on second call", () => {
    const first = loadPrompts();
    const second = loadPrompts();
    expect(first).toBe(second); // same object reference
  });

  it("known prompts present: fresh-review, peer-review, commit-work, agent-unstuck", () => {
    const prompts = loadPrompts();
    for (const name of ["fresh-review", "peer-review", "commit-work", "agent-unstuck"]) {
      expect(prompts, `${name} should exist`).toHaveProperty(name);
    }
  });
});
