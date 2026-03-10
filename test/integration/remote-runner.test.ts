/**
 * test/integration/remote-runner.test.ts — bead: agent-flywheel-console-3qw.6.2
 *
 * Tests RemoteCommandRunner against the real loopback SSH harness.
 * Verifies command execution, exit code classification, cwd propagation,
 * error classification, and abort-safe async streaming.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SSHManager } from "../../cli/ssh.js";
import {
  RemoteCommandRunner,
  RemoteCommandError,
} from "../../cli/remote.js";
import { startLoopbackSsh, type LoopbackSshServer } from "../helpers/ssh-loopback.js";

// ── Shared harness lifecycle ──────────────────────────────────────────────────

describe("RemoteCommandRunner.runRemote() — loopback exec", () => {
  let srv: LoopbackSshServer;
  let ssh: SSHManager;
  let runner: RemoteCommandRunner;

  beforeEach(async () => {
    srv = await startLoopbackSsh();
    ssh = new SSHManager(srv.sshConfigPath);
    await ssh.connect();
    runner = new RemoteCommandRunner(ssh);
  });

  afterEach(async () => {
    ssh.disconnect();
    await srv.stop();
  });

  it("captures stdout of a successful command", async () => {
    const result = await runner.runRemote("echo remote-output");
    expect(result.stdout).toContain("remote-output");
    expect(result.exitCode).toBe(0);
    expect(result.duration).toBeGreaterThan(0);
  });

  it("captures stderr alongside stdout", async () => {
    const result = await runner.runRemote(
      "echo out-line; echo err-line >&2; exit 0"
    );
    expect(result.stdout).toContain("out-line");
    expect(result.stderr).toContain("err-line");
    expect(result.exitCode).toBe(0);
  });

  it("throws RemoteCommandError(COMMAND_FAILED) on non-zero exit", async () => {
    const err = await runner.runRemote("exit 7").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteCommandError);
    const rce = err as RemoteCommandError;
    expect(rce.code).toBe("COMMAND_FAILED");
    expect(rce.exitCode).toBe(7);
    expect(rce.command).toBe("exit 7");
  });

  it("throws RemoteCommandError(PERMISSION_DENIED) when stderr contains 'permission denied'", async () => {
    // Craft a command that exits non-zero and mentions permission denied in stderr
    const cmd = "echo 'permission denied' >&2; exit 1";
    const err = await runner.runRemote(cmd).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteCommandError);
    const rce = err as RemoteCommandError;
    expect(rce.code).toBe("PERMISSION_DENIED");
  });

  it("propagates cwd — command runs in the specified directory", async () => {
    // node-ssh prepends `cd "<cwd>" && ` so the real cwd is set by the shell
    const result = await runner.runRemote("pwd", { cwd: "/tmp" });
    expect(result.stdout.trim()).toMatch(/tmp/);
    expect(result.exitCode).toBe(0);
  });

  it("throws RemoteCommandError(TIMEOUT) when timeoutMs elapses", async () => {
    const err = await runner
      .runRemote("sleep 30", { timeoutMs: 300 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteCommandError);
    const rce = err as RemoteCommandError;
    expect(rce.code).toBe("TIMEOUT");
  });

  it("includes the original command in the error for failed commands", async () => {
    const cmd = "false";
    const err = await runner.runRemote(cmd).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteCommandError);
    expect((err as RemoteCommandError).command).toBe(cmd);
  });
});

// ── streamRemote() ────────────────────────────────────────────────────────────

describe("RemoteCommandRunner.streamRemote() — async line iteration", () => {
  let srv: LoopbackSshServer;
  let ssh: SSHManager;
  let runner: RemoteCommandRunner;

  beforeEach(async () => {
    srv = await startLoopbackSsh();
    ssh = new SSHManager(srv.sshConfigPath);
    await ssh.connect();
    runner = new RemoteCommandRunner(ssh);
  });

  afterEach(async () => {
    ssh.disconnect();
    await srv.stop();
  });

  it("yields each line of multi-line output", async () => {
    const lines: string[] = [];
    for await (const line of runner.streamRemote(
      "printf 'first\\nsecond\\nthird\\n'"
    )) {
      lines.push(line);
    }
    expect(lines).toContain("first");
    expect(lines).toContain("second");
    expect(lines).toContain("third");
  });

  it("yields combined stderr when combineStderr is true", async () => {
    const lines: string[] = [];
    for await (const line of runner.streamRemote(
      "echo stdout-msg; echo stderr-msg >&2",
      { combineStderr: true }
    )) {
      lines.push(line);
    }
    const joined = lines.join(" ");
    expect(joined).toContain("stdout-msg");
    expect(joined).toContain("stderr-msg");
  });

  it("AbortSignal stops iteration before the command finishes", async () => {
    const controller = new AbortController();
    const lines: string[] = [];

    const iteration = (async () => {
      for await (const line of runner.streamRemote("sleep 30", {
        signal: controller.signal,
      })) {
        lines.push(line);
      }
    })();

    // Abort after a short delay
    await new Promise<void>((r) => setTimeout(r, 50));
    controller.abort();

    // Should resolve (not hang) once aborted
    await iteration;
    // We don't assert on line count — just that it terminated
    expect(Array.isArray(lines)).toBe(true);
  });
});
