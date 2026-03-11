import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";

import yaml from "js-yaml";
import { NodeSSH } from "node-ssh";
import { flywheelPath } from "./config.js";
import { shellQuote } from "./utils.js";

const DEFAULT_SSH_TIMEOUT_MS = 30_000;
const DEFAULT_SSH_PORT = 22;

interface RawSSHConfig {
  host?: unknown;
  user?: unknown;
  port?: unknown;
  key_path?: unknown;
  remote_repo_root?: unknown;
}

export interface SSHConfig {
  host: string;
  user: string;
  port: number;
  keyPath: string;
  remoteRepoRoot: string;
}

export interface ExecOptions {
  cwd?: string;
  stdin?: string | Readable;
  noTrim?: boolean;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
  timeoutMs?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  elapsed: number;
}

export interface StreamOptions {
  cwd?: string;
  combineStderr?: boolean;
  signal?: AbortSignal;
}

interface SSHStreamChannel {
  // `any[]` is intentional: this models the node EventEmitter `.on()` signature
  // where event payload types vary per event name. TypeScript's own EventEmitter
  // types use `any[]` for the same reason — `unknown[]` breaks contravariance.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this;
  stderr: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, listener: (...args: any[]) => void): unknown;
  };
  close(): void;
  destroy(): void;
}

export class SSHError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SSHError";
  }
}

export class SSHTimeoutError extends SSHError {
  constructor(command: string, timeoutMs: number) {
    super(`SSH command timed out after ${timeoutMs}ms: ${command}`);
    this.name = "SSHTimeoutError";
  }
}

export function getDefaultSSHConfigPath(): string {
  return flywheelPath("ssh.yaml");
}

export function expandHomeDir(inputPath: string): string {
  if (inputPath === "~") {
    return os.homedir();
  }

  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return inputPath;
}

export function loadSSHConfig(configPath = getDefaultSSHConfigPath()): SSHConfig {
  const resolvedConfigPath = expandHomeDir(configPath);

  if (!fs.existsSync(resolvedConfigPath)) {
    throw new SSHError(
      `SSH config not found at ${resolvedConfigPath}. Run "flywheel settings ssh" first.`
    );
  }

  const rawContent = fs.readFileSync(resolvedConfigPath, "utf8");
  const parsed = yaml.load(rawContent);

  if (!parsed || typeof parsed !== "object") {
    throw new SSHError(`SSH config at ${resolvedConfigPath} is empty or invalid YAML.`);
  }

  const rawConfig = parsed as RawSSHConfig;
  const host = expectString(rawConfig.host, "host");
  const user = expectString(rawConfig.user, "user");
  const keyPath = expandHomeDir(expectString(rawConfig.key_path, "key_path"));
  const remoteRepoRoot = expectString(rawConfig.remote_repo_root, "remote_repo_root");
  const port = expectPort(rawConfig.port);

  if (!fs.existsSync(keyPath)) {
    throw new SSHError(`SSH private key not found at ${keyPath}.`);
  }

  try {
    fs.accessSync(keyPath, fs.constants.R_OK);
  } catch (error) {
    throw new SSHError(`SSH private key is not readable at ${keyPath}.`, {
      cause: error instanceof Error ? error : undefined,
    });
  }

  return {
    host,
    user,
    port,
    keyPath,
    remoteRepoRoot,
  };
}

export class SSHManager {
  private client: NodeSSH | null = null;
  private config: SSHConfig | null = null;
  private readonly configPath: string;

  constructor(configPath = getDefaultSSHConfigPath()) {
    this.configPath = configPath;
  }

  async connect(): Promise<SSHConfig> {
    if (this.client?.isConnected() && this.config) {
      return this.config;
    }

    const config = loadSSHConfig(this.configPath);
    const client = new NodeSSH();

    // Prefer the SSH agent (SSH_AUTH_SOCK) so passphrase-protected keys work
    // without storing the passphrase. Fall back to direct key file only when
    // no agent socket is available.
    const agentSocket = process.env["SSH_AUTH_SOCK"];
    const authOptions = agentSocket
      ? { agent: agentSocket }
      : { privateKeyPath: config.keyPath };

    try {
      await client.connect({
        host: config.host,
        port: config.port,
        username: config.user,
        ...authOptions,
      });
    } catch (error) {
      client.dispose();

      const message =
        error instanceof Error ? error.message : "Unknown SSH connection failure";

      throw new SSHError(
        `Failed to connect to ${config.user}@${config.host}:${config.port}: ${message}`,
        { cause: error instanceof Error ? error : undefined }
      );
    }

    this.client = client;
    this.config = config;

    return config;
  }

