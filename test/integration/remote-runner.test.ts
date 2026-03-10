import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, expect, it } from "vitest";
import yaml from "js-yaml";

import {
  RemoteCommandError,
  RemoteCommandRunner,
} from "../../cli/remote.js";
import { SSHManager } from "../../cli/ssh.js";
import {
  LOCAL_USER,
  describeIfSshd,
  printTranscript,
  pushTranscript,
  startLoopbackSshd,
  type LoopbackSshdHarness,
  type TranscriptEntry,
} from "./loopback-sshd.js";

describeIfSshd("RemoteCommandRunner integration — loopback sshd", () => {
  const transcript: TranscriptEntry[] = [];
  let harness: LoopbackSshdHarness | undefined;

  function currentHarness(): LoopbackSshdHarness {
    if (!harness) {
      throw new Error("Loopback sshd harness was not initialized.");
    }

    return harness;
  }

  beforeAll(async () => {
    harness = await startLoopbackSshd(transcript);
  }, 20_000);

  afterAll(async () => {
    if (!harness) {
      return;
    }

    await harness.stop();
    harness.tmpDir.cleanup();
    printTranscript("remote-runner", transcript);
  });

  it("returns stdout, stderr, duration, and honors cwd on successful commands", async () => {
    const activeHarness = currentHarness();
    const manager = new SSHManager(activeHarness.configPath);
    const runner = new RemoteCommandRunner(manager);
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const result = await runner.runRemote(
      `sh -lc "pwd; printf 'warning\\n' 1>&2"`,
      {
        cwd: activeHarness.remoteRepoRoot,
        onStdout: (chunk) => stdoutChunks.push(chunk.toString("utf8")),
        onStderr: (chunk) => stderrChunks.push(chunk.toString("utf8")),
      }
    );
    pushTranscript(
      transcript,
      "runRemote.success",
      `exit=${result.exitCode} duration=${result.duration} stdout=${JSON.stringify(
        result.stdout.trim()
      )} stderr=${JSON.stringify(result.stderr.trim())}`
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(activeHarness.remoteRepoRoot);
    expect(result.stderr.trim()).toBe("warning");
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(stdoutChunks.join("")).toContain(activeHarness.remoteRepoRoot);
    expect(stderrChunks.join("")).toContain("warning");

    manager.disconnect();
  });

  it("maps non-zero remote exits to COMMAND_FAILED with captured output", async () => {
    const activeHarness = currentHarness();
    const manager = new SSHManager(activeHarness.configPath);
    const runner = new RemoteCommandRunner(manager);

    try {
      await runner.runRemote(`sh -lc "printf 'boom\\n' 1>&2; exit 7"`);
      throw new Error("expected runRemote to throw");
    } catch (error) {
      pushTranscript(
        transcript,
        "runRemote.command-failed",
        error instanceof Error ? error.message : String(error)
      );

      expect(error).toBeInstanceOf(RemoteCommandError);
      const remoteError = error as RemoteCommandError;
      expect(remoteError.code).toBe("COMMAND_FAILED");
      expect(remoteError.command).toContain("printf 'boom");
      expect(remoteError.exitCode).toBe(7);
      expect(remoteError.stderr?.trim()).toBe("boom");
      expect(remoteError.stdout).toBe("");
      expect(remoteError.message).toContain("Remote command failed (7)");
    } finally {
      manager.disconnect();
    }
  });

  it("classifies permission-denied failures separately from generic command failures", async () => {
    const activeHarness = currentHarness();
    const manager = new SSHManager(activeHarness.configPath);
    const runner = new RemoteCommandRunner(manager);

    try {
      await runner.runRemote(
        `sh -lc "printf 'Permission denied while opening file\\n' 1>&2; exit 126"`
      );
      throw new Error("expected permission-denied failure");
    } catch (error) {
      pushTranscript(
        transcript,
        "runRemote.permission-denied",
        error instanceof Error ? error.message : String(error)
      );

      expect(error).toBeInstanceOf(RemoteCommandError);
      const remoteError = error as RemoteCommandError;
      expect(remoteError.code).toBe("PERMISSION_DENIED");
      expect(remoteError.exitCode).toBe(126);
      expect(remoteError.stderr?.toLowerCase()).toContain("permission denied");
    } finally {
      manager.disconnect();
    }
  });

  it("maps SSH timeouts to TIMEOUT errors", async () => {
    const activeHarness = currentHarness();
    const manager = new SSHManager(activeHarness.configPath);
    const runner = new RemoteCommandRunner(manager);

    try {
      await runner.runRemote("sleep 2", { timeoutMs: 100 });
      throw new Error("expected timeout");
    } catch (error) {
      pushTranscript(
        transcript,
        "runRemote.timeout",
        error instanceof Error ? error.message : String(error)
      );

      expect(error).toBeInstanceOf(RemoteCommandError);
      const remoteError = error as RemoteCommandError;
      expect(remoteError.code).toBe("TIMEOUT");
      expect(remoteError.message).toContain("timed out");
    } finally {
      manager.disconnect();
    }
  });

  it("maps SSH setup failures to CONNECTION_LOST", async () => {
    const activeHarness = currentHarness();
    const missingConfigPath = join(
      activeHarness.tmpDir.path,
      "does-not-exist-remote-runner.yaml"
    );
    const runner = new RemoteCommandRunner(new SSHManager(missingConfigPath));

    try {
      await runner.runRemote("pwd");
      throw new Error("expected connection setup failure");
    } catch (error) {
      pushTranscript(
        transcript,
        "runRemote.connection-lost",
        error instanceof Error ? error.message : String(error)
      );

      expect(error).toBeInstanceOf(RemoteCommandError);
      const remoteError = error as RemoteCommandError;
      expect(remoteError.code).toBe("CONNECTION_LOST");
      expect(remoteError.message).toContain("SSH config not found");
    }
  });

  it("streams line-delimited stdout and can omit stderr", async () => {
    const activeHarness = currentHarness();
    const manager = new SSHManager(activeHarness.configPath);
    const runner = new RemoteCommandRunner(manager);
    const lines: string[] = [];

    for await (const line of runner.streamRemote(
      `sh -lc "printf 'out-1\\n'; printf 'err-1\\n' 1>&2; printf 'out-2'"`,
      {
        cwd: activeHarness.remoteRepoRoot,
        combineStderr: false,
      }
    )) {
      lines.push(line);
    }
    pushTranscript(
      transcript,
      "streamRemote.stdout-only",
      JSON.stringify(lines)
    );

    expect(lines).toEqual(["out-1", "out-2"]);

    manager.disconnect();
  });

  it("stops cleanly when a streaming caller aborts mid-command", async () => {
    const activeHarness = currentHarness();
    const manager = new SSHManager(activeHarness.configPath);
    const runner = new RemoteCommandRunner(manager);
    const controller = new AbortController();
    const lines: string[] = [];

    for await (const line of runner.streamRemote(
      `sh -lc "printf 'first\\n'; sleep 5; printf 'second\\n'"`,
      {
        cwd: activeHarness.remoteRepoRoot,
        signal: controller.signal,
      }
    )) {
      lines.push(line);
      if (line === "first") {
        controller.abort();
      }
    }
    pushTranscript(transcript, "streamRemote.abort", JSON.stringify(lines));

    expect(lines).toEqual(["first"]);

    manager.disconnect();
  });

  it("uses real config-backed SSHManager instances only", () => {
    const activeHarness = currentHarness();
    const missingKeyConfigPath = join(
      activeHarness.tmpDir.path,
      "remote-runner-missing-key.yaml"
    );
    writeFileSync(
      missingKeyConfigPath,
      yaml.dump({
        host: "127.0.0.1",
        user: LOCAL_USER,
        port: activeHarness.port,
        key_path: join(activeHarness.tmpDir.path, "absent_ed25519"),
        remote_repo_root: activeHarness.remoteRepoRoot,
      }),
      "utf8"
    );

    const runner = new RemoteCommandRunner(new SSHManager(missingKeyConfigPath));

    return expect(runner.runRemote("pwd")).rejects.toMatchObject({
      code: "CONNECTION_LOST",
      message: expect.stringContaining("private key"),
    });
  });
});
