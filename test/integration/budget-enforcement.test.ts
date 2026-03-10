/**
 * test/integration/budget-enforcement.test.ts
 * Covers: SwarmCoordinator.start() budget preflight + CLI --budget parsing.
 * Uses a real StateManager with fake transport boundaries so budget failures
 * can be tested without a VPS.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, resolve } from "node:path";

import { SwarmCoordinator } from "../../cli/swarm.js";
import { tempDb, tempDir, stripAnsi } from "../helpers.js";
import { runProcess } from "../helpers/process.js";
import type { StateManager } from "../../cli/state.js";
import type { SSHManager } from "../../cli/ssh.js";
import type { RemoteCommandRunner, RemoteCommandResult } from "../../cli/remote.js";
import type { NtmBridge, NtmSpawnResult } from "../../cli/ntm-bridge.js";

const CLI = resolve("dist/cli.js");

interface TransportCalls {
  connect: number;
  disconnect: number;
  remote: Array<{ command: string; cwd?: string }>;
  spawn: Array<{ session: string; count: number }>;
}

function createCoordinatorHarness(state: StateManager): {
  calls: TransportCalls;
  coordinator: SwarmCoordinator;
} {
  const calls: TransportCalls = {
    connect: 0,
    disconnect: 0,
    remote: [],
    spawn: [],
  };

  const ssh = {
    connect: async () => {
      calls.connect += 1;
      return {
        host: "127.0.0.1",
        user: "ubuntu",
        port: 22,
        keyPath: "/tmp/flywheel-test-key",
        remoteRepoRoot: "/srv/flywheel-projects",
      };
    },
    disconnect: () => {
      calls.disconnect += 1;
    },
  } as unknown as SSHManager;

  const remote = {
    runRemote: async (command: string, options?: { cwd?: string }): Promise<RemoteCommandResult> => {
      calls.remote.push({ command, cwd: options?.cwd });
      return {
        stdout: "deadbeefcafebabe\n",
        stderr: "",
        exitCode: 0,
        duration: 1,
      };
    },
  } as unknown as RemoteCommandRunner;

  const ntm = {
    spawn: async (session: string, count: number): Promise<NtmSpawnResult> => {
      calls.spawn.push({ session, count });
      return {
        session,
        paneCount: count,
        raw: { ok: true },
      };
    },
  } as unknown as NtmBridge;

  return {
    calls,
    coordinator: new SwarmCoordinator({ ssh, remote, ntm, state }),
  };
}

describe("SwarmCoordinator.start() --budget preflight", () => {
  it("blocks an over-budget existing run before SSH or NTM spawn", async () => {
    const { sm } = tempDb();
    const runId = sm.createFlywheelRun("budget-project", "swarm");
    sm.logApiCall(runId, "plan", "claude-opus-4-6", { input: 100_000, output: 50_000 }, 5.0);

    const { coordinator, calls } = createCoordinatorHarness(sm);

    await expect(
      coordinator.start("budget-project", 3, {
        runId,
        budgetUsd: 4.0,
      })
    ).rejects.toThrow(/budget cap exceeded/i);

    expect(calls.connect).toBe(0);
    expect(calls.disconnect).toBe(0);
    expect(calls.remote).toHaveLength(0);
    expect(calls.spawn).toHaveLength(0);
    expect(sm.getEvents(runId).some((event) => event.event_type === "swarm_spawned")).toBe(false);
  });

  it("allows a fresh run to proceed when the budget is positive", async () => {
    const { sm } = tempDb();
    const { coordinator, calls } = createCoordinatorHarness(sm);

    const result = await coordinator.start("budget-project", 3, {
      budgetUsd: 100.0,
    });

    expect(result.budgetUsd).toBe(100.0);
    expect(calls.connect).toBe(1);
    expect(calls.disconnect).toBe(1);
    expect(calls.remote).toEqual([
      {
        command: "git rev-parse HEAD",
        cwd: "/srv/flywheel-projects/budget-project",
      },
    ]);
    expect(calls.spawn).toEqual([{ session: "budget-project", count: 3 }]);
    expect(sm.getEvents(result.runId).some((event) => event.event_type === "swarm_spawned")).toBe(true);
  });

  it("treats an omitted budget as no cap", async () => {
    const { sm } = tempDb();
    const { coordinator, calls } = createCoordinatorHarness(sm);

    const result = await coordinator.start("budget-project", 3);

    expect(result.budgetUsd).toBeUndefined();
    expect(calls.connect).toBe(1);
    expect(calls.disconnect).toBe(1);
    expect(calls.spawn).toEqual([{ session: "budget-project", count: 3 }]);
  });
});

describe("flywheel swarm --budget CLI parsing", () => {
  let dir: ReturnType<typeof tempDir>;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    dir.cleanup();
  });

  function env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      NO_COLOR: "1",
      FLYWHEEL_HOME: dir.path,
      FLYWHEEL_STATE_DB: join(dir.path, "state.db"),
    };
  }

  it("rejects a non-numeric budget", async () => {
    const result = await runProcess("node", [CLI, "swarm", "3", "--budget", "foo"], {
      cwd: resolve("."),
      env: env(),
    });

    const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
    expect(result.code).toBe(1);
    expect(output).toMatch(/--budget must be a positive number/i);
  });

  it("rejects a negative budget", async () => {
    const result = await runProcess("node", [CLI, "swarm", "3", "--budget", "-1"], {
      cwd: resolve("."),
      env: env(),
    });

    const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
    expect(result.code).toBe(1);
    expect(output).toMatch(/--budget must be a positive number/i);
  });
});
