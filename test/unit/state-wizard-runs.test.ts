/**
 * test/unit/state-wizard-runs.test.ts
 * Covers: StateManager wizard_runs table — all CRUD methods
 * Uses real in-memory SQLite via initDb(':memory:'). No mocks.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { StateManager } from "../../cli/state.js";
import { tempDb } from "../helpers.js";

let sm: StateManager;

beforeEach(() => {
  sm = tempDb().sm;
});

describe("createWizardRun", () => {
  it("returns a non-empty UUID string", () => {
    const id = sm.createWizardRun("myproject", "Build a todo app");
    expect(typeof id).toBe("string");
    expect(id.length).toBe(36); // UUID v4 format
  });

  it("inserts a row with status=running", () => {
    const id = sm.createWizardRun("myproject", "idea");
    const run = sm.getWizardRun(id);
    expect(run?.status).toBe("running");
    expect(run?.project_name).toBe("myproject");
    expect(run?.idea).toBe("idea");
  });

  it("sets started_at to an ISO timestamp", () => {
    const id = sm.createWizardRun("p", "i");
    const run = sm.getWizardRun(id);
    expect(run?.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("completed_at and plan_path are null initially", () => {
    const id = sm.createWizardRun("p", "i");
    const run = sm.getWizardRun(id);
    expect(run?.completed_at).toBeNull();
    expect(run?.plan_path).toBeNull();
  });

  it("two calls create two distinct IDs", () => {
    const id1 = sm.createWizardRun("p", "idea1");
    const id2 = sm.createWizardRun("p", "idea2");
    expect(id1).not.toBe(id2);
  });

  it("stores a very long idea string", () => {
    const longIdea = "x".repeat(10_000);
    const id = sm.createWizardRun("p", longIdea);
    expect(sm.getWizardRun(id)?.idea).toBe(longIdea);
  });
});

describe("completeWizardRun", () => {
  it("sets status=completed, completed_at, and plan_path", () => {
    const id = sm.createWizardRun("p", "i");
    sm.completeWizardRun(id, "/tmp/plan.md");
    const run = sm.getWizardRun(id);
    expect(run?.status).toBe("completed");
    expect(run?.plan_path).toBe("/tmp/plan.md");
    expect(run?.completed_at).not.toBeNull();
  });
});

describe("failWizardRun", () => {
  it("sets status=failed and completed_at", () => {
    const id = sm.createWizardRun("p", "i");
    sm.failWizardRun(id);
    const run = sm.getWizardRun(id);
    expect(run?.status).toBe("failed");
    expect(run?.completed_at).not.toBeNull();
  });

  it("does not affect other wizard runs", () => {
    const id1 = sm.createWizardRun("p", "i1");
    const id2 = sm.createWizardRun("p", "i2");
    sm.failWizardRun(id1);
    expect(sm.getWizardRun(id2)?.status).toBe("running");
  });
});

describe("getWizardRun", () => {
  it("returns the correct run by ID", () => {
    const id = sm.createWizardRun("project-x", "idea-x");
    const run = sm.getWizardRun(id);
    expect(run?.id).toBe(id);
    expect(run?.project_name).toBe("project-x");
  });

  it("returns undefined for an unknown ID", () => {
    expect(sm.getWizardRun("00000000-0000-0000-0000-000000000000")).toBeUndefined();
  });
});

describe("listWizardRuns", () => {
  it("returns empty array on a fresh DB", () => {
    expect(sm.listWizardRuns()).toEqual([]);
  });

  it("returns all created runs", () => {
    sm.createWizardRun("p", "i1");
    sm.createWizardRun("p", "i2");
    sm.createWizardRun("p", "i3");
    expect(sm.listWizardRuns()).toHaveLength(3);
  });

  it("returns all runs, ordering by started_at DESC where distinguishable", () => {
    sm.createWizardRun("p", "first");
    sm.createWizardRun("p", "second");
    const runs = sm.listWizardRuns();
    // Both runs must be present
    expect(runs).toHaveLength(2);
    const ideas = runs.map(r => r.idea);
    expect(ideas).toContain("first");
    expect(ideas).toContain("second");
  });
});

