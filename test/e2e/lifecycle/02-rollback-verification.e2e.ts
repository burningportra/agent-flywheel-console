/**
 * test/e2e/lifecycle/02-rollback-verification.e2e.ts — bead: agent-9wjq.2
 *
 * Focused rollback lifecycle coverage:
 * - local safety checks that must fail before any SSH attempt
 * - destructive remote reset verification against a prepared VPS repo
 *
 * This spec complements the broader remote rollback/deploy suite by going
 * deeper on rollback-specific guarantees: confirmation safety, event logging,
 * checkpoint restoration, and removal of commits made after the checkpoint.
 */

import { describe, expect, it, afterAll } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { initDb, StateManager, type PhaseEvent } from "../../../cli/state.js";
import { hasSshConfig, runFlywheel, assertFailure, assertSuccess, cleanupTestProject, getTestProject } from "../setup.js";
import { loadSSHConfig, SSHManager } from "../../../cli/ssh.js";
import { shellQuote } from "../../../cli/utils.js";
import { tempDir, type TempDir } from "../../helpers.js";

const runVpsE2e = process.env.FLYWHEEL_TEST_E2E === "1" && hasSshConfig();
const runDestructive = runVpsE2e && process.env.FLYWHEEL_TEST_DESTRUCTIVE === "1";
const describeDestructive = runDestructive ? describe : describe.skip;

const testProject = getTestProject();

interface TestWorkspace {
  temp: TempDir;
  cwd: string;
  env: Record<string, string>;
  stateDbPath: string;
}

interface RemoteRollbackFixture {
  projectPath: string;
  checkpointSha: string;
}

afterAll(async () => {
  await cleanupTestProject(testProject);
});

