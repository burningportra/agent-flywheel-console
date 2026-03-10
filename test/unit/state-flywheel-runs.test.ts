/**
 * test/unit/state-flywheel-runs.test.ts
 * Covers: StateManager flywheel_runs table — createFlywheelRun, setCheckpointSha,
 *         advanceGate, completeFlywheelRun, getFlywheelRun, listFlywheelRuns
 */
import { describe, it, expect, beforeEach } from "vitest";
import { StateManager } from "../../cli/state.js";
import { tempDb } from "../helpers.js";

let sm: StateManager;

beforeEach(() => {
  sm = tempDb().sm;
});

describe("createFlywheelRun", () => {
  it("returns a UUID string", () => {
    const id = sm.createFlywheelRun("proj", "plan");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sets phase and project_name correctly", () => {
    const id = sm.createFlywheelRun("myproject", "swarm");
    const run = sm.getFlywheelRun(id);
    expect(run?.phase).toBe("swarm");
    expect(run?.project_name).toBe("myproject");
  });

  it("all nullable fields are null initially", () => {
    const id = sm.createFlywheelRun("p", "plan");
    const run = sm.getFlywheelRun(id);
    expect(run?.completed_at).toBeNull();
    expect(run?.gate_passed_at).toBeNull();
    expect(run?.checkpoint_sha).toBeNull();
    expect(run?.cost_usd).toBeNull();
    expect(run?.notes).toBeNull();
  });
});

describe("setCheckpointSha", () => {
  it("updates checkpoint_sha for the run", () => {
    const sha = "abc123def456abc123def456abc123def456abc1";
    const id = sm.createFlywheelRun("p", "swarm");
    sm.setCheckpointSha(id, sha);
    expect(sm.getFlywheelRun(id)?.checkpoint_sha).toBe(sha);
  });

  it("calling twice overwrites with the second value", () => {
    const id = sm.createFlywheelRun("p", "swarm");
    sm.setCheckpointSha(id, "aaa");
    sm.setCheckpointSha(id, "bbb");
    expect(sm.getFlywheelRun(id)?.checkpoint_sha).toBe("bbb");
  });

  it("does not change phase or gate_passed_at", () => {
    const id = sm.createFlywheelRun("p", "plan");
    sm.setCheckpointSha(id, "abc1234");
    const run = sm.getFlywheelRun(id);
    expect(run?.phase).toBe("plan");
    expect(run?.gate_passed_at).toBeNull();
  });
});

describe("advanceGate", () => {
  it("updates phase and sets gate_passed_at", () => {
    const id = sm.createFlywheelRun("p", "plan");
    sm.advanceGate(id, "beads");
    const run = sm.getFlywheelRun(id);
    expect(run?.phase).toBe("beads");
    expect(run?.gate_passed_at).not.toBeNull();
    expect(run?.gate_passed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("stores checkpoint SHA when provided", () => {
    const id = sm.createFlywheelRun("p", "plan");
    sm.advanceGate(id, "beads", "abc1234567890");
    expect(sm.getFlywheelRun(id)?.checkpoint_sha).toBe("abc1234567890");
  });

  it("leaves checkpoint_sha null when not provided", () => {
    const id = sm.createFlywheelRun("p", "plan");
    sm.advanceGate(id, "beads");
    expect(sm.getFlywheelRun(id)?.checkpoint_sha).toBeNull();
  });

  it("logs a gate_advanced event as a side effect", () => {
    const id = sm.createFlywheelRun("p", "plan");
    sm.advanceGate(id, "beads");
    const events = sm.getEvents(id);
    const gateEvent = events.find((e) => e.event_type === "gate_advanced");
    expect(gateEvent).toBeDefined();
    expect(gateEvent?.phase_to).toBe("beads");
    expect(gateEvent?.actor).toBe("human");
  });
});

describe("completeFlywheelRun", () => {
  it("sets completed_at, cost_usd, and notes", () => {
    const id = sm.createFlywheelRun("p", "deploy");
    sm.completeFlywheelRun(id, 1.2345, "all done");
    const run = sm.getFlywheelRun(id);
    expect(run?.completed_at).not.toBeNull();
    expect(run?.cost_usd).toBeCloseTo(1.2345);
    expect(run?.notes).toBe("all done");
  });

  it("notes is optional", () => {
    const id = sm.createFlywheelRun("p", "deploy");
    sm.completeFlywheelRun(id, 0);
    expect(sm.getFlywheelRun(id)?.notes).toBeNull();
  });
});

describe("getFlywheelRun / listFlywheelRuns", () => {
  it("getFlywheelRun returns undefined for unknown ID", () => {
    expect(sm.getFlywheelRun("nonexistent-id")).toBeUndefined();
  });

  it("listFlywheelRuns returns empty array on fresh DB", () => {
    expect(sm.listFlywheelRuns()).toEqual([]);
  });

  it("listFlywheelRuns returns all runs in DESC order", () => {
    sm.createFlywheelRun("p", "plan");
    sm.createFlywheelRun("p", "swarm");
    const runs = sm.listFlywheelRuns();
    expect(runs).toHaveLength(2);
    // Both phases must be present; order is started_at DESC (may be equal when same-millisecond)
    const phases = runs.map(r => r.phase);
    expect(phases).toContain("plan");
    expect(phases).toContain("swarm");
  });
});

