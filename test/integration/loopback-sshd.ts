import { createServer } from "node:net";
import os from "node:os";
import { createInterface } from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";

import yaml from "js-yaml";
import { describe } from "vitest";

import { tempDir } from "../helpers.js";

export interface TranscriptEntry {
  at: string;
  step: string;
  detail: string;
}

export interface LoopbackSshdHarness {
  tmpDir: ReturnType<typeof tempDir>;
  port: number;
  configPath: string;
  clientKeyPath: string;
  remoteRepoRoot: string;
  stop: () => Promise<void>;
}

const SSHD_BIN = "/usr/sbin/sshd";
const SSH_KEYGEN_BIN = "ssh-keygen";

export const LOCAL_USER = detectLocalUser();
export const describeIfSshd =
  existsSync(SSHD_BIN) &&
  Boolean(
    spawnSync("bash", ["-lc", `command -v ${SSH_KEYGEN_BIN}`]).status === 0
  )
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

export function pushTranscript(
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

export function printTranscript(
  label: string,
  transcript: TranscriptEntry[]
): void {
  console.log(`[INTEGRATION][${label}] transcript start`);
  for (const entry of transcript) {
    console.log(`${entry.at} ${entry.step} ${entry.detail}`);
  }
  console.log(`[INTEGRATION][${label}] transcript end`);
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
      `${command} ${args.join(" ")} failed with status ${String(
        result.status
      )}.\nerror=${result.error?.message ?? "(none)"}\nstdout=${
        result.stdout ?? ""
      }\nstderr=${result.stderr ?? ""}`
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

export async function startLoopbackSshd(
  transcript: TranscriptEntry[]
): Promise<LoopbackSshdHarness> {
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

  const stdoutRl = createInterface({ input: child.stdout });
  const stderrRl = createInterface({ input: child.stderr });
  const stderrLines: string[] = [];

  stdoutRl.on("line", (line) => {
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