  disconnect(): void {
    this.client?.dispose();
    this.client = null;
    // Clear stale config so the next connect() always re-reads from disk.
    this.config = null;
  }

  isConnected(): boolean {
    return this.client?.isConnected() ?? false;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const client = await this.getClient();
    const startedAt = Date.now();
    let channel: { close?: () => void; destroy?: () => void } | null = null;

    try {
      const response = await withTimeout(
        client.execCommand(command, {
          cwd: options.cwd,
          stdin: options.stdin,
          noTrim: options.noTrim,
          onStdout: options.onStdout,
          onStderr: options.onStderr,
          onChannel: (openedChannel) => {
            channel = openedChannel;
          },
        }),
        options.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS,
        () => {
          channel?.close?.();
          channel?.destroy?.();
        },
        command
      );

      return {
        stdout: response.stdout,
        stderr: response.stderr,
        // node-ssh returns null for abnormally terminated commands; use -1 (not 0)
        // so callers that check `code !== 0` correctly detect failure.
        code: response.code ?? -1,
        elapsed: Date.now() - startedAt,
      };
    } catch (error) {
      if (!this.isConnected()) {
        this.disconnect();
      }

      if (error instanceof SSHError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : "Unknown SSH exec failure";
      throw new SSHError(`SSH exec failed for "${command}": ${message}`, {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  async stream(command: string, options: StreamOptions = {}): Promise<Readable> {
    const client = await this.getClient();
    const connection = client.connection;

    if (!connection) {
      this.disconnect();
      throw new SSHError("SSH connection dropped before streaming started.");
    }

    const stream = new PassThrough();
    const fullCommand = options.cwd
      ? `cd ${shellQuote(options.cwd)} && ${command}`
      : command;

    return await new Promise<Readable>((resolve, reject) => {
      let settled = false;
      let channelRef: SSHStreamChannel | null = null;

      const abortStream = () => {
        if (!settled) {
          settled = true;
          reject(new SSHError(`SSH stream aborted before start: ${command}`));
        } else {
          stream.end();
        }

        channelRef?.close();
        channelRef?.destroy();
      };

      const onAbort = () => {
        abortStream();
      };

      if (options.signal?.aborted) {
        abortStream();
        return;
      }

      connection.exec(fullCommand, {}, (error: Error | undefined, channel: SSHStreamChannel) => {
        channelRef = channel;

        if (error) {
          settled = true;
          reject(
            new SSHError(`Failed to open SSH stream for "${command}": ${error.message}`, {
              cause: error,
            })
          );
          return;
        }

        if (options.signal) {
          options.signal.addEventListener("abort", onAbort, { once: true });
        }

        if (options.signal?.aborted) {
          abortStream();
          return;
        }

        channel.on("data", (chunk: Buffer) => {
          stream.write(chunk);
        });

        if (options.combineStderr !== false) {
          channel.stderr.on("data", (chunk: Buffer) => {
            stream.write(chunk);
          });
        }

        channel.on("close", () => {
          options.signal?.removeEventListener("abort", onAbort);
          stream.end();
        });

        channel.on("error", (channelError: Error) => {
          options.signal?.removeEventListener("abort", onAbort);
          stream.destroy(channelError);
        });

        settled = true;
        resolve(stream);
      });
    });
  }

  async getLatency(): Promise<number> {
    const result = await this.exec("echo ping", {
      timeoutMs: 5_000,
      noTrim: true,
    });

    if (!result.stdout.includes("ping")) {
      throw new SSHError("Latency probe succeeded without expected ping response.");
    }

    return result.elapsed;
  }

  getConfig(): SSHConfig | null {
    return this.config;
  }

  private async getClient(): Promise<NodeSSH> {
    if (!this.client?.isConnected()) {
      await this.connect();
    }

    if (!this.client?.isConnected()) {
      throw new SSHError("SSH client is not connected.");
    }

    return this.client;
  }
}

function expectString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SSHError(`SSH config is missing a valid "${key}" value.`);
  }

  return value.trim();
}

function expectPort(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > 65535
  ) {
    throw new SSHError('SSH config "port" must be an integer between 1 and 65535.');
  }

  return value;
}


async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  command: string
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          onTimeout();
          reject(new SSHTimeoutError(command, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export {
  DEFAULT_SSH_PORT,
  DEFAULT_SSH_TIMEOUT_MS,
};
