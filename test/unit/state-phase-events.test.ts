/**
 * test/unit/state-phase-events.test.ts
 * Covers: StateManager phase_events — logEvent, getEvents, renderNarrative
 * The append-only event log is the source of truth for debugging/replay.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { StateManager } from "../../cli/state.js";
import { tempDb } from "../helpers.js";

let sm: StateManager;
let runId: string;

beforeEach(() => {
  sm = tempDb().sm;
  runId = sm.createFlywheelRun("test-project", "plan");
});

describe("logEvent", () => {
  it("inserts a row retrievable by getEvents", () => {
    sm.logEvent(runId, "test_event");
    const events = sm.getEvents(runId);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("test_event");
  });

  it("stores payload_json as JSON string", () => {
    sm.logEvent(runId, "with_payload", { key: "value", count: 42 });
    const event = sm.getEvents(runId)[0];
    expect(JSON.parse(event.payload_json!)).toEqual({ key: "value", count: 42 });
  });

  it("stores null payload_json when payload is undefined", () => {
    sm.logEvent(runId, "no_payload");
    expect(sm.getEvents(runId)[0].payload_json).toBeNull();
  });

  it("stores empty-object payload as '{}'", () => {
    sm.logEvent(runId, "empty_payload", {});
    expect(sm.getEvents(runId)[0].payload_json).toBe("{}");
  });

  it("stores phaseFrom, phaseTo, actor from opts", () => {
    sm.logEvent(runId, "transition", {}, { phaseFrom: "plan", phaseTo: "beads", actor: "flywheel" });
    const event = sm.getEvents(runId)[0];
    expect(event.phase_from).toBe("plan");
    expect(event.phase_to).toBe("beads");
    expect(event.actor).toBe("flywheel");
  });

  it("all opts fields are null when opts not provided", () => {
    sm.logEvent(runId, "bare_event");
    const event = sm.getEvents(runId)[0];
    expect(event.phase_from).toBeNull();
    expect(event.phase_to).toBeNull();
    expect(event.actor).toBeNull();
  });

  it("timestamp is set automatically by SQLite", () => {
    sm.logEvent(runId, "timed");
    const event = sm.getEvents(runId)[0];
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("getEvents", () => {
  it("returns events in ASC timestamp order", () => {
    sm.logEvent(runId, "first");
    sm.logEvent(runId, "second");
    sm.logEvent(runId, "third");
    const events = sm.getEvents(runId);
    expect(events[0].event_type).toBe("first");
    expect(events[2].event_type).toBe("third");
  });

  it("excludes events from other run IDs", () => {
    const otherId = sm.createFlywheelRun("other", "plan");
    sm.logEvent(runId, "mine");
    sm.logEvent(otherId, "theirs");
    const myEvents = sm.getEvents(runId);
    expect(myEvents).toHaveLength(1);
    expect(myEvents[0].event_type).toBe("mine");
  });

  it("returns empty array for a run with no events", () => {
    const freshId = sm.createFlywheelRun("fresh", "plan");
    expect(sm.getEvents(freshId)).toEqual([]);
  });

  it("filters events with since= using strict > comparison", () => {
    sm.logEvent(runId, "old");
    // Small sleep to ensure a different timestamp
    const events1 = sm.getEvents(runId);
    const cutoff = events1[0].timestamp;
    sm.logEvent(runId, "new");
    const filtered = sm.getEvents(runId, cutoff);
    // The 'old' event is AT the cutoff timestamp — strict > excludes it
    expect(filtered.every((e) => e.event_type === "new")).toBe(true);
  });

  it("returns empty array when since is in the far future", () => {
    sm.logEvent(runId, "past");
    const filtered = sm.getEvents(runId, "2099-01-01T00:00:00.000Z");
    expect(filtered).toEqual([]);
  });
});

describe("renderNarrative", () => {
  it("returns a no-events message for an empty run", () => {
    const freshId = sm.createFlywheelRun("fresh", "plan");
    const narrative = sm.renderNarrative(freshId);
    expect(narrative).toMatch(/No events found/);
    expect(narrative).toContain(freshId);
  });

  it("formats a normal event as [timestamp] event_type (actor)", () => {
    sm.logEvent(runId, "deploy_started", {}, { actor: "flywheel" });
    const narrative = sm.renderNarrative(runId);
    expect(narrative).toContain("deploy_started");
    expect(narrative).toContain("(flywheel)");
  });

  it("omits actor parens when actor is null", () => {
    sm.logEvent(runId, "no_actor");
    const narrative = sm.renderNarrative(runId);
    expect(narrative).toContain("no_actor");
    expect(narrative).not.toContain("(null)");
  });

  it("includes payload JSON when present", () => {
    sm.logEvent(runId, "payload_event", { key: "val" });
    const narrative = sm.renderNarrative(runId);
    expect(narrative).toContain("key");
    expect(narrative).toContain("val");
  });

  it("does not crash on malformed payload_json in the DB", () => {
    // Insert a row with invalid JSON directly via raw SQL
    const { db } = tempDb();
    const sm2 = new StateManager(db);
    const rid = sm2.createFlywheelRun("p", "plan");
    db.prepare(
      "INSERT INTO phase_events (run_id, event_type, payload_json, timestamp) VALUES (?, ?, ?, ?)"
    ).run(rid, "corrupt", "NOT_JSON_AT_ALL", new Date().toISOString());
    // renderNarrative must not throw
    expect(() => sm2.renderNarrative(rid)).not.toThrow();
    const narrative = sm2.renderNarrative(rid);
    expect(narrative).toContain("corrupt");
  });
});
