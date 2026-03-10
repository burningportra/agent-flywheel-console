import { createServer } from "node:net";
import os from "node:os";
import { createInterface } from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import yaml from "js-yaml";

import { tempDir } from "../helpers.js";
import { SSHError, SSHManager, SSHTimeoutError, loadSSHConfig } from "../../cli/ssh.js";

interface TranscriptEntry {
  at: string;
  step: string;
  detail: string;
}

interface LoopbackSshdHarness {
  tmpDir: ReturnType<typeof tempDir>;
  port: number;
  configPath: string;
  clientKeyPath: string;
  remoteRepoRoot: string;
  stop: () => Promise<void>;
}

const SSHD_BIN = "/usr/sbin/sshd";
const SSH_KEYGEN_BIN = "ssh-keygen";
const LOCAL_USER = detectLocalUser();
const describeIfSshd =
  existsSync(SSHD_BIN) && Boolean(spawnSync("bash", ["-lc", `command -v ${SSH_KEYGEN_BIN}`]).status === 0)
    ? describe
    : describe.skip;

function detectLocalUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? "ubuntu";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function pushTranscript(
  transcript: TranscriptEntry[],
  step: string,
  detail: string
): void {
  transcript.push({
    at: nowIso(),
    step,
    detail,
  });
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  await once(server, "close");

  if (!address || typeof address === "string") {
    throw new Error("Failed to allocate a free loopback port for the SSH harness.");
  }

  return address.port;
}

function runCheckedCommand(
  transcript: TranscriptEntry[],
  command: string,
  args: string[]
): void {
  pushTranscript(transcript, "spawnSync", `${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    encoding: "utf8",
  });

  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${String(result.status)}.\nerror=${result.error?.message ?? "(none)"}\nstdout=${result.stdout ?? ""}\nstderr=${result.stderr ?? ""}`
    );
  }
}

async function waitForSshdReady(
  stderrLines: string[],
  exitCode: () => number | null,
  transcript: TranscriptEntry[],
  timeoutMs = 5_000
): Promise<void> {
  const startedAt = Date.now();
  const readinessPattern = /Server listening on 127\.0\.0\.1 port \d+\./;

  while (Date.now() - startedAt < timeoutMs) {
    if (stderrLines.some((line) => readinessPattern.test(line))) {
      pushTranscript(transcript, "sshd-ready", "loopback sshd reported listening");
      return;
    }

    if (exitCode() !== null) {
      throw new Error("Loopback sshd exited before reporting readiness.");
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for loopback sshd to report readiness.");
}

async function startLoopbackSshd(transcript: TranscriptEntry[]): Promise<LoopbackSshdHarness> {
  const tmpDir = tempDir();
  const remoteRepoRoot = join(tmpDir.path, "remote-root");
  mkdirSync(remoteRepoRoot, { recursive: true });

  const clientKeyPath = join(tmpDir.path, "client_ed25519");
  const hostKeyPath = join(tmpDir.path, "host_ed25519");
  const authorizedKeysPath = join(tmpDir.path, "authorized_keys");
  const sshdConfigPath = join(tmpDir.path, "sshd_config");
  const sshYamlPath = join(tmpDir.path, "ssh.yaml");
  const port = await findFreePort();

  runCheckedCommand(transcript, SSH_KEYGEN_BIN, [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    clientKeyPath,
  ]);
  runCheckedCommand(transcript, SSH_KEYGEN_BIN, [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    hostKeyPath,
  ]);

  writeFileSync(authorizedKeysPath, readFileSync(`${clientKeyPath}.pub`, "utf8"), {
    encoding: "utf8",
    mode: 0o600,
  });

  const sshdConfig = [
    `Port ${port}`,
    "ListenAddress 127.0.0.1",
    `HostKey ${hostKeyPath}`,
    `PidFile ${join(tmpDir.path, "sshd.pid")}`,
    `AuthorizedKeysFile ${authorizedKeysPath}`,
    "PasswordAuthentication no",
    "PubkeyAuthentication yes",
    "KbdInteractiveAuthentication no",
    "ChallengeResponseAuthentication no",
    "PermitEmptyPasswords no",
    "PermitRootLogin no",
    "UsePAM no",
    "StrictModes no",
    `AllowUsers ${LOCAL_USER}`,
    "LogLevel VERBOSE",
  ].join("\n");
  writeFileSync(sshdConfigPath, sshdConfig, "utf8");
  writeFileSync(
    sshYamlPath,
    yaml.dump({
      host: "127.0.0.1",
      user: LOCAL_USER,
      port,
      key_path: clientKeyPath,
      remote_repo_root: remoteRepoRoot,
    }),
    "utf8"
  );

  runCheckedCommand(transcript, SSHD_BIN, ["-t", "-f", sshdConfigPath]);

  pushTranscript(transcript, "spawn", `${SSHD_BIN} -D -e -f ${sshdConfigPath}`);
  const child = spawn(SSHD_BIN, ["-D", "-e", "-f", sshdConfigPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const stdoutRl = createInterface({ input: child.stdout });
  const stderrRl = createInterface({ input: child.stderr });

  stdoutRl.on("line", (line) => {
    stdoutLines.push(line);
    pushTranscript(transcript, "sshd.stdout", line);
  });
  stderrRl.on("line", (line) => {
    stderrLines.push(line);
    pushTranscript(transcript, "sshd.stderr", line);
  });

  child.once("exit", (code, signal) => {
    pushTranscript(
      transcript,
      "sshd.exit",
      `code=${String(code)} signal=${String(signal)}`
    );
  });

  await waitForSshdReady(stderrLines, () => child.exitCode, transcript);

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.killed) {
      stdoutRl.close();
      stderrRl.close();
      return;
    }

    child.kill("SIGTERM");
    await Promise.race([
      once(child, "exit").then(() => undefined),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          if (child.exitCode === null) {
            child.kill("SIGKILL");
          }
          resolve();
        }, 2_000);
      }),
    ]);

    stdoutRl.close();
    stderrRl.close();
  };

  return {
    tmpDir,
    port,
    configPath: sshYamlPath,
    clientKeyPath,
    remoteRepoRoot,
    stop,
  };
}

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

    console.log("[INTEGRATION][ssh-manager] transcript start");
    for (const entry of transcript) {
      console.log(`${entry.at} ${entry.step} ${entry.detail}`);
    }
    console.log("[INTEGRATION][ssh-manager] transcript end");
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

    expect(config.port).toBe(harness.port);
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
    expect(() => loadSSHConfig(join(activeHarness.tmpDir.path, "does-not-exist.yaml"))).toThrowError(
      SSHError
    );

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
