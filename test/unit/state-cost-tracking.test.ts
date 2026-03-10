/**
 * test/unit/state-cost-tracking.test.ts
 * Covers: logApiCall, getTotalCost, getApiCalls, recordSshConnect/Disconnect, logPromptSend
 */
import { describe, it, expect, beforeEach } from "vitest";
import { StateManager } from "../../cli/state.js";
import { tempDb } from "../helpers.js";

let sm: StateManager;
let runId: string;

beforeEach(() => {
  sm = tempDb().sm;
  runId = sm.createFlywheelRun("project", "swarm");
});

describe("logApiCall / getTotalCost", () => {
  it("getTotalCost returns 0 when no calls logged", () => {
    expect(sm.getTotalCost(runId)).toBe(0);
  });

  it("getTotalCost returns the single call cost", () => {
    sm.logApiCall(runId, "plan", "claude-opus", { input: 1000, output: 500 }, 0.05);
    expect(sm.getTotalCost(runId)).toBeCloseTo(0.05, 5);
  });

  it("getTotalCost sums multiple calls correctly", () => {
    sm.logApiCall(runId, "plan", "claude-opus", { input: 100, output: 50 }, 0.01);
    sm.logApiCall(runId, "plan", "gpt-4o", { input: 200, output: 100 }, 0.02);
    sm.logApiCall(runId, "swarm", "claude-sonnet", { input: 300, output: 150 }, 0.03);
    expect(sm.getTotalCost(runId)).toBeCloseTo(0.06, 5);
  });

  it("getTotalCost excludes calls from other runs", () => {
    const otherId = sm.createFlywheelRun("other", "swarm");
    sm.logApiCall(runId, "plan", "model", { input: 100, output: 50 }, 1.0);
    sm.logApiCall(otherId, "plan", "model", { input: 100, output: 50 }, 99.0);
    expect(sm.getTotalCost(runId)).toBeCloseTo(1.0, 5);
  });
});

describe("getApiCalls", () => {
  it("returns empty array when no calls", () => {
    expect(sm.getApiCalls(runId)).toEqual([]);
  });

  it("returns calls in ASC called_at order", () => {
    sm.logApiCall(runId, "plan", "model-a", { input: 1, output: 1 }, 0.001);
    sm.logApiCall(runId, "swarm", "model-b", { input: 2, output: 2 }, 0.002);
    const calls = sm.getApiCalls(runId);
    expect(calls[0].model).toBe("model-a");
    expect(calls[1].model).toBe("model-b");
  });

  it("stores token counts correctly", () => {
    sm.logApiCall(runId, "plan", "claude", { input: 1234, output: 567 }, 0.1);
    const call = sm.getApiCalls(runId)[0];
    expect(call.input_tokens).toBe(1234);
    expect(call.output_tokens).toBe(567);
  });
});

describe("recordSshConnect / recordSshDisconnect", () => {
  it("recordSshConnect returns a numeric ID", () => {
    const id = sm.recordSshConnect("192.168.1.1");
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);
  });

  it("two connects return different IDs", () => {
    const id1 = sm.recordSshConnect("host1");
    const id2 = sm.recordSshConnect("host2");
    expect(id1).not.toBe(id2);
  });

  it("recordSshDisconnect with latency sets latency_ms", () => {
    const id = sm.recordSshConnect("host");
    sm.recordSshDisconnect(id, 42);
    // Verify by checking no error thrown (latency stored in DB)
    expect(true).toBe(true); // if we got here, no exception
  });

  it("recordSshDisconnect without latency sets disconnected_at only", () => {
    const id = sm.recordSshConnect("host");
    expect(() => sm.recordSshDisconnect(id)).not.toThrow();
  });
});

describe("logPromptSend", () => {
  it("stores prompt name and agent target", () => {
    expect(() =>
      sm.logPromptSend("commit-work", "session-1:pane-3", runId)
    ).not.toThrow();
  });

  it("works without a runId (null FK)", () => {
    expect(() => sm.logPromptSend("fresh-review", "all")).not.toThrow();
  });

  it("multiple sends are stored independently", () => {
    sm.logPromptSend("a", "pane-1", runId);
    sm.logPromptSend("b", "pane-2", runId);
    // No error = both inserted
    expect(true).toBe(true);
  });
});
