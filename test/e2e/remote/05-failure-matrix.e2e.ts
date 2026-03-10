/**
 * test/e2e/remote/05-failure-matrix.e2e.ts — bead: 3qw.5.6
 *
 * Failure matrix coverage:
 * - malformed local SSH config
 * - unreadable/missing private key
 * - unreachable SSH endpoint
 * - unavailable dashboard server port
 * - bad session/project error paths (SSH-backed, gated)
 * - missing-remote-tools probe (SSH-backed PATH isolation)
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SSHManager } from "../../../cli/ssh.js";
import { shellQuote } from "../../../cli/utils.js";
import { assertFailure, runFlywheel, hasSshConfig } from "../setup.js";

interface TempEnv {
  homeDir: string;
  env: Record<string, string>;
  cleanup: () => void;
}

function createTempEnv(): TempEnv {
  const homeDir = mkdtempSync(join(tmpdir(), "flywheel-failure-home-"));
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

async function waitForServeReady(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 8_000
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`serve readiness timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("Flywheel server running at")) {
        clearTimeout(timer);
        resolve();
      }
    });

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exited before readiness (code=${String(code)})`));
    });
  });
}

async function runRemoteCommand(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const manager = new SSHManager();
  await manager.connect();
  try {
    const result = await manager.exec(command, { timeoutMs: 30_000, noTrim: true });
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  } finally {
    manager.disconnect();
  }
}

describe("failure matrix (local deterministic cases)", () => {
  it("fails fast on malformed ssh.yaml", () => {
    const t = createTempEnv();
    try {
      writeFileSync(join(t.homeDir, "ssh.yaml"), "host: [unterminated", "utf8");
      const result = runFlywheel(["ssh", "test"], { env: t.env, timeout: 20_000 });
      assertFailure(result, "malformed ssh yaml");
      expect(result.stdout + result.stderr).toMatch(/yaml|invalid|parse|failed|unexpected end/i);
    } finally {
      t.cleanup();
    }
  });

  it("fails when ssh private key path is missing", () => {
    const t = createTempEnv();
    try {
      writeFileSync(
        join(t.homeDir, "ssh.yaml"),
        [
          "host: 127.0.0.1",
          "user: ubuntu",
          "port: 22",
          "key_path: /definitely/missing/private_key",
          "remote_repo_root: /tmp",
          "",
        ].join("\n"),
        "utf8"
      );

      const result = runFlywheel(["ssh", "test"], { env: t.env, timeout: 20_000 });
      assertFailure(result, "missing private key");
      expect(result.stdout + result.stderr).toMatch(/private key not found|key/i);
    } finally {
      t.cleanup();
    }
  });

  it("fails when SSH host/port are unreachable", () => {
    const t = createTempEnv();
    try {
      // port 1 on localhost is effectively guaranteed closed in this environment
      writeFileSync(
        join(t.homeDir, "ssh.yaml"),
        [
          "host: 127.0.0.1",
          "user: ubuntu",
          "port: 1",
          "key_path: /dev/null",
          "remote_repo_root: /tmp",
          "",
        ].join("\n"),
        "utf8"
      );

      const result = runFlywheel(["ssh", "test"], { env: t.env, timeout: 20_000 });
      assertFailure(result, "unreachable ssh host");
      expect(result.stdout + result.stderr).toMatch(/failed to connect|refused|connect/i);
    } finally {
      t.cleanup();
    }
  });

  it("fails to start a second dashboard server on an occupied port", async () => {
    const occupiedPort = 43123;
    const first = spawn("node", ["dist/cli.js", "serve", "--port", String(occupiedPort)], {
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      await waitForServeReady(first);
      const second = runFlywheel(["serve", "--port", String(occupiedPort)], { timeout: 15_000 });
      assertFailure(second, "duplicate dashboard port");
      expect(second.stdout + second.stderr).toMatch(/EADDRINUSE|address already in use|listen/i);
    } finally {
      if (first.exitCode === null) {
        first.kill("SIGINT");
      }
      await new Promise<void>((resolve) => {
        first.once("exit", () => resolve());
        setTimeout(() => resolve(), 2_000);
      });
    }
  });
});

const describeWithSsh = hasSshConfig() ? describe : describe.skip;

describeWithSsh("failure matrix (SSH-backed project/session/tooling cases)", () => {
  let tempRoot = "";
  let projectDir = "";
  const originalCwd = process.cwd();
  const projectName = `fw-missing-project-${Date.now().toString(36)}`;

  afterEach(() => {
    if (projectDir) {
      process.chdir(originalCwd);
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = "";
      projectDir = "";
    }
  });

  it("reports a bad session when sending prompt with --all to a non-existent session", () => {
    const result = runFlywheel([
      "prompts",
      "send",
      "agent-unstuck",
      "--all",
      "--session",
      `missing-session-${Date.now().toString(36)}`,
    ], { timeout: 60_000 });
    assertFailure(result, "bad session name");
    expect(result.stdout + result.stderr).toMatch(/no non-user panes|not found|session|failed/i);
  });

  it("fails swarm start for a local project whose remote path does not exist", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "flywheel-failure-proj-"));
    projectDir = join(tempRoot, projectName);
    mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);

    // We intentionally do NOT run "flywheel init <project>" first.
    const result = runFlywheel(["swarm", "1", "--no-commit"], { timeout: 90_000 });
    assertFailure(result, "bad project path");
    expect(result.stdout + result.stderr).toMatch(/git rev-parse|not a git repository|failed/i);
  });

  it("detects missing tools when PATH is stripped on remote probe command", async () => {
    const probe = await runRemoteCommand("PATH=/nonexistent which ntm");
    expect(probe.code).not.toBe(0);
  }, 60_000);
});
