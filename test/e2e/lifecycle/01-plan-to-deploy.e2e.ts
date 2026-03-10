/**
 * test/e2e/lifecycle/01-plan-to-deploy.e2e.ts — bead: agent-9wjq.1
 *
 * Full destructive/live lifecycle coverage against a configured VPS:
 *   ssh test → preflight → init → new --fast --push-artifacts
 *   → beads generate → beads triage → swarm → gate advance
 *   → review --passes fresh-review → deploy
 *
 * This suite uses the real CLI and real SSH transport. Two setup steps are
 * intentionally done by the harness because the current CLI does not yet own
 * them synchronously:
 *   1. bootstrap the remote git repo with an initial commit + bare origin so
 *      swarm/deploy have a valid HEAD and push target
 *   2. seed representative beads after `flywheel beads generate`, because that
 *      command currently validates plan presence and prints prompt guidance
 *      rather than materializing beads immediately
 *
 * Requires:
 *   FLYWHEEL_TEST_E2E=1
 *   FLYWHEEL_TEST_LIVE=1
 *   FLYWHEEL_TEST_DESTRUCTIVE=1
 *   ~/.flywheel/ssh.yaml
 *   ~/.flywheel/providers.yaml
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { initDb, StateManager, type FlywheelRun, type PhaseEvent, type WizardRun } from "../../../cli/state.js";
import { loadSSHConfig, SSHManager } from "../../../cli/ssh.js";
import { shellQuote } from "../../../cli/utils.js";
import { tempDir, type TempDir } from "../../helpers.js";
import {
  cleanupTestProject,
  hasSshConfig,
  runFlywheel,
  runFlywheelWithDiagnostics,
  type E2EResult,
} from "../setup.js";

interface TestWorkspace {
  temp: TempDir;
  cwd: string;
  flywheelHome: string;
  stateDbPath: string;
  env: Record<string, string>;
}

interface RemoteRepo {
  projectPath: string;
  originPath: string;
  initialSha: string;
}

interface TranscriptEntry {
  at: string;
  step: string;
  detail: string;
}

interface RemoteExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

const sourceSshYaml = join(homedir(), ".flywheel", "ssh.yaml");
const sourceProvidersYaml = join(homedir(), ".flywheel", "providers.yaml");
const runFullLifecycle =
  process.env.FLYWHEEL_TEST_E2E === "1" &&
  process.env.FLYWHEEL_TEST_LIVE === "1" &&
  process.env.FLYWHEEL_TEST_DESTRUCTIVE === "1" &&
  hasSshConfig() &&
  existsSync(sourceProvidersYaml);
const describeLifecycle = runFullLifecycle ? describe : describe.skip;

const projectName = `flywheel-lifecycle-${Date.now().toString(36)}`;
const sessionName = slugify(projectName);
const idea = "Build a release cockpit that tracks swarm health, gate state, and deploy readiness";
const transcript: TranscriptEntry[] = [];

let workspace: TestWorkspace | null = null;
let remoteRepo: RemoteRepo | null = null;

function currentWorkspace(): TestWorkspace {
  if (!workspace) {
    throw new Error("Test workspace was not initialized.");
  }
  return workspace;
}

function nowIso(): string {
  return new Date().toISOString();
}

function record(step: string, detail: string): void {
  transcript.push({ at: nowIso(), step, detail });
}

function summarize(value: string, max = 320): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function createWorkspace(name: string): TestWorkspace {
  const temp = tempDir();
  const flywheelHome = join(temp.path, ".flywheel");
  const cwd = join(temp.path, name);
  const stateDbPath = join(flywheelHome, "state.db");

  mkdirSync(flywheelHome, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  writeFileSync(join(flywheelHome, "ssh.yaml"), readFileSync(sourceSshYaml, "utf8"), "utf8");
  writeFileSync(
    join(flywheelHome, "providers.yaml"),
    readFileSync(sourceProvidersYaml, "utf8"),
    "utf8"
  );

  return {
    temp,
    cwd,
    flywheelHome,
    stateDbPath,
    env: {
      FLYWHEEL_HOME: flywheelHome,
      FLYWHEEL_STATE_DB: stateDbPath,
    },
  };
}

function sshConfigPath(): string {
  return join(currentWorkspace().flywheelHome, "ssh.yaml");
}

async function sshExec(
  command: string,
  options: { timeoutMs?: number } = {}
): Promise<RemoteExecResult> {
  const ssh = new SSHManager(sshConfigPath());
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

async function removeRemotePath(path: string): Promise<void> {
  await sshExec(`rm -rf ${shellQuote(path)}`, { timeoutMs: 30_000 });
}

async function bootstrapRemoteRepo(name: string): Promise<RemoteRepo> {
  const config = loadSSHConfig(sshConfigPath());
  const projectPath = `${config.remoteRepoRoot}/${name}`;
  const originPath = `${config.remoteRepoRoot}/.flywheel-e2e-origins/${name}.git`;

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
    { timeoutMs: 90_000 }
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

async function seedRemoteBeads(projectPath: string): Promise<void> {
  const result = await sshExec(
    [
      `cd ${shellQuote(projectPath)}`,
      `br create ${shellQuote("Break planning output into implementation beads")} -t task -p 1 -d ${shellQuote("Turn the uploaded plan into an execution-ready bead graph with dependencies.")} --actor flywheel-e2e >/dev/null`,
      `br create ${shellQuote("Validate gate and swarm safety contracts")} -t task -p 1 -d ${shellQuote("Cover checkpoint, rollback, and deploy confirmation safety paths.")} --actor flywheel-e2e >/dev/null`,
      `br create ${shellQuote("Capture operator transcript artifacts")} -t task -p 2 -d ${shellQuote("Persist lifecycle evidence so failures are diagnosable without re-running the suite.")} --actor flywheel-e2e >/dev/null`,
    ].join(" && "),
    { timeoutMs: 60_000 }
  );

  if (result.code !== 0) {
    throw new Error(`Failed to seed remote beads:\n${result.stderr || result.stdout}`);
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

async function readOriginHead(originPath: string): Promise<string> {
  const result = await sshExec(`git --git-dir=${shellQuote(originPath)} rev-parse HEAD`, {
    timeoutMs: 15_000,
  });
  if (result.code !== 0) {
    throw new Error(`Failed to read origin HEAD:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function readRemoteFile(path: string): Promise<string> {
  const result = await sshExec(`cat ${shellQuote(path)}`, { timeoutMs: 15_000 });
  if (result.code !== 0) {
    throw new Error(`Failed to read remote file ${path}:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function readRemoteBrList(projectPath: string): Promise<string> {
  const result = await sshExec(`cd ${shellQuote(projectPath)} && br list --all`, {
    timeoutMs: 20_000,
  });
  if (result.code !== 0) {
    throw new Error(`Failed to list remote beads:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function appendTrackedChange(projectPath: string, marker: string): Promise<void> {
  const result = await sshExec(
    `cd ${shellQuote(projectPath)} && printf '\\n${marker}\\n' >> README.md`,
    { timeoutMs: 15_000 }
  );

  if (result.code !== 0) {
    throw new Error(`Failed to append tracked change:\n${result.stderr || result.stdout}`);
  }
}

function extractOutputPath(stdout: string, label: string): string {
  const match = stdout.match(new RegExp(`${label}:\\s+(.+)$`, "mi"));
  if (!match?.[1]) {
    throw new Error(`Could not find "${label}" in output:\n${stdout}`);
  }
  return match[1].trim();
}

function latestWizardRun(project: string): WizardRun | undefined {
  const state = new StateManager(initDb(currentWorkspace().stateDbPath));
  return state.listWizardRuns().find((run) => run.project_name === project);
}

function latestFlywheelRun(project: string, phase: FlywheelRun["phase"]): FlywheelRun | undefined {
  const state = new StateManager(initDb(currentWorkspace().stateDbPath));
  return state
    .listFlywheelRuns()
    .find((run) => run.project_name === project && run.phase === phase);
}

function promptSendCount(promptName: string, runId?: string): number {
  const db = initDb(currentWorkspace().stateDbPath);
  const row = runId
    ? (db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM prompt_sends
           WHERE prompt_name = ? AND run_id = ?`
        )
        .get(promptName, runId) as { count: number })
    : (db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM prompt_sends
           WHERE prompt_name = ?`
        )
        .get(promptName) as { count: number });
  return row.count;
}

function latestLatencyMs(): number | null {
  const db = initDb(currentWorkspace().stateDbPath);
  const row = db
    .prepare("SELECT latency_ms FROM ssh_connections ORDER BY id DESC LIMIT 1")
    .get() as { latency_ms: number | null } | undefined;
  return row?.latency_ms ?? null;
}

function recentPhaseEvents(limit = 50): string {
  const db = initDb(currentWorkspace().stateDbPath);
  const rows = db
    .prepare(
      `SELECT timestamp, run_id, event_type
       FROM phase_events
       ORDER BY timestamp DESC
       LIMIT ?`
    )
    .all(limit) as Array<{ timestamp: string; run_id: string; event_type: string }>;

  if (rows.length === 0) {
    return "(none)";
  }

  return rows
    .slice()
    .reverse()
    .map((row) => `${row.timestamp} ${row.run_id.slice(0, 8)} ${row.event_type}`)
    .join("\n");
}

function assertSuccessWithPhaseEvents(result: E2EResult, step: string): void {
  if (result.exitCode === 0) {
    return;
  }

  throw new Error(
    `${step} failed (exit ${result.exitCode}).\n` +
      `stdout:\n${result.stdout || "(empty)"}\n\n` +
      `stderr:\n${result.stderr || "(empty)"}\n\n` +
      `Recent phase_events:\n${recentPhaseEvents()}`
  );
}

function recordResult(step: string, result: E2EResult): void {
  record(
    step,
    `exit=${result.exitCode} duration=${result.durationMs}ms stdout=${summarize(result.stdout)} stderr=${summarize(result.stderr)}`
  );
}

function assertChronological(events: PhaseEvent[], label: string): void {
  const timestamps = events.map((event) => new Date(event.timestamp).getTime());
  const sorted = timestamps.slice().sort((a, b) => a - b);
  expect(timestamps, `${label} should stay chronological`).toEqual(sorted);
}

describeLifecycle("flywheel lifecycle: plan to deploy", () => {
  beforeAll(() => {
    workspace = createWorkspace(projectName);
  });

  afterAll(async () => {
    try {
      if (remoteRepo) {
        await removeRemotePath(remoteRepo.originPath);
      }
      await cleanupTestProject(projectName);
    } finally {
      workspace?.temp.cleanup();
      workspace = null;
      remoteRepo = null;

      console.log("[E2E][lifecycle-01-plan-to-deploy] transcript start");
      for (const entry of transcript) {
        console.log(
          `[E2E][lifecycle-01-plan-to-deploy] [${entry.at}] ${entry.step} | ${entry.detail}`
        );
      }
      console.log("[E2E][lifecycle-01-plan-to-deploy] transcript end");
    }
  });

  it(
    "drives the real CLI across ssh, planning, beads, swarm, review, and deploy",
    async () => {
      const ws = currentWorkspace();

      const sshTest = runFlywheel(["ssh", "test"], {
        cwd: ws.cwd,
        env: ws.env,
        timeout: 30_000,
      });
      recordResult("ssh-test", sshTest);
      assertSuccessWithPhaseEvents(sshTest, "flywheel ssh test");
      expect(sshTest.stdout).toMatch(/Connected to/i);
      expect(latestLatencyMs()).toBeGreaterThan(0);

      const preflight = await runFlywheelWithDiagnostics(["preflight"], {
        cwd: ws.cwd,
        env: ws.env,
        timeout: 60_000,
        remoteDiagnostics: true,
        remoteProjectName: projectName,
      });
      recordResult("preflight", preflight);
      assertSuccessWithPhaseEvents(preflight, "flywheel preflight");
      for (const tool of ["ntm", "br", "bv", "gh", "git"]) {
        expect(preflight.stdout).toContain(`✓ ${tool}`);
      }

      const initResult = await runFlywheelWithDiagnostics(["init", projectName], {
        cwd: ws.cwd,
        env: ws.env,
        timeout: 90_000,
        remoteDiagnostics: true,
        remoteProjectName: projectName,
      });
      recordResult("init", initResult);
      assertSuccessWithPhaseEvents(initResult, "flywheel init");

      remoteRepo = await bootstrapRemoteRepo(projectName);
      record(
        "bootstrap-remote-repo",
        `projectPath=${remoteRepo.projectPath} originPath=${remoteRepo.originPath} initialSha=${remoteRepo.initialSha.slice(0, 12)}`
      );
      expect(remoteRepo.initialSha).toMatch(/^[0-9a-f]{40}$/i);

      const wizardResult = await runFlywheelWithDiagnostics(
        ["new", idea, "--fast", "--push-artifacts"],
        {
          cwd: ws.cwd,
          env: ws.env,
          timeout: 300_000,
          remoteDiagnostics: true,
          remoteProjectName: projectName,
        }
      );
      recordResult("wizard", wizardResult);
      assertSuccessWithPhaseEvents(wizardResult, "flywheel new --fast --push-artifacts");
      expect(wizardResult.stdout).toMatch(/Wizard complete/i);

      const localPlanPath = extractOutputPath(wizardResult.stdout, "Plan");
      const localLogPath = extractOutputPath(wizardResult.stdout, "Log");
      const remotePlanPath = extractOutputPath(wizardResult.stdout, "VPS plan");
      const remoteLogPath = extractOutputPath(wizardResult.stdout, "VPS log");

      expect(existsSync(localPlanPath)).toBe(true);
      expect(existsSync(localLogPath)).toBe(true);

      const localPlan = readFileSync(localPlanPath, "utf8");
      expect(localPlan).toContain("# Plan:");
      expect(localPlan).toContain("## Adversarial Risk Assessment");

      const remotePlan = await readRemoteFile(remotePlanPath);
      const remoteLog = await readRemoteFile(remoteLogPath);
      expect(remotePlan).toContain("## Adversarial Risk Assessment");
      expect(remoteLog.trim().length).toBeGreaterThan(0);

      const wizardRun = latestWizardRun(projectName);
      expect(wizardRun).toBeTruthy();
      expect(wizardRun?.status).toBe("completed");
      expect(wizardRun?.plan_path).toBe(localPlanPath);

      const wizardState = new StateManager(initDb(ws.stateDbPath));
      const wizardApiCalls = wizardRun ? wizardState.getApiCalls(wizardRun.id) : [];
      expect(wizardApiCalls.length).toBeGreaterThan(0);
      expect(wizardRun ? wizardState.getTotalCost(wizardRun.id) : 0).toBeGreaterThan(0);

      const beadsGenerate = await runFlywheelWithDiagnostics(["beads", "generate"], {
        cwd: ws.cwd,
        env: ws.env,
        timeout: 45_000,
        remoteDiagnostics: true,
        remoteProjectName: projectName,
      });
      recordResult("beads-generate", beadsGenerate);
      assertSuccessWithPhaseEvents(beadsGenerate, "flywheel beads generate");
      expect(beadsGenerate.stdout).toMatch(/plan\.md found/i);
      expect(beadsGenerate.stdout).toMatch(/beads-generate-from-plan/i);

      await seedRemoteBeads(remoteRepo.projectPath);
      const remoteBeadList = await readRemoteBrList(remoteRepo.projectPath);
      record("seed-beads", summarize(remoteBeadList));
      expect(remoteBeadList).toContain("Break planning output into implementation beads");
      expect(remoteBeadList).toContain("Validate gate and swarm safety contracts");

      const triageResult = await runFlywheelWithDiagnostics(["beads", "triage", "--top", "3"], {
        cwd: ws.cwd,
        env: ws.env,
        timeout: 60_000,
        remoteDiagnostics: true,
        remoteProjectName: projectName,
      });
      recordResult("beads-triage", triageResult);
      assertSuccessWithPhaseEvents(triageResult, "flywheel beads triage --top 3");
      expect(triageResult.stdout).toMatch(/Top [1-3] priority beads/i);
      expect(triageResult.stdout).not.toMatch(/board is clear/i);

      const headBeforeSwarm = await readRemoteHead(remoteRepo.projectPath);
      const swarmResult = await runFlywheelWithDiagnostics(["swarm", "1", "--no-commit"], {
        cwd: ws.cwd,
        env: ws.env,
        timeout: 180_000,
        remoteDiagnostics: true,
        remoteProjectName: projectName,
      });
      recordResult("swarm", swarmResult);
      assertSuccessWithPhaseEvents(swarmResult, "flywheel swarm 1 --no-commit");
      expect(swarmResult.stdout).toMatch(/Swarm started/i);
      expect(swarmResult.stdout).toMatch(new RegExp(`session\\s+"${sessionName}"`, "i"));

      const swarmRun = latestFlywheelRun(projectName, "swarm");
      expect(swarmRun).toBeTruthy();
      expect(swarmRun?.checkpoint_sha).toBe(headBeforeSwarm);

      const swarmState = new StateManager(initDb(ws.stateDbPath));
      const swarmEventsBeforeGate = swarmRun ? swarmState.getEvents(swarmRun.id) : [];
      expect(swarmEventsBeforeGate.map((event) => event.event_type)).toContain("swarm_checkpoint_created");
      expect(swarmEventsBeforeGate.map((event) => event.event_type)).toContain("swarm_spawned");
      assertChronological(swarmEventsBeforeGate, "swarm events before gate advance");

      const gateAdvance = await runFlywheelWithDiagnostics(
        ["gate", "advance", "--sha", headBeforeSwarm],
        {
          cwd: ws.cwd,
          env: ws.env,
          timeout: 45_000,
          remoteDiagnostics: true,
          remoteProjectName: projectName,
        }
      );
      recordResult("gate-advance", gateAdvance);
      assertSuccessWithPhaseEvents(gateAdvance, "flywheel gate advance --sha");
      expect(gateAdvance.stdout).toMatch(/Gate advanced/i);
      expect(gateAdvance.stdout).toContain(headBeforeSwarm.slice(0, 12));

      const advancedSwarmRun = swarmRun ? new StateManager(initDb(ws.stateDbPath)).getFlywheelRun(swarmRun.id) : undefined;
      expect(advancedSwarmRun?.phase).toBe("review");
      expect(advancedSwarmRun?.gate_passed_at).toBeTruthy();

      const swarmEventsAfterGate = swarmRun
        ? new StateManager(initDb(ws.stateDbPath)).getEvents(swarmRun.id)
        : [];
      expect(swarmEventsAfterGate.map((event) => event.event_type)).toContain("gate_advanced");
      assertChronological(swarmEventsAfterGate, "swarm events after gate advance");

      const reviewPromptCountBefore = promptSendCount("fresh-review");
      const reviewResult = await runFlywheelWithDiagnostics(
        ["review", "--passes", "fresh-review", "--session", sessionName],
        {
          cwd: ws.cwd,
          env: ws.env,
          timeout: 120_000,
          remoteDiagnostics: true,
          remoteProjectName: projectName,
        }
      );
      recordResult("review", reviewResult);
      assertSuccessWithPhaseEvents(reviewResult, "flywheel review --passes fresh-review");
      expect(reviewResult.stdout).toMatch(/Review dispatched/i);
      expect(reviewResult.stdout).toMatch(/fresh-review/i);

      const reviewRun = latestFlywheelRun(projectName, "review");
      expect(reviewRun).toBeTruthy();
      const reviewEvents = reviewRun
        ? new StateManager(initDb(ws.stateDbPath)).getEvents(reviewRun.id)
        : [];
      expect(reviewEvents.map((event) => event.event_type)).toContain("review_started");
      expect(reviewEvents.map((event) => event.event_type)).toContain("review_prompt_sent");
      assertChronological(reviewEvents, "review events");
      expect(promptSendCount("fresh-review")).toBeGreaterThan(reviewPromptCountBefore);
      expect(reviewRun ? promptSendCount("fresh-review", reviewRun.id) : 0).toBeGreaterThan(0);

      const headBeforeDeploy = await readRemoteHead(remoteRepo.projectPath);
      await appendTrackedChange(remoteRepo.projectPath, `deploy-marker-${Date.now()}`);

      const deployResult = await runFlywheelWithDiagnostics(["deploy"], {
        cwd: ws.cwd,
        env: ws.env,
        stdin: `DEPLOY ${projectName}\n`,
        timeout: 120_000,
        remoteDiagnostics: true,
        remoteProjectName: projectName,
      });
      recordResult("deploy", deployResult);
      assertSuccessWithPhaseEvents(deployResult, "flywheel deploy");
      expect(deployResult.stdout).toMatch(/Deploy complete/i);
      expect(deployResult.stdout).toMatch(/[0-9a-f]{12}.*→.*[0-9a-f]{12}/i);

      const headAfterDeploy = await readRemoteHead(remoteRepo.projectPath);
      expect(headAfterDeploy).not.toBe(headBeforeDeploy);
      expect(await readOriginHead(remoteRepo.originPath)).toBe(headAfterDeploy);

      const deployRun = latestFlywheelRun(projectName, "deploy");
      expect(deployRun).toBeTruthy();
      const deployEvents = deployRun
        ? new StateManager(initDb(ws.stateDbPath)).getEvents(deployRun.id)
        : [];
      expect(deployEvents.map((event) => event.event_type)).toContain("deploy_started");
      expect(deployEvents.map((event) => event.event_type)).toContain("deploy_completed");
      assertChronological(deployEvents, "deploy events");
    },
    600_000
  );
});