function createWorkspace(projectName: string, copySshConfig = false): TestWorkspace {
  const temp = tempDir();
  const flywheelHome = join(temp.path, ".flywheel");
  const cwd = join(temp.path, projectName);
  const stateDbPath = join(flywheelHome, "state.db");

  mkdirSync(flywheelHome, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  if (copySshConfig && hasSshConfig()) {
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

function seedRollbackRun(
  stateDbPath: string,
  projectName: string,
  checkpointSha: string
): string {
  const db = initDb(stateDbPath);
  const state = new StateManager(db);
  const runId = state.createFlywheelRun(projectName, "swarm");
  state.setCheckpointSha(runId, checkpointSha);
  db.close();
  return runId;
}

function getRollbackEvents(stateDbPath: string, runId: string): PhaseEvent[] {
  const db = initDb(stateDbPath);
  const state = new StateManager(db);
  const events = state.getEvents(runId).filter((event) => event.event_type === "rollback");
  db.close();
  return events;
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

async function prepareRemoteRepo(projectName: string): Promise<RemoteRollbackFixture> {
  const config = loadSSHConfig();
  const projectPath = `${config.remoteRepoRoot}/${projectName}`;

  const result = await sshExec(
    [
      `rm -rf ${shellQuote(projectPath)}`,
      `mkdir -p ${shellQuote(projectPath)}`,
      `cd ${shellQuote(projectPath)}`,
      "git init",
      `git config user.email ${shellQuote("flywheel-e2e@example.invalid")}`,
      `git config user.name ${shellQuote("Flywheel E2E")}`,
      `printf 'seed\\n' > README.md`,
      "git add README.md",
      `git commit -m ${shellQuote("seed rollback repo")}`,
      "git rev-parse HEAD",
    ].join(" && "),
    { timeoutMs: 60_000 }
  );

  if (result.code !== 0) {
    throw new Error(`Remote rollback fixture setup failed:\n${result.stderr || result.stdout}`);
  }

  return {
    projectPath,
    checkpointSha: result.stdout.trim().split(/\s+/).pop() ?? "",
  };
}

async function commitMarkerFile(projectPath: string): Promise<{
  markerFile: string;
  headSha: string;
}> {
  const markerFile = `rollback-marker-${Date.now()}.txt`;

  const result = await sshExec(
    [
      `cd ${shellQuote(projectPath)}`,
      `printf 'rollback-marker\\n' > ${shellQuote(markerFile)}`,
      `git add ${shellQuote(markerFile)}`,
      `git commit -m ${shellQuote(`add ${markerFile}`)}`,
      "git rev-parse HEAD",
    ].join(" && "),
    { timeoutMs: 30_000 }
  );

  if (result.code !== 0) {
    throw new Error(`Failed to create rollback marker commit:\n${result.stderr || result.stdout}`);
  }

  return {
    markerFile,
    headSha: result.stdout.trim().split(/\s+/).pop() ?? "",
  };
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

async function countCommitsAhead(projectPath: string, baseSha: string): Promise<number> {
  const result = await sshExec(
    `cd ${shellQuote(projectPath)} && git rev-list --count ${shellQuote(`${baseSha}..HEAD`)}`,
    { timeoutMs: 15_000 }
  );

  if (result.code !== 0) {
    throw new Error(`Failed to count commits ahead of checkpoint:\n${result.stderr || result.stdout}`);
  }

  return Number.parseInt(result.stdout.trim(), 10);
}

async function remoteFileExists(projectPath: string, relativePath: string): Promise<boolean> {
  const result = await sshExec(
    `cd ${shellQuote(projectPath)} && if test -e ${shellQuote(relativePath)}; then echo yes; else echo no; fi`,
    { timeoutMs: 15_000 }
  );

  if (result.code !== 0) {
    throw new Error(`Failed to test remote file existence:\n${result.stderr || result.stdout}`);
  }

  return result.stdout.trim() === "yes";
}

describe("flywheel rollback — local safety contracts", () => {
  it("cancels on the wrong confirmation string before any SSH config is required", () => {
    const workspace = createWorkspace(testProject);

    try {
      const runId = seedRollbackRun(workspace.stateDbPath, testProject, "deadbeef");

      const result = runFlywheel(["rollback", runId.slice(0, 8)], {
        cwd: workspace.cwd,
        env: workspace.env,
        stdin: "rollback\n",
        timeout: 15_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toMatch(/Rollback cancelled/i);
      expect(result.stdout + result.stderr).not.toMatch(/SSH config not found|Failed to connect/i);
      expect(getRollbackEvents(workspace.stateDbPath, runId)).toHaveLength(0);
    } finally {
      workspace.temp.cleanup();
    }
  });

  it("rejects an invalid checkpoint SHA before any SSH attempt", () => {
    const workspace = createWorkspace(testProject);

    try {
      const runId = seedRollbackRun(
        workspace.stateDbPath,
        testProject,
        "definitely-not-a-sha!"
      );

      const result = runFlywheel(["rollback", runId.slice(0, 8)], {
        cwd: workspace.cwd,
        env: workspace.env,
        stdin: "ROLLBACK\n",
        timeout: 15_000,
      });

      assertFailure(result, "rollback should reject an invalid checkpoint SHA");
      expect(result.stdout + result.stderr).toMatch(/Invalid checkpoint SHA/i);
      expect(result.stdout + result.stderr).not.toContain("Node.js v");
      expect(result.stdout + result.stderr).not.toMatch(/SSH config not found|Failed to connect/i);
      expect(getRollbackEvents(workspace.stateDbPath, runId)).toHaveLength(0);
    } finally {
      workspace.temp.cleanup();
    }
  });
});

describeDestructive("flywheel rollback — destructive VPS verification", () => {
  it("does not mutate the remote repo or log an event when confirmation is wrong", async () => {
    const workspace = createWorkspace(testProject, true);

    try {
      const remote = await prepareRemoteRepo(testProject);
      const marker = await commitMarkerFile(remote.projectPath);
      const runId = seedRollbackRun(
        workspace.stateDbPath,
        testProject,
        remote.checkpointSha
      );

      expect(marker.headSha).not.toBe(remote.checkpointSha);
      expect(await countCommitsAhead(remote.projectPath, remote.checkpointSha)).toBe(1);

      const result = runFlywheel(["rollback", runId.slice(0, 8)], {
        cwd: workspace.cwd,
        env: workspace.env,
        stdin: "NOPE\n",
        timeout: 15_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toMatch(/Rollback cancelled/i);
      expect(await readRemoteHead(remote.projectPath)).toBe(marker.headSha);
      expect(await remoteFileExists(remote.projectPath, marker.markerFile)).toBe(true);
      expect(getRollbackEvents(workspace.stateDbPath, runId)).toHaveLength(0);
    } finally {
      workspace.temp.cleanup();
    }
  });

  it("resets the repo to the checkpoint SHA, removes the marker commit, and logs the rollback event", async () => {
    const workspace = createWorkspace(testProject, true);

    try {
      const remote = await prepareRemoteRepo(testProject);
      const marker = await commitMarkerFile(remote.projectPath);
      const runId = seedRollbackRun(
        workspace.stateDbPath,
        testProject,
        remote.checkpointSha
      );

      expect(marker.headSha).not.toBe(remote.checkpointSha);
      expect(await countCommitsAhead(remote.projectPath, remote.checkpointSha)).toBe(1);

      const result = runFlywheel(["rollback", runId.slice(0, 8)], {
        cwd: workspace.cwd,
        env: workspace.env,
        stdin: "ROLLBACK\n",
        timeout: 60_000,
      });

      assertSuccess(result, "rollback should succeed against the prepared remote repo");
      expect(result.stdout + result.stderr).toContain(remote.checkpointSha.slice(0, 12));
      expect(await readRemoteHead(remote.projectPath)).toBe(remote.checkpointSha);
      expect(await remoteFileExists(remote.projectPath, marker.markerFile)).toBe(false);

      const rollbackEvents = getRollbackEvents(workspace.stateDbPath, runId);
      expect(rollbackEvents.length).toBeGreaterThan(0);

      const payload = JSON.parse(rollbackEvents.at(-1)?.payload_json ?? "{}") as {
        checkpoint_sha?: string;
      };
      expect(payload.checkpoint_sha).toBe(remote.checkpointSha);
    } finally {
      workspace.temp.cleanup();
    }
  });
});
