/**
 * test/e2e/lifecycle/02-rollback-verification.e2e.ts — bead: agent-9wjq.2
 *
 * Focused rollback verification against a prepared VPS repo:
 *   - cancellation on wrong confirmation leaves HEAD unchanged
 *   - confirmed rollback restores the stored checkpoint SHA
 *   - tracked changes added after the checkpoint disappear
 *   - rollback event payload records the expected checkpoint SHA
 *
 * Requires FLYWHEEL_TEST_E2E=1 and ~/.flywheel/ssh.yaml.
 * The destructive reset test additionally requires FLYWHEEL_TEST_DESTRUCTIVE=1.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { initDb, StateManager } from "../../../cli/state.js";
import { loadSSHConfig, SSHManager } from "../../../cli/ssh.js";
import { shellQuote } from "../../../cli/utils.js";
import { tempDir, type TempDir } from "../../helpers.js";
import {
  assertFailure,
  assertSuccess,
  cleanupTestProject,
  getTestProject,
  hasSshConfig,
  runFlywheel,
  runFlywheelWithDiagnostics,
} from "../setup.js";

const runVpsE2e = process.env.FLYWHEEL_TEST_E2E === "1" && hasSshConfig();
const runDestructive = runVpsE2e && process.env.FLYWHEEL_TEST_DESTRUCTIVE === "1";
const describeVps = runVpsE2e ? describe : describe.skip;
const describeDestructive = runDestructive ? describe : describe.skip;

interface TestWorkspace {
  temp: TempDir;
  cwd: string;
  env: Record<string, string>;
  stateDbPath: string;
}

let workspace: TestWorkspace | null = null;
const testProject = `${getTestProject()}-rollback`;

beforeEach(() => {
  workspace = createWorkspace(testProject);
});

afterEach(() => {
  workspace?.temp.cleanup();
  workspace = null;
});

afterAll(async () => {
  await cleanupTestProject(testProject);
});

function currentWorkspace(): TestWorkspace {
  if (!workspace) {
    throw new Error("Test workspace was not initialized.");
  }
  return workspace;
}

function createWorkspace(projectName: string): TestWorkspace {
  const temp = tempDir();
  const flywheelHome = join(temp.path, ".flywheel");
  const cwd = join(temp.path, projectName);
  const stateDbPath = join(flywheelHome, "state.db");

  mkdirSync(flywheelHome, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  if (hasSshConfig()) {
    const sshYaml = join(homedir(), ".flywheel", "ssh.yaml");
    writeFileSync(join(flywheelHome, "ssh.yaml"), readFileSync(sshYaml, "utf8"), "utf8");
  }

  return {
    temp,
    cwd,
    stateDbPath,
    env: {
      FLYWHEEL_HOME: flywheelHome,
      FLYWHEEL_STATE_DB: stateDbPath,
    },
  };
}

function seedRollbackRun(projectName: string, checkpointSha: string): string {
  const db = initDb(currentWorkspace().stateDbPath);
  const state = new StateManager(db);
  const runId = state.createFlywheelRun(projectName, "swarm");
  state.setCheckpointSha(runId, checkpointSha);
  return runId;
}

function rollbackEventsFor(runId: string) {
  const db = initDb(currentWorkspace().stateDbPath);
  const state = new StateManager(db);
  return state.getEvents(runId).filter((event) => event.event_type === "rollback");
}

async function sshExec(
  command: string,
  options: { timeoutMs?: number } = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  const ssh = new SSHManager();
  await ssh.connect();
  try {
    return await ssh.exec(command, {
      timeoutMs: options.timeoutMs ?? 30_000,
      noTrim: true,
    });
  } finally {
    ssh.disconnect();
  }
}

async function prepareRemoteRepo(projectName: string): Promise<{
  projectPath: string;
  initialSha: string;
}> {
  const initResult = await runFlywheelWithDiagnostics(["init", projectName], {
    cwd: currentWorkspace().cwd,
    env: currentWorkspace().env,
    remoteDiagnostics: true,
    remoteProjectName: projectName,
    timeout: 60_000,
  });
  assertSuccess(initResult, "flywheel init for rollback verification E2E");

  const config = loadSSHConfig();
  const projectPath = `${config.remoteRepoRoot}/${projectName}`;

  const bootstrap = await sshExec(
    [
      `cd ${shellQuote(projectPath)}`,
      `git config user.email ${shellQuote("flywheel-e2e@example.invalid")}`,
      `git config user.name ${shellQuote("Flywheel E2E")}`,
      `if ! git rev-parse HEAD >/dev/null 2>&1; then printf 'seed\\n' > README.md && git add README.md && git commit -m ${shellQuote("seed remote repo")}; fi`,
      `git rev-parse HEAD`,
    ].join(" && "),
    { timeoutMs: 60_000 }
  );

  if (bootstrap.code !== 0) {
    throw new Error(`Remote repo bootstrap failed:\n${bootstrap.stderr || bootstrap.stdout}`);
  }

  return {
    projectPath,
    initialSha: bootstrap.stdout.trim().split(/\s+/).pop() ?? "",
  };
}

async function appendTrackedFile(projectPath: string, fileName: string, content: string): Promise<void> {
  const result = await sshExec(
    [
      `cd ${shellQuote(projectPath)}`,
      `printf ${shellQuote(content)} > ${shellQuote(fileName)}`,
      `git add ${shellQuote(fileName)}`,
      `git commit -m ${shellQuote(`add ${fileName}`)}`,
    ].join(" && "),
    { timeoutMs: 30_000 }
  );

  if (result.code !== 0) {
    throw new Error(`Failed to create tracked file commit:\n${result.stderr || result.stdout}`);
  }
}

async function readRemoteHead(projectPath: string): Promise<string> {
  const result = await sshExec(`cd ${shellQuote(projectPath)} && git rev-parse HEAD`, {
    timeoutMs: 15_000,
  });
  if (result.code !== 0) {
    throw new Error(`Failed to read remote HEAD:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function remotePathExists(projectPath: string, fileName: string): Promise<boolean> {
  const result = await sshExec(
    `cd ${shellQuote(projectPath)} && test -e ${shellQuote(fileName)} && echo yes || echo no`,
    { timeoutMs: 15_000 }
  );
  if (result.code !== 0) {
    throw new Error(`Failed to probe remote file existence:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim() === "yes";
}

describe("flywheel rollback local safety checks", () => {
  it("cancels on the wrong confirmation string before any SSH work", () => {
    const runId = seedRollbackRun(testProject, "deadbeef1234567890abcdef");

    const result = runFlywheel(["rollback", runId.slice(0, 8)], {
      cwd: currentWorkspace().cwd,
      env: currentWorkspace().env,
      stdin: "NOT IT\n",
      timeout: 15_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/cancelled/i);
    expect(rollbackEventsFor(runId)).toHaveLength(0);
  });

  it("rejects an invalid stored checkpoint SHA with a clean user-facing error", () => {
    const runId = seedRollbackRun(testProject, "definitely-not-a-sha!");

    const result = runFlywheel(["rollback", runId.slice(0, 8)], {
      cwd: currentWorkspace().cwd,
      env: currentWorkspace().env,
      stdin: "ROLLBACK\n",
      timeout: 15_000,
    });

    assertFailure(result, "rollback should reject an invalid checkpoint SHA");
    expect(result.stdout + result.stderr).toMatch(/Invalid checkpoint SHA/i);
    expect(result.stdout + result.stderr).not.toContain("DESTRUCTIVE OPERATION");
    expect(result.stdout + result.stderr).not.toContain('Type "ROLLBACK"');
    expect(result.stdout + result.stderr).not.toMatch(/SSH error/i);
    expect(result.stdout + result.stderr).not.toContain("Unexpected error");
    expect(result.stdout + result.stderr).not.toContain("at assertSafeSha");
    expect(result.stdout + result.stderr).not.toContain("Node.js v");
    expect(rollbackEventsFor(runId)).toHaveLength(0);
  });

  it("fails before prompting or connecting when the stored run has no project name", () => {
    const runId = seedRollbackRun("   ", "deadbeef1234567890abcdef");

    const result = runFlywheel(["rollback", runId.slice(0, 8)], {
      cwd: currentWorkspace().cwd,
      env: currentWorkspace().env,
      stdin: "ROLLBACK\n",
      timeout: 15_000,
    });

    assertFailure(result, "rollback should reject a run with no project name");
    expect(result.stdout + result.stderr).toMatch(/missing project_name/i);
    expect(result.stdout + result.stderr).not.toContain("DESTRUCTIVE OPERATION");
    expect(result.stdout + result.stderr).not.toContain('Type "ROLLBACK"');
    expect(result.stdout + result.stderr).not.toMatch(/SSH error/i);
    expect(result.stdout + result.stderr).not.toContain("Unexpected error");
    expect(rollbackEventsFor(runId)).toHaveLength(0);
  });
});

describeVps("flywheel rollback confirmation safety", () => {
  it("cancels on the wrong confirmation string and keeps the remote HEAD unchanged", async () => {
    const remote = await prepareRemoteRepo(testProject);
    const checkpointSha = remote.initialSha;
    const runId = seedRollbackRun(testProject, checkpointSha);

    await appendTrackedFile(
      remote.projectPath,
      "rollback-cancel-marker.txt",
      `cancel marker ${Date.now()}\n`
    );
    const headBeforeRollback = await readRemoteHead(remote.projectPath);

    const result = runFlywheel(["rollback", runId.slice(0, 8)], {
      cwd: currentWorkspace().cwd,
      env: currentWorkspace().env,
      stdin: "NOT IT\n",
      timeout: 20_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/cancelled/i);
    expect(await readRemoteHead(remote.projectPath)).toBe(headBeforeRollback);
    expect(rollbackEventsFor(runId)).toHaveLength(0);
  });
});

describeDestructive("flywheel rollback lifecycle verification", () => {
  it("resets the repo to the stored checkpoint, removes the tracked marker file, and logs the rollback SHA", async () => {
    const remote = await prepareRemoteRepo(testProject);
    const checkpointSha = remote.initialSha;
    const runId = seedRollbackRun(testProject, checkpointSha);
    const markerFile = "rollback-marker.txt";

    await appendTrackedFile(
      remote.projectPath,
      markerFile,
      `marker created after checkpoint ${Date.now()}\n`
    );

    const headBeforeRollback = await readRemoteHead(remote.projectPath);
    expect(headBeforeRollback).not.toBe(checkpointSha);
    expect(await remotePathExists(remote.projectPath, markerFile)).toBe(true);

    const result = await runFlywheelWithDiagnostics(["rollback", runId.slice(0, 8)], {
      cwd: currentWorkspace().cwd,
      env: currentWorkspace().env,
      stdin: "ROLLBACK\n",
      timeout: 60_000,
      remoteDiagnostics: true,
      remoteProjectName: testProject,
    });

    assertSuccess(result, "flywheel rollback lifecycle verification");
    expect(result.stdout + result.stderr).toContain(checkpointSha.slice(0, 12));
    expect(await readRemoteHead(remote.projectPath)).toBe(checkpointSha);
    expect(await remotePathExists(remote.projectPath, markerFile)).toBe(false);

    const db = initDb(currentWorkspace().stateDbPath);
    const state = new StateManager(db);
    const rollbackEvent = state
      .getEvents(runId)
      .filter((event) => event.event_type === "rollback")
      .at(-1);

    expect(rollbackEvent).toBeTruthy();
    expect(rollbackEvent?.actor).toBe("human");
    expect(rollbackEvent?.payload_json).toBeTruthy();

    const payload = JSON.parse(rollbackEvent?.payload_json ?? "{}") as { checkpoint_sha?: string };
    expect(payload.checkpoint_sha).toBe(checkpointSha);
  });
});
