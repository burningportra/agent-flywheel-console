/**
 * test/e2e/remote/02-swarm-gate.e2e.ts — bead: 3qw.5.3
 *
 * Real VPS orchestration loop coverage:
 * - swarm spawn
 * - remote ntm status evidence
 * - pause via ntm interrupt
 * - resume-by-reprime via flywheel prompts send --all
 * - gate status / gate advance
 *
 * Negative coverage:
 * - invalid swarm count
 * - gate advance without active run
 * - unsupported dedicated resume command on current NTM build
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SSHManager } from "../../../cli/ssh.js";
import { initDb, StateManager } from "../../../cli/state.js";
import { shellQuote } from "../../../cli/utils.js";
import {
  assertFailure,
  assertSuccess,
  cleanupTestProject,
  hasSshConfig,
  runFlywheel,
  runFlywheelWithDiagnostics,
} from "../setup.js";

interface TranscriptEntry {
  at: string;
  step: string;
  detail: string;
}

interface TempEnv {
  homeDir: string;
  env: Record<string, string>;
  cleanup: () => void;
}

interface RemoteEvidence {
  code: number;
  stdout: string;
  stderr: string;
}

const runVpsE2e = process.env.FLYWHEEL_TEST_E2E === "1" && hasSshConfig();
const describeVps = runVpsE2e ? describe : describe.skip;
const sourceSshYaml = join(homedir(), ".flywheel", "ssh.yaml");
const sourceProvidersYaml = join(homedir(), ".flywheel", "providers.yaml");

const transcript: TranscriptEntry[] = [];
const projectName = `fw-remote-${Date.now().toString(36)}`;
const sessionName = slugify(projectName);

const originalCwd = process.cwd();
let workspaceDir = "";
let suiteEnv: TempEnv | null = null;

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

function createTempEnv(copySshConfig: boolean): TempEnv {
  const homeDir = mkdtempSync(join(tmpdir(), "flywheel-e2e-home-"));
  const env: Record<string, string> = {
    FLYWHEEL_HOME: homeDir,
    FLYWHEEL_STATE_DB: join(homeDir, "state.db"),
  };

  if (copySshConfig) {
    if (!existsSync(sourceSshYaml)) {
      throw new Error(`Missing SSH config at ${sourceSshYaml}`);
    }
    cpSync(sourceSshYaml, join(homeDir, "ssh.yaml"));
    if (existsSync(sourceProvidersYaml)) {
      cpSync(sourceProvidersYaml, join(homeDir, "providers.yaml"));
    }
  }

  return {
    homeDir,
    env,
    cleanup: () => {
      rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

function latestRunForProject(stateDbPath: string, targetProject: string) {
  const sm = new StateManager(initDb(stateDbPath));
  return sm.listFlywheelRuns().find((run) => run.project_name === targetProject);
}

async function runRemoteCommand(command: string): Promise<RemoteEvidence> {
  const manager = new SSHManager();
  await manager.connect();
  try {
    const result = await manager.exec(command, { timeoutMs: 30_000, noTrim: true });
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    manager.disconnect();
  }
}

describe("swarm/gate E2E negative command cases", () => {
  it("rejects invalid swarm count before orchestration starts", () => {
    const result = runFlywheel(["swarm", "not-a-number"], { timeout: 20_000 });
    assertFailure(result, "swarm count validation");
    expect(result.stdout + result.stderr).toMatch(/positive integer|must be/i);
  });

  it("gate advance fails when no run exists in a clean local state DB", () => {
    const cleanEnv = createTempEnv(false);
    try {
      const result = runFlywheel(["gate", "advance"], { env: cleanEnv.env, timeout: 20_000 });
      assertFailure(result, "gate advance without run");
      expect(result.stdout + result.stderr).toMatch(/no flywheel runs|nothing to advance/i);
    } finally {
      cleanEnv.cleanup();
    }
  });
});

describeVps("swarm/gate E2E remote orchestration loop", () => {
  beforeAll(async () => {
    suiteEnv = createTempEnv(true);

    workspaceDir = mkdtempSync(join(tmpdir(), "flywheel-e2e-ws-"));
    const projectDir = join(workspaceDir, projectName);
    mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);
    record("cwd", `switched to ${projectDir}`);

    const initResult = await runFlywheelWithDiagnostics(["init", projectName], {
      env: suiteEnv.env,
      timeout: 120_000,
      remoteDiagnostics: true,
      remoteProjectName: projectName,
    });
    record("init", `exit=${initResult.exitCode} stdout=${summarize(initResult.stdout)}`);
    assertSuccess(initResult, "remote init");
  });

  afterAll(async () => {
    try {
      if (runVpsE2e) {
        await cleanupTestProject(projectName);
      }
    } finally {
      process.chdir(originalCwd);
      if (workspaceDir) {
        rmSync(workspaceDir, { recursive: true, force: true });
      }
      suiteEnv?.cleanup();

      console.log("[E2E][remote-02-swarm-gate] transcript start");
      for (const line of transcript) {
        console.log(
          `[E2E][remote-02-swarm-gate] [${line.at}] ${line.step} | ${line.detail}`
        );
      }
      console.log("[E2E][remote-02-swarm-gate] transcript end");
    }
  });

  it(
    "covers spawn, remote status, pause, resume-by-reprime, gate status, and gate advance with evidence",
    async () => {
      if (!suiteEnv) {
        throw new Error("suite env was not initialized");
      }

      const swarmResult = await runFlywheelWithDiagnostics(["swarm", "2", "--no-commit"], {
        env: suiteEnv.env,
        timeout: 180_000,
        remoteDiagnostics: true,
        remoteProjectName: projectName,
      });
      record(
        "swarm",
        `exit=${swarmResult.exitCode} stdout=${summarize(swarmResult.stdout)}`
      );
      assertSuccess(swarmResult, "swarm start");
      expect(swarmResult.stdout).toMatch(/Swarm started/i);
      expect(swarmResult.stdout).toMatch(new RegExp(`session\\s+\"${sessionName}\"`, "i"));

      const runAfterSwarm = latestRunForProject(suiteEnv.env.FLYWHEEL_STATE_DB, projectName);
      record(
        "sqlite-after-swarm",
        runAfterSwarm
          ? `phase=${runAfterSwarm.phase} checkpoint=${runAfterSwarm.checkpoint_sha?.slice(0, 12) ?? "none"}`
          : "run not found"
      );
      expect(runAfterSwarm).toBeTruthy();
      expect(runAfterSwarm?.phase).toBe("swarm");
      expect(runAfterSwarm?.checkpoint_sha).toMatch(/^[0-9a-f]{7,}$/i);

      const ntmBeforePause = await runRemoteCommand(
        `ntm status ${shellQuote(sessionName)} --json`
      );
      record(
        "ntm-status-before-pause",
        `code=${ntmBeforePause.code} stdout=${summarize(ntmBeforePause.stdout)} stderr=${summarize(ntmBeforePause.stderr)}`
      );
      expect(ntmBeforePause.code).toBe(0);

      const pauseResult = await runRemoteCommand(
        `ntm interrupt ${shellQuote(sessionName)} --json`
      );
      record(
        "ntm-interrupt",
        `code=${pauseResult.code} stdout=${summarize(pauseResult.stdout)} stderr=${summarize(pauseResult.stderr)}`
      );
      expect(pauseResult.code).toBe(0);

      const ntmAfterPause = await runRemoteCommand(
        `ntm status ${shellQuote(sessionName)} --json`
      );
      record(
        "ntm-status-after-pause",
        `code=${ntmAfterPause.code} stdout=${summarize(ntmAfterPause.stdout)} stderr=${summarize(ntmAfterPause.stderr)}`
      );
      expect(ntmAfterPause.code).toBe(0);

      const unsupportedResume = await runRemoteCommand(
        `ntm resume ${shellQuote(sessionName)} --json`
      );
      record(
        "ntm-resume-unsupported-check",
        `code=${unsupportedResume.code} stdout=${summarize(unsupportedResume.stdout)} stderr=${summarize(unsupportedResume.stderr)}`
      );
      expect(unsupportedResume.code).not.toBe(0);
      expect(`${unsupportedResume.stdout}\n${unsupportedResume.stderr}`).toMatch(
        /resume|unknown|invalid|not found|unsupported/i
      );

      const reprimeResult = await runFlywheelWithDiagnostics(
        ["prompts", "send", "agent-unstuck", "--all", "--session", sessionName],
        {
          env: suiteEnv.env,
          timeout: 90_000,
          remoteDiagnostics: true,
          remoteProjectName: projectName,
        }
      );
      record(
        "resume-by-reprime",
        `exit=${reprimeResult.exitCode} stdout=${summarize(reprimeResult.stdout)}`
      );
      assertSuccess(reprimeResult, "resume-by-reprime");

      const ntmAfterResume = await runRemoteCommand(
        `ntm status ${shellQuote(sessionName)} --json`
      );
      record(
        "ntm-status-after-reprime",
        `code=${ntmAfterResume.code} stdout=${summarize(ntmAfterResume.stdout)} stderr=${summarize(ntmAfterResume.stderr)}`
      );
      expect(ntmAfterResume.code).toBe(0);

      const gateStatusResult = await runFlywheelWithDiagnostics(["gate", "status"], {
        env: suiteEnv.env,
        timeout: 30_000,
        remoteDiagnostics: true,
        remoteProjectName: projectName,
      });
      record(
        "gate-status",
        `exit=${gateStatusResult.exitCode} stdout=${summarize(gateStatusResult.stdout)}`
      );
      assertSuccess(gateStatusResult, "gate status");
      expect(gateStatusResult.stdout).toMatch(/swarm/i);

      const gateAdvanceResult = await runFlywheelWithDiagnostics(["gate", "advance"], {
        env: suiteEnv.env,
        timeout: 45_000,
        remoteDiagnostics: true,
        remoteProjectName: projectName,
      });
      record(
        "gate-advance",
        `exit=${gateAdvanceResult.exitCode} stdout=${summarize(gateAdvanceResult.stdout)}`
      );
      assertSuccess(gateAdvanceResult, "gate advance");
      expect(gateAdvanceResult.stdout).toMatch(/Gate advanced/i);
      expect(gateAdvanceResult.stdout).toMatch(/swarm.*review|review/i);

      const runAfterGateAdvance = latestRunForProject(
        suiteEnv.env.FLYWHEEL_STATE_DB,
        projectName
      );
      record(
        "sqlite-after-gate-advance",
        runAfterGateAdvance
          ? `phase=${runAfterGateAdvance.phase} gate_passed_at=${runAfterGateAdvance.gate_passed_at ?? "none"}`
          : "run not found"
      );
      expect(runAfterGateAdvance).toBeTruthy();
      expect(runAfterGateAdvance?.phase).toBe("review");
      expect(runAfterGateAdvance?.gate_passed_at).toBeTruthy();
    },
    360_000
  );
});
