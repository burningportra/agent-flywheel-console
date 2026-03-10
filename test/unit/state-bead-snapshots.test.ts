/**
 * test/unit/state-bead-snapshots.test.ts
 * Covers: captureBeadSnapshot, getBeadSnapshots, beadVelocity
 */
import { describe, it, expect, beforeEach } from "vitest";
import { StateManager } from "../../cli/state.js";
import { tempDb, sleep } from "../helpers.js";

let sm: StateManager;
let runId: string;

beforeEach(() => {
  sm = tempDb().sm;
  runId = sm.createFlywheelRun("project", "swarm");
});

describe("captureBeadSnapshot", () => {
  it("inserts a snapshot row", () => {
    sm.captureBeadSnapshot(runId, { bead_count: 10, closed_count: 3, blocked_count: 1 });
    expect(sm.getBeadSnapshots(runId)).toHaveLength(1);
  });

  it("stores all fields correctly", () => {
    sm.captureBeadSnapshot(runId, {
      bead_count: 20,
      closed_count: 5,
      blocked_count: 2,
      bead_graph_json: '{"nodes":[]}',
    });
    const snap = sm.getBeadSnapshots(runId)[0];
    expect(snap.bead_count).toBe(20);
    expect(snap.closed_count).toBe(5);
    expect(snap.blocked_count).toBe(2);
    expect(snap.bead_graph_json).toBe('{"nodes":[]}');
  });

  it("bead_graph_json is null when not provided", () => {
    sm.captureBeadSnapshot(runId, { bead_count: 5, closed_count: 1, blocked_count: 0 });
    expect(sm.getBeadSnapshots(runId)[0].bead_graph_json).toBeNull();
  });
});

describe("getBeadSnapshots", () => {
  it("returns empty array for a run with no snapshots", () => {
    expect(sm.getBeadSnapshots(runId)).toEqual([]);
  });

  it("returns snapshots in ASC captured_at order", async () => {
    sm.captureBeadSnapshot(runId, { bead_count: 10, closed_count: 2, blocked_count: 0 });
    await sleep(10); // ensure different timestamps
    sm.captureBeadSnapshot(runId, { bead_count: 10, closed_count: 5, blocked_count: 0 });
    const snaps = sm.getBeadSnapshots(runId);
    expect(snaps[0].closed_count).toBe(2);
    expect(snaps[1].closed_count).toBe(5);
  });

  it("excludes snapshots from other runs", () => {
    const otherId = sm.createFlywheelRun("other", "swarm");
    sm.captureBeadSnapshot(runId, { bead_count: 10, closed_count: 1, blocked_count: 0 });
    sm.captureBeadSnapshot(otherId, { bead_count: 5, closed_count: 2, blocked_count: 0 });
    expect(sm.getBeadSnapshots(runId)).toHaveLength(1);
    expect(sm.getBeadSnapshots(otherId)).toHaveLength(1);
  });
});

describe("beadVelocity", () => {
  it("returns 0 with zero snapshots", () => {
    expect(sm.beadVelocity(runId)).toBe(0);
  });

  it("returns 0 with only one snapshot", () => {
    sm.captureBeadSnapshot(runId, { bead_count: 10, closed_count: 3, blocked_count: 0 });
    expect(sm.beadVelocity(runId)).toBe(0);
  });

  it("returns 0 when both snapshots have the same timestamp", () => {
    // Insert two snapshots with the same captured_at via raw SQL
    const { db } = tempDb();
    const sm2 = new StateManager(db);
    const rid = sm2.createFlywheelRun("p", "swarm");
    const ts = new Date().toISOString();
    db.prepare(
      "INSERT INTO bead_snapshots (run_id, bead_count, closed_count, blocked_count, captured_at) VALUES (?, ?, ?, ?, ?)"
    ).run(rid, 10, 2, 0, ts);
    db.prepare(
      "INSERT INTO bead_snapshots (run_id, bead_count, closed_count, blocked_count, captured_at) VALUES (?, ?, ?, ?, ?)"
    ).run(rid, 10, 5, 0, ts);
    expect(sm2.beadVelocity(rid)).toBe(0); // division by zero guard
  });

  it("computes velocity correctly with 2 snapshots 1 hour apart", () => {
    const { db } = tempDb();
    const sm2 = new StateManager(db);
    const rid = sm2.createFlywheelRun("p", "swarm");
    const t0 = new Date("2026-01-01T10:00:00Z").toISOString();
    const t1 = new Date("2026-01-01T11:00:00Z").toISOString(); // 1 hour later
    db.prepare(
      "INSERT INTO bead_snapshots (run_id, bead_count, closed_count, blocked_count, captured_at) VALUES (?, ?, ?, ?, ?)"
    ).run(rid, 20, 5, 0, t0);
    db.prepare(
      "INSERT INTO bead_snapshots (run_id, bead_count, closed_count, blocked_count, captured_at) VALUES (?, ?, ?, ?, ?)"
    ).run(rid, 20, 10, 0, t1); // 5 more closed
    expect(sm2.beadVelocity(rid)).toBeCloseTo(5.0, 1); // 5 beads/hour
  });

  it("uses only the last windowSize snapshots", () => {
    const { db } = tempDb();
    const sm2 = new StateManager(db);
    const rid = sm2.createFlywheelRun("p", "swarm");
    // Create 7 snapshots — velocity should use last 5
    for (let i = 0; i < 7; i++) {
      const ts = new Date(2026, 0, 1, i).toISOString();
      db.prepare(
        "INSERT INTO bead_snapshots (run_id, bead_count, closed_count, blocked_count, captured_at) VALUES (?, ?, ?, ?, ?)"
      ).run(rid, 20, i * 2, 0, ts);
    }
    const v = sm2.beadVelocity(rid, 5);
    // Should be positive and based on last 5 snapshots, not all 7
    expect(v).toBeGreaterThan(0);
  });
});
