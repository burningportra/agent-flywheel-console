/**
 * test/e2e/remote/04-monitor-autopilot.e2e.ts — bead: 3qw.5.5
 *
 * Bounded-time control-surface tests for long-running commands:
 * - flywheel monitor startup failure path + operator warning
 * - flywheel autopilot startup output + heartbeat + graceful SIGINT shutdown
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

interface TimedLine {
  at: string;
  stream: "stdout" | "stderr";
  line: string;
}

const CLI = resolve("dist/cli.js");
const runVpsE2e = process.env.FLYWHEEL_TEST_E2E === "1" && hasSshConfig();
const describeVps = runVpsE2e ? describe : describe.skip;
const sourceSshYaml = join(homedir(), ".flywheel", "ssh.yaml");
const sourceProvidersYaml = join(homedir(), ".flywheel", "providers.yaml");
const projectName = `fw-monitor-${Date.now().toString(36)}`;
const sessionName = slugify(projectName);

let remoteWorkspaceDir = "";
let remoteProjectDir = "";
let remoteEnv: TempEnv | null = null;

function createTempEnv(copySshConfig = false): TempEnv {
  const homeDir = mkdtempSync(join(tmpdir(), "flywheel-monitor-e2e-home-"));
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
    env: {
      FLYWHEEL_HOME: homeDir,
      FLYWHEEL_STATE_DB: join(homeDir, "state.db"),
    },
    cleanup: () => {
      rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function captureProcessLines(child: ChildProcessWithoutNullStreams): TimedLine[] {
  const lines: TimedLine[] = [];
  let stdoutBuf = "";
  let stderrBuf = "";

  const flush = (buffer: string, stream: "stdout" | "stderr"): string => {
    let pending = buffer;
    for (;;) {
      const idx = pending.indexOf("\n");
      if (idx === -1) break;
      const line = pending.slice(0, idx).replace(/\r/g, "");
      lines.push({ at: nowIso(), stream, line });
      pending = pending.slice(idx + 1);
    }
    return pending;
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf8");
    stdoutBuf = flush(stdoutBuf, "stdout");
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf8");
    stderrBuf = flush(stderrBuf, "stderr");
  });

  child.once("exit", () => {
    if (stdoutBuf.trim()) lines.push({ at: nowIso(), stream: "stdout", line: stdoutBuf.trim() });
    if (stderrBuf.trim()) lines.push({ at: nowIso(), stream: "stderr", line: stderrBuf.trim() });
  });

  return lines;
}

async function waitForLine(
  lines: TimedLine[],
  pattern: RegExp,
  timeoutMs: number
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (lines.some((entry) => pattern.test(stripAnsi(entry.line)))) {
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for pattern ${String(pattern)} in captured output.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Process did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function spawnFlywheel(
  args: string[],
  env: Record<string, string>,
  cwd?: string
): ChildProcessWithoutNullStreams {
  return spawn("node", [CLI, ...args], {
    cwd,
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function dumpTranscript(label: string, lines: TimedLine[]): void {
  console.log(`[E2E][${label}] transcript start`);
  for (const entry of lines) {
    console.log(`[E2E][${label}] [${entry.at}] ${entry.stream} | ${stripAnsi(entry.line)}`);
  }
  console.log(`[E2E][${label}] transcript end`);
}

describe("monitor/autopilot long-running control surfaces", () => {
  it("monitor shows actionable warning when SSH is unavailable", () => {
    const t = createTempEnv();
    try {
      const result = runFlywheel(["monitor", "--interval", "1"], {
        env: t.env,
        timeout: 20_000,
      });
      assertFailure(result, "monitor requires SSH");
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toMatch(/cannot connect|ssh/i);
      expect(output).toMatch(/flywheel ssh test/i);
    } finally {
      t.cleanup();
    }
  });

  it("autopilot emits startup/heartbeat output and exits cleanly on SIGINT", async () => {
    const t = createTempEnv();
    const child = spawnFlywheel(["autopilot", "--interval", "1"], t.env);

    const lines = captureProcessLines(child);
    try {
      await waitForLine(lines, /Starting flywheel autopilot/i, 10_000);
      await waitForLine(lines, /Flywheel Autopilot|poll 1/i, 10_000);
      await waitForLine(lines, /Next poll in|local-only mode|SSH offline/i, 10_000);

      // Let one more heartbeat cycle begin, then request graceful shutdown.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      child.kill("SIGINT");
      const code = await waitForExit(child, 10_000);
      expect(code).toBe(0);

      const merged = lines.map((entry) => stripAnsi(entry.line)).join("\n");
      expect(merged).toMatch(/Starting flywheel autopilot/i);
      expect(merged).toMatch(/poll 1|Flywheel Autopilot/i);
      expect(merged).toMatch(/Autopilot stopped/i);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      dumpTranscript("remote-04-monitor-autopilot-local", lines);
      t.cleanup();
    }
  }, 40_000);
});

describeVps("monitor/autopilot VPS-backed happy paths", () => {
  beforeAll(async () => {
    remoteEnv = createTempEnv(true);
    remoteWorkspaceDir = mkdtempSync(join(tmpdir(), "flywheel-monitor-e2e-ws-"));
    remoteProjectDir = join(remoteWorkspaceDir, projectName);
    mkdirSync(remoteProjectDir, { recursive: true });

    const initResult = await runFlywheelWithDiagnostics(["init", projectName], {
      cwd: remoteProjectDir,
      env: remoteEnv.env,
      timeout: 120_000,
      remoteDiagnostics: true,
      remoteProjectName: projectName,
    });
    assertSuccess(initResult, "remote init for monitor/autopilot");

    const swarmResult = await runFlywheelWithDiagnostics(["swarm", "1", "--no-commit"], {
      cwd: remoteProjectDir,
      env: remoteEnv.env,
      timeout: 180_000,
      remoteDiagnostics: true,
      remoteProjectName: projectName,
    });
    assertSuccess(swarmResult, "remote swarm bootstrap for monitor/autopilot");
  }, 240_000);

  afterAll(async () => {
    try {
      await cleanupTestProject(projectName);
    } finally {
      if (remoteWorkspaceDir) {
        rmSync(remoteWorkspaceDir, { recursive: true, force: true });
      }
      remoteEnv?.cleanup();
      remoteWorkspaceDir = "";
      remoteProjectDir = "";
      remoteEnv = null;
    }
  });

  it("monitor renders remote SSH/session/agent state and exits cleanly on SIGINT", async () => {
    if (!remoteEnv) {
      throw new Error("Remote env was not initialized.");
    }

    const child = spawnFlywheel(
      ["monitor", "--interval", "1", "--session", sessionName],
      remoteEnv.env,
      remoteProjectDir
    );
    const lines = captureProcessLines(child);

    try {
      await waitForLine(lines, /Flywheel Monitor/i, 15_000);
      await waitForLine(lines, /latency\s+\d+ms|SSH .* latency/i, 20_000);
      await waitForLine(lines, /NTM Sessions/i, 20_000);
      await waitForLine(lines, new RegExp(sessionName, "i"), 20_000);
      await waitForLine(lines, /Agent Activity|pane\s+\d+/i, 20_000);

      await new Promise((resolve) => setTimeout(resolve, 1_500));
      child.kill("SIGINT");
      const code = await waitForExit(child, 10_000);
      expect(code).toBe(0);

      const merged = lines.map((entry) => stripAnsi(entry.line)).join("\n");
      expect(merged).toMatch(new RegExp(sessionName, "i"));
      expect(merged).toMatch(/Agent Activity|pane\s+\d+/i);
      expect(merged).toMatch(/Monitor stopped/i);
      expect(merged).not.toMatch(/Cannot connect|NTM unreachable/i);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      dumpTranscript("remote-04-monitor-autopilot-monitor-vps", lines);
    }
  }, 60_000);

  it("autopilot shows remote bead stats instead of falling back to local-only mode", async () => {
    if (!remoteEnv) {
      throw new Error("Remote env was not initialized.");
    }

    const child = spawnFlywheel(["autopilot", "--interval", "1"], remoteEnv.env, remoteProjectDir);
    const lines = captureProcessLines(child);

    try {
      await waitForLine(lines, /Starting flywheel autopilot/i, 10_000);
      await waitForLine(lines, /Flywheel Autopilot|poll 1/i, 10_000);
      await waitForLine(lines, /Current run:/i, 15_000);
      await waitForLine(lines, /Beads \(remote\):/i, 20_000);
      await waitForLine(lines, /Next poll in/i, 10_000);

      await new Promise((resolve) => setTimeout(resolve, 1_500));
      child.kill("SIGINT");
      const code = await waitForExit(child, 10_000);
      expect(code).toBe(0);

      const merged = lines.map((entry) => stripAnsi(entry.line)).join("\n");
      expect(merged).toMatch(/Current run:/i);
      expect(merged).toMatch(/Beads \(remote\):/i);
      expect(merged).toMatch(/Autopilot stopped/i);
      expect(merged).not.toMatch(/local-only mode|SSH offline/i);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      dumpTranscript("remote-04-monitor-autopilot-autopilot-vps", lines);
    }
  }, 60_000);
});
