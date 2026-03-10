/**
 * test/e2e/remote/04-monitor-autopilot.e2e.ts — bead: 3qw.5.5
 *
 * Bounded-time control-surface tests for long-running commands:
 * - flywheel monitor startup failure path + operator warning
 * - flywheel autopilot startup output + heartbeat + graceful SIGINT shutdown
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { assertFailure, runFlywheel } from "../setup.js";

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

function createTempEnv(): TempEnv {
  const homeDir = mkdtempSync(join(tmpdir(), "flywheel-monitor-e2e-home-"));
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
    const child = spawn("node", [CLI, "autopilot", "--interval", "1"], {
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        ...t.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

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
      console.log("[E2E][remote-04-monitor-autopilot] transcript start");
      for (const entry of lines) {
        console.log(
          `[E2E][remote-04-monitor-autopilot] [${entry.at}] ${entry.stream} | ${stripAnsi(entry.line)}`
        );
      }
      console.log("[E2E][remote-04-monitor-autopilot] transcript end");
      t.cleanup();
    }
  }, 40_000);
});
