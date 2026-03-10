import { StringDecoder } from "node:string_decoder";

import { SSHError, SSHManager, SSHTimeoutError } from "./ssh.js";

export type RemoteCommandErrorCode =
  | "TIMEOUT"
  | "CONNECTION_LOST"
  | "COMMAND_FAILED"
  | "PERMISSION_DENIED";

export interface RunRemoteOptions {
  cwd?: string;
  timeoutMs?: number;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
  silent?: boolean;
}

export interface StreamRemoteOptions {
  cwd?: string;
  signal?: AbortSignal;
  combineStderr?: boolean;
}

export interface RemoteCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
}

export class RemoteCommandError extends Error {
  readonly code: RemoteCommandErrorCode;
  readonly command: string;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;

  constructor(
    code: RemoteCommandErrorCode,
    command: string,
    message: string,
    options?: {
      cause?: Error;
      exitCode?: number;
      stdout?: string;
      stderr?: string;
    }
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "RemoteCommandError";
    this.code = code;
    this.command = command;
    this.exitCode = options?.exitCode;
    this.stdout = options?.stdout;
    this.stderr = options?.stderr;
  }
}

export class RemoteCommandRunner {
  constructor(private readonly ssh: SSHManager) {}

  async runRemote(command: string, options: RunRemoteOptions = {}): Promise<RemoteCommandResult> {
    try {
      const result = await this.ssh.exec(command, {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        onStdout: options.silent ? undefined : options.onStdout,
        onStderr: options.silent ? undefined : options.onStderr,
      });

      if (result.code !== 0) {
        throw new RemoteCommandError(
          classifyFailure(result.stderr, result.stdout),
          command,
          buildFailureMessage(command, result.code, result.stderr),
          {
            exitCode: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
          }
        );
      }

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.code,
        duration: result.elapsed,
      };
    } catch (error) {
      if (error instanceof RemoteCommandError) {
        throw error;
      }

      throw mapRemoteError(command, error);
    }
  }

  async *streamRemote(
    command: string,
    options: StreamRemoteOptions = {}
  ): AsyncIterable<string> {
    const decoder = new StringDecoder("utf8");
    let pending = "";

    try {
      const remoteStream = await this.ssh.stream(command, {
        cwd: options.cwd,
        combineStderr: options.combineStderr,
        signal: options.signal,
      });

      for await (const chunk of remoteStream) {
        pending += decoder.write(asBuffer(chunk));

        let newlineIndex = pending.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = pending.slice(0, newlineIndex).replace(/\r$/, "");
          pending = pending.slice(newlineIndex + 1);
          yield line;
          newlineIndex = pending.indexOf("\n");
        }
      }

      pending += decoder.end();

      if (pending.length > 0) {
        yield pending.replace(/\r$/, "");
      }
    } catch (error) {
      if (options.signal?.aborted) {
        return;
      }

      throw mapRemoteError(command, error);
    }
  }
}

function asBuffer(chunk: string | Buffer): Buffer {
  return typeof chunk === "string" ? Buffer.from(chunk) : chunk;
}

function classifyFailure(stderr: string, stdout: string): RemoteCommandErrorCode {
  const combinedOutput = `${stderr}\n${stdout}`.toLowerCase();

  if (combinedOutput.includes("permission denied")) {
    return "PERMISSION_DENIED";
  }

  return "COMMAND_FAILED";
}

function buildFailureMessage(command: string, exitCode: number, stderr: string): string {
  const trimmedStderr = stderr.trim();

  if (trimmedStderr.length > 0) {
    return `Remote command failed (${exitCode}) for "${command}": ${trimmedStderr}`;
  }

  return `Remote command failed (${exitCode}) for "${command}".`;
}

function mapRemoteError(command: string, error: unknown): RemoteCommandError {
  if (error instanceof RemoteCommandError) {
    return error;
  }

  if (error instanceof SSHTimeoutError) {
    return new RemoteCommandError("TIMEOUT", command, error.message, { cause: error });
  }

  if (error instanceof SSHError) {
    const message = error.message.toLowerCase();

    if (message.includes("permission denied")) {
      return new RemoteCommandError("PERMISSION_DENIED", command, error.message, {
        cause: error,
      });
    }

    return new RemoteCommandError("CONNECTION_LOST", command, error.message, {
      cause: error,
    });
  }

  const message = error instanceof Error ? error.message : "Unknown remote command failure";
  return new RemoteCommandError("COMMAND_FAILED", command, message, {
    cause: error instanceof Error ? error : undefined,
  });
}
