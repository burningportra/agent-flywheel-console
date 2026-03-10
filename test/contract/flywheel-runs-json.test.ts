import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initDb, StateManager } from "../../cli/state.js";
import { tempDir, type TempDir } from "../helpers.js";

const CLI = resolve("dist/cli.js");

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

let dir: TempDir;

beforeEach(() => {
  dir = tempDir();
});

afterEach(() => {
  dir.cleanup();
});

function envForDir(): Record<string, string> {
  return {
    FLYWHEEL_HOME: dir.path,
    FLYWHEEL_STATE_DB: join(dir.path, "state.db"),
  };
}

function runReplay(args: string[]): CliResult {
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      ...envForDir(),
    },
    timeout: 15_000,
  });

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function seedRun(options?: {
  eventCount?: number;
  projectName?: string;
  phase?: Parameters<StateManager["createFlywheelRun"]>[1];
}): { state: StateManager; runId: string } {
  const db = initDb(join(dir.path, "state.db"));
  const state = new StateManager(db);
  const runId = state.createFlywheelRun(
    options?.projectName ?? "contract-project",
    options?.phase ?? "review"
  );

  state.setCheckpointSha(runId, "abc1234def5678abc1234def5678abc1234def56");
  state.completeFlywheelRun(runId, 12.3456, "contract-test");

  const eventCount = options?.eventCount ?? 3;
  for (let index = 0; index < eventCount; index += 1) {
    state.logEvent(
      runId,
      `event_${index}`,
      { index, nested: { ok: true } },
      {
        actor: index % 2 === 0 ? "flywheel" : "human",
        phaseFrom: index === 0 ? "plan" : "beads",
        phaseTo: index === eventCount - 1 ? "review" : "swarm",
      }
    );
  }

  return { state, runId };
}

function assertIsoString(value: unknown): void {
  expect(typeof value).toBe("string");
  expect(new Date(value as string).toISOString()).toBe(value);
}

describe("flywheel replay --format json contract", () => {
  it("emits the expected top-level run/events shape", () => {
    const { runId } = seedRun();

    const result = runReplay(["replay", runId.slice(0, 8), "--format", "json"]);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout) as {
      run: Record<string, unknown>;
      events: Array<Record<string, unknown>>;
    };

    expect(Object.keys(parsed).sort()).toEqual(["events", "run"]);
    expect(Array.isArray(parsed.events)).toBe(true);

    const run = parsed.run;
    expect(run.id).toBe(runId);
    expect(run.project_name).toBe("contract-project");
    expect(run.phase).toBe("review");
    assertIsoString(run.started_at);
    assertIsoString(run.completed_at);
    expect(typeof run.checkpoint_sha).toBe("string");
    expect(typeof run.cost_usd).toBe("number");
    expect(run.notes).toBe("contract-test");

    expect(parsed.events.length).toBe(3);
    for (const event of parsed.events) {
      expect(typeof event.id).toBe("number");
      expect(event.run_id).toBe(runId);
      expect(typeof event.event_type).toBe("string");
      expect(event.phase_from === null || typeof event.phase_from === "string").toBe(true);
      expect(event.phase_to === null || typeof event.phase_to === "string").toBe(true);
      expect(event.actor === null || typeof event.actor === "string").toBe(true);
      expect(event.payload_json === null || typeof event.payload_json === "string").toBe(true);
      assertIsoString(event.timestamp);

      if (typeof event.payload_json === "string") {
        expect(() => JSON.parse(event.payload_json)).not.toThrow();
      }
    }
  });

  it("returns an empty events array for a run with zero events", () => {
    const db = initDb(join(dir.path, "state.db"));
    const state = new StateManager(db);
    const runId = state.createFlywheelRun("empty-events-project", "plan");

    const result = runReplay(["replay", runId.slice(0, 8), "--format", "json"]);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout) as {
      run: { id: string };
      events: unknown[];
    };

    expect(parsed.run.id).toBe(runId);
    expect(parsed.events).toEqual([]);
  });

  it("emits 100+ events without truncation", () => {
    const { runId } = seedRun({ eventCount: 125, projectName: "many-events-project" });

    const result = runReplay(["replay", runId.slice(0, 8), "--format", "json"]);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout) as { events: Array<{ event_type: string }> };
    expect(parsed.events).toHaveLength(125);
    expect(parsed.events[0]?.event_type).toBe("event_0");
    expect(parsed.events[124]?.event_type).toBe("event_124");
  });

  it("keeps the run object present when --since filters out all events", () => {
    const { state, runId } = seedRun({ projectName: "old-events-project" });
    const db = initDb(join(dir.path, "state.db"));
    db.prepare(`UPDATE phase_events SET timestamp = ? WHERE run_id = ?`).run(
      "2000-01-01T00:00:00.000Z",
      runId
    );

    const result = runReplay([
      "replay",
      runId.slice(0, 8),
      "--format",
      "json",
      "--since",
      "1h",
    ]);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout) as {
      run: { id: string; project_name: string };
      events: unknown[];
    };

    expect(parsed.run.id).toBe(runId);
    expect(parsed.run.project_name).toBe("old-events-project");
    expect(parsed.events).toEqual([]);
    expect(state.getFlywheelRun(runId)?.id).toBe(runId);
  });

  it("exits 1 and reports an unknown run id on stderr", () => {
    const result = runReplay(["replay", "does-not-exist", "--format", "json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Run not found/i);
  });
});
