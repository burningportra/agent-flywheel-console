/**
 * test/e2e/remote/03-rollback-deploy.e2e.ts — bead: 3qw.5.4
 *
 * Remote E2E coverage for rollback safety and deploy confirmation/push flows.
 *
 * Commands such as `flywheel deploy` infer the project name from cwd. These
 * specs therefore run the real CLI from a temp directory whose basename
 * matches the remote project under test, while still executing the built CLI
 * binary from the source checkout.
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
const describeDestructive = runDestructive ? describe : describe.skip;

interface TestWorkspace {
  temp: TempDir;
  cwd: string;
  env: Record<string, string>;
  stateDbPath: string;
}

let workspace: TestWorkspace | null = null;
const testProject = getTestProject();

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
  originPath: string;
  initialSha: string;
}> {
  const initResult = await runFlywheelWithDiagnostics(["init", projectName], {
    cwd: currentWorkspace().cwd,
    env: currentWorkspace().env,
    remoteDiagnostics: true,
    remoteProjectName: projectName,
    timeout: 60_000,
  });
  assertSuccess(initResult, "flywheel init for rollback/deploy E2E");

  const config = loadSSHConfig();
  const projectPath = `${config.remoteRepoRoot}/${projectName}`;
  const originPath = `${config.remoteRepoRoot}/.flywheel-e2e-origins/${projectName}.git`;

  const bootstrap = await sshExec(
    [
      `mkdir -p ${shellQuote(`${config.remoteRepoRoot}/.flywheel-e2e-origins`)}`,
      `if test ! -d ${shellQuote(originPath)}; then git init --bare ${shellQuote(originPath)}; fi`,
      `cd ${shellQuote(projectPath)}`,
      `git config user.email ${shellQuote("flywheel-e2e@example.invalid")}`,
      `git config user.name ${shellQuote("Flywheel E2E")}`,
      `if ! git rev-parse HEAD >/dev/null 2>&1; then printf 'seed\\n' > README.md && git add README.md && git commit -m ${shellQuote("seed remote repo")}; fi`,
      `git remote remove origin >/dev/null 2>&1 || true`,
      `git remote add origin ${shellQuote(originPath)}`,
      `git branch -M main`,
      `git push -u origin main --force`,
      `git rev-parse HEAD`,
    ].join(" && "),
    { timeoutMs: 60_000 }
  );

  if (bootstrap.code !== 0) {
    throw new Error(`Remote repo bootstrap failed:\n${bootstrap.stderr || bootstrap.stdout}`);
  }

  return {
    projectPath,
    originPath,
    initialSha: bootstrap.stdout.trim().split(/\s+/).pop() ?? "",
  };
}

async function appendTrackedChange(projectPath: string, marker: string): Promise<void> {
  const result = await sshExec(
    `cd ${shellQuote(projectPath)} && printf '\\n${marker}\\n' >> README.md`,
    { timeoutMs: 15_000 }
  );

  if (result.code !== 0) {
    throw new Error(`Failed to create tracked change:\n${result.stderr || result.stdout}`);
  }
}

async function commitRemoteChange(projectPath: string, message: string): Promise<string> {
  const result = await sshExec(
    [
      `cd ${shellQuote(projectPath)}`,
      `printf '\\n${message}\\n' >> README.md`,
      `git add README.md`,
      `git commit -m ${shellQuote(message)}`,
      `git rev-parse HEAD`,
    ].join(" && "),
    { timeoutMs: 30_000 }
  );

  if (result.code !== 0) {
    throw new Error(`Failed to create remote commit:\n${result.stderr || result.stdout}`);
  }

  return result.stdout.trim().split(/\s+/).pop() ?? "";
}

async function readRemoteHead(projectPath: string): Promise<string> {
  const result = await sshExec(
    `cd ${shellQuote(projectPath)} && git rev-parse HEAD`,
    { timeoutMs: 15_000 }
  );
  if (result.code !== 0) {
    throw new Error(`Failed to read remote HEAD:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function readOriginHead(originPath: string): Promise<string> {
  const result = await sshExec(
    `git --git-dir=${shellQuote(originPath)} rev-parse HEAD`,
    { timeoutMs: 15_000 }
  );
  if (result.code !== 0) {
    throw new Error(`Failed to read origin HEAD:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

describe("rollback/deploy local safety contracts", () => {
  it("derives the deploy confirmation target from the temp project cwd", () => {
    const result = runFlywheel(["deploy"], {
      cwd: currentWorkspace().cwd,
      env: currentWorkspace().env,
      stdin: "DEPLOY wrong-project\n",
      timeout: 15_000,
    });

    assertFailure(result, "deploy confirmation should fail with the wrong project name");
    expect(result.stdout + result.stderr).toContain(`DEPLOY ${testProject}`);
    expect(result.stdout + result.stderr).not.toContain("DEPLOY agent-flywheel-console");
  });

  it("rejects rollback before SSH when the stored checkpoint SHA is invalid", () => {
    const runId = seedRollbackRun(testProject, "definitely-not-a-sha!");
    const result = runFlywheel(["rollback", runId.slice(0, 8)], {
      cwd: currentWorkspace().cwd,
      env: currentWorkspace().env,
      stdin: "ROLLBACK\n",
      timeout: 15_000,
    });

    assertFailure(result, "rollback should reject an invalid checkpoint SHA");
    expect(result.stdout + result.stderr).toMatch(/Invalid checkpoint SHA/i);
    expect(result.stdout + result.stderr).not.toContain("at assertSafeSha");
    expect(result.stdout + result.stderr).not.toContain("Node.js v");
  });
});

describeDestructive("rollback/deploy against a prepared VPS repo", () => {
  it("resets the remote repo back to the stored checkpoint SHA", async () => {
    const remote = await prepareRemoteRepo(testProject);
    const checkpointSha = remote.initialSha;
    const postCheckpointSha = await commitRemoteChange(
      remote.projectPath,
      `rollback-target-${Date.now()}`
    );
    const runId = seedRollbackRun(testProject, checkpointSha);

    expect(postCheckpointSha).not.toBe(checkpointSha);

    const result = await runFlywheelWithDiagnostics(["rollback", runId.slice(0, 8)], {
      cwd: currentWorkspace().cwd,
      env: currentWorkspace().env,
      stdin: "ROLLBACK\n",
      timeout: 60_000,
      remoteDiagnostics: true,
      remoteProjectName: testProject,
    });

    assertSuccess(result, "rollback should succeed against the prepared remote repo");
    expect(result.stdout + result.stderr).toContain(checkpointSha.slice(0, 12));
    expect(await readRemoteHead(remote.projectPath)).toBe(checkpointSha);

    const db = initDb(currentWorkspace().stateDbPath);
    const state = new StateManager(db);
    const rollbackEvents = state
      .getEvents(runId)
      .filter((event) => event.event_type === "rollback");
    expect(rollbackEvents.length).toBeGreaterThan(0);
  });

  it("commits tracked changes and pushes them to the prepared origin remote", async () => {
    const remote = await prepareRemoteRepo(testProject);
    const beforeSha = await readRemoteHead(remote.projectPath);
    await appendTrackedChange(remote.projectPath, `deploy-change-${Date.now()}`);

    const result = await runFlywheelWithDiagnostics(["deploy"], {
      cwd: currentWorkspace().cwd,
      env: currentWorkspace().env,
      stdin: `DEPLOY ${testProject}\n`,
      timeout: 90_000,
      remoteDiagnostics: true,
      remoteProjectName: testProject,
    });

    assertSuccess(result, "deploy should commit tracked changes and push");
    expect(result.stdout).toMatch(/[0-9a-f]{12}.*→.*[0-9a-f]{12}/i);

    const afterSha = await readRemoteHead(remote.projectPath);
    expect(afterSha).not.toBe(beforeSha);
    expect(await readOriginHead(remote.originPath)).toBe(afterSha);

    const db = initDb(currentWorkspace().stateDbPath);
    const state = new StateManager(db);
    const deployRun = state
      .listFlywheelRuns()
      .find((run) => run.project_name === testProject && run.phase === "deploy");
    expect(deployRun).toBeTruthy();

    const deployEvents = state
      .getEvents(deployRun!.id)
      .filter((event) => /deploy_/.test(event.event_type))
      .map((event) => event.event_type);
    expect(deployEvents).toContain("deploy_started");
    expect(deployEvents).toContain("deploy_completed");
  });
});
