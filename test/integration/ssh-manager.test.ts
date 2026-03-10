import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import yaml from "js-yaml";

import { SSHError, SSHManager, SSHTimeoutError, loadSSHConfig } from "../../cli/ssh.js";
import {
  LOCAL_USER,
  describeIfSshd,
  printTranscript,
  pushTranscript,
  startLoopbackSshd,
  type LoopbackSshdHarness,
  type TranscriptEntry,
} from "./loopback-sshd.js";

describeIfSshd("SSHManager integration — loopback sshd", () => {
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
    printTranscript("ssh-manager", transcript);
  });

  it("loads a real YAML config and expands the SSH key path", () => {
    const activeHarness = currentHarness();
    const config = loadSSHConfig(activeHarness.configPath);

    expect(config.host).toBe("127.0.0.1");
    expect(config.user).toBe(LOCAL_USER);
    expect(config.port).toBe(activeHarness.port);
    expect(config.keyPath).toBe(activeHarness.clientKeyPath);
    expect(config.remoteRepoRoot).toBe(activeHarness.remoteRepoRoot);
  });

  it("connects, reports connectivity, and disconnects cleanly", async () => {
    const activeHarness = currentHarness();
    const manager = new SSHManager(activeHarness.configPath);

    expect(manager.isConnected()).toBe(false);

    const config = await manager.connect();
    pushTranscript(transcript, "connect", `${config.user}@${config.host}:${config.port}`);

    expect(config.port).toBe(activeHarness.port);
    expect(manager.isConnected()).toBe(true);

    manager.disconnect();
    expect(manager.isConnected()).toBe(false);
    expect(manager.getConfig()).toBeNull();
  });

  it("executes commands over the loopback SSH session and honors cwd", async () => {
    const activeHarness = currentHarness();
    const manager = new SSHManager(activeHarness.configPath);

    const result = await manager.exec("pwd", {
      cwd: activeHarness.remoteRepoRoot,
      timeoutMs: 5_000,
    });
    pushTranscript(
      transcript,
      "exec",
      `code=${result.code} elapsed=${result.elapsed} stdout=${JSON.stringify(result.stdout.trim())}`
    );

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(activeHarness.remoteRepoRoot);
    expect(result.elapsed).toBeGreaterThanOrEqual(0);
    expect(manager.isConnected()).toBe(true);

    manager.disconnect();
  });

  it("streams stdout and stderr through a real SSH channel", async () => {
    const activeHarness = currentHarness();
    const manager = new SSHManager(activeHarness.configPath);
    const stream = await manager.stream(
      "printf 'out\\n'; printf 'err\\n' 1>&2; printf 'tail\\n'",
      {
        cwd: activeHarness.remoteRepoRoot,
      }
    );

    let combined = "";
    for await (const chunk of stream) {
      combined += chunk.toString();
    }
    pushTranscript(transcript, "stream", JSON.stringify(combined.trim()));

    expect(combined).toContain("out");
    expect(combined).toContain("err");
    expect(combined).toContain("tail");

    manager.disconnect();
  });

  it("times out long-running commands with SSHTimeoutError", async () => {
    const activeHarness = currentHarness();
    const manager = new SSHManager(activeHarness.configPath);

    await expect(
      manager.exec("sleep 2", {
        timeoutMs: 100,
      })
    ).rejects.toBeInstanceOf(SSHTimeoutError);
    pushTranscript(transcript, "timeout", "sleep 2 -> SSHTimeoutError");

    manager.disconnect();
  });

  it("measures loopback latency using a real SSH round-trip", async () => {
    const activeHarness = currentHarness();
    const manager = new SSHManager(activeHarness.configPath);

    await manager.connect();
    const latencyMs = await manager.getLatency();
    pushTranscript(transcript, "latency", `${latencyMs}ms`);

    expect(latencyMs).toBeGreaterThanOrEqual(0);

    manager.disconnect();
  });

  it("fails clearly for missing config files and missing private keys", () => {
    const activeHarness = currentHarness();
    expect(() =>
      loadSSHConfig(join(activeHarness.tmpDir.path, "does-not-exist.yaml"))
    ).toThrowError(SSHError);

    const missingKeyConfigPath = join(activeHarness.tmpDir.path, "missing-key.yaml");
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

    expect(() => loadSSHConfig(missingKeyConfigPath)).toThrowError(/private key/i);
  });
});
