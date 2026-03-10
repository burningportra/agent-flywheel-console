/**
 * test/e2e/remote/01-prompts-review.e2e.ts — bead: 3qw.5.2
 *
 * Coverage:
 * - flywheel prompts list
 * - show-equivalent preview via flywheel prompts send <name> (no target)
 * - validation failures (unknown prompt, unsupported prompts show, invalid review pass)
 * - VPS-backed prompt send + review dispatch
 * - SQLite prompt_sends evidence + remote ntm status capture
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SSHManager } from "../../../cli/ssh.js";
import { initDb } from "../../../cli/state.js";
import { shellQuote } from "../../../cli/utils.js";
import {
  assertFailure,
  assertSuccess,
  cleanupTestProject,
  hasSshConfig,
  runFlywheel,
  runFlywheelWithDiagnostics,
} from "../setup.js";

interface TempEnv {
  homeDir: string;
  env: Record<string, string>;
  cleanup: () => void;
}

interface TranscriptEntry {
  at: string;
  step: string;
  detail: string;
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

const projectName = `fw-prompts-${Date.now().toString(36)}`;
const sessionName = slugify(projectName);

const transcript: TranscriptEntry[] = [];
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

function promptSendCount(stateDbPath: string, promptName: string): number {
  const db = initDb(stateDbPath);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM prompt_sends
       WHERE prompt_name = ?`
    )
    .get(promptName) as { count: number };
  return row.count;
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

describe("prompts/review command validations", () => {
  it("prompts list exits 0 and includes known prompt names", () => {
    const result = runFlywheel(["prompts", "list"]);
    assertSuccess(result, "prompts list");
    expect(result.stdout).toContain("commit-work");
    expect(result.stdout).toContain("fresh-review");
  });

  it("prompts send without target acts as show-equivalent preview", () => {
    const result = runFlywheel(["prompts", "send", "commit-work"]);
    assertSuccess(result, "prompts send preview");
    expect(result.stdout).toMatch(/Prompt:\s+commit-work/i);
    expect(result.stdout).toMatch(/preview|tip: add --agent|--all/i);
  });

  it("prompts show is rejected (send preview is the supported surface)", () => {
    const result = runFlywheel(["prompts", "show", "commit-work"]);
    assertFailure(result, "prompts show unsupported");
    expect(result.stdout + result.stderr).toMatch(/unknown command|error/i);
  });

  it("review with invalid pass fails validation", () => {
    const result = runFlywheel(["review", "--passes", "not-a-real-pass"]);
    assertFailure(result, "review invalid pass");
    expect(result.stdout + result.stderr).toMatch(/unknown review passes|valid passes|ssh|connect/i);
  });
});

describeVps("prompts/review VPS-backed dispatch", () => {
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

    const swarmResult = await runFlywheelWithDiagnostics(["swarm", "2", "--no-commit"], {
      env: suiteEnv.env,
      timeout: 180_000,
      remoteDiagnostics: true,
      remoteProjectName: projectName,
    });
    record("swarm", `exit=${swarmResult.exitCode} stdout=${summarize(swarmResult.stdout)}`);
    assertSuccess(swarmResult, "swarm bootstrap for prompts/review");
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

      console.log("[E2E][remote-01-prompts-review] transcript start");
      for (const line of transcript) {
        console.log(
          `[E2E][remote-01-prompts-review] [${line.at}] ${line.step} | ${line.detail}`
        );
      }
      console.log("[E2E][remote-01-prompts-review] transcript end");
    }
  });

  it(
    "dispatches prompts and review passes, records prompt logs, and captures remote ntm state",
    async () => {
      if (!suiteEnv) {
        throw new Error("suite env was not initialized");
      }

      const beforeAgentUnstuckCount = promptSendCount(
        suiteEnv.env.FLYWHEEL_STATE_DB,
        "agent-unstuck"
      );
      const beforeFreshReviewCount = promptSendCount(
        suiteEnv.env.FLYWHEEL_STATE_DB,
        "fresh-review"
      );

      const sendUnknown = await runFlywheelWithDiagnostics(
        ["prompts", "send", "does-not-exist", "--all", "--session", sessionName],
        {
          env: suiteEnv.env,
          timeout: 45_000,
          remoteDiagnostics: true,
          remoteProjectName: projectName,
        }
      );
      record(
        "prompts-send-unknown",
        `exit=${sendUnknown.exitCode} stderr=${summarize(sendUnknown.stderr)}`
      );
      assertFailure(sendUnknown, "unknown prompt send");

      const sendAll = await runFlywheelWithDiagnostics(
        ["prompts", "send", "agent-unstuck", "--all", "--session", sessionName],
        {
          env: suiteEnv.env,
          timeout: 90_000,
          remoteDiagnostics: true,
          remoteProjectName: projectName,
        }
      );
      record("prompts-send-all", `exit=${sendAll.exitCode} stdout=${summarize(sendAll.stdout)}`);
      assertSuccess(sendAll, "prompts send --all");
      expect(sendAll.stdout).toMatch(/Sent "agent-unstuck"/i);

      const invalidReview = await runFlywheelWithDiagnostics(
        ["review", "--session", sessionName, "--passes", "fresh-review,not-real"],
        {
          env: suiteEnv.env,
          timeout: 45_000,
          remoteDiagnostics: true,
          remoteProjectName: projectName,
        }
      );
      record(
        "review-invalid-pass",
        `exit=${invalidReview.exitCode} stderr=${summarize(invalidReview.stderr)}`
      );
      assertFailure(invalidReview, "review invalid pass");

      const reviewResult = await runFlywheelWithDiagnostics(
        ["review", "--session", sessionName, "--passes", "fresh-review"],
        {
          env: suiteEnv.env,
          timeout: 120_000,
          remoteDiagnostics: true,
          remoteProjectName: projectName,
        }
      );
      record("review-dispatch", `exit=${reviewResult.exitCode} stdout=${summarize(reviewResult.stdout)}`);
      assertSuccess(reviewResult, "review dispatch");
      expect(reviewResult.stdout).toMatch(/Review dispatched/i);
      expect(reviewResult.stdout).toMatch(/fresh-review/i);

      const remoteStatus = await runRemoteCommand(
        `ntm status ${shellQuote(sessionName)} --json`
      );
      record(
        "remote-ntm-status",
        `code=${remoteStatus.code} stdout=${summarize(remoteStatus.stdout)} stderr=${summarize(remoteStatus.stderr)}`
      );
      expect(remoteStatus.code).toBe(0);

      const afterAgentUnstuckCount = promptSendCount(
        suiteEnv.env.FLYWHEEL_STATE_DB,
        "agent-unstuck"
      );
      const afterFreshReviewCount = promptSendCount(
        suiteEnv.env.FLYWHEEL_STATE_DB,
        "fresh-review"
      );
      record(
        "sqlite-prompt-sends",
        `agent-unstuck: ${beforeAgentUnstuckCount} -> ${afterAgentUnstuckCount}; fresh-review: ${beforeFreshReviewCount} -> ${afterFreshReviewCount}`
      );

      expect(afterAgentUnstuckCount).toBeGreaterThan(beforeAgentUnstuckCount);
      expect(afterFreshReviewCount).toBeGreaterThan(beforeFreshReviewCount);
    },
    300_000
  );
});
