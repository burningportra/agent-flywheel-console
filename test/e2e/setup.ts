/**
 * test/e2e/setup.ts
 * Shared E2E test harness for all end-to-end test suites.
 *
 * Provides:
 *   - runFlywheel() / runFlywheelWithDiagnostics()
 *   - skipIfNoSsh() / assertSshConfigured()
 *   - getTestProject() / cleanupTestProject()
 *
 * VPS-backed suites can opt into SSH diagnostics without reimplementing
 * transcript handling in every spec file.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { SSHManager, loadSSHConfig } from "../../cli/ssh.js";

const CLI = resolve("dist/cli.js");
const ARTIFACTS_DIR = resolve("test-artifacts");

export interface E2EEnvSummary {
  cwd: string;
  ci: boolean;
  flywheelHome: string;
  stateDbPath: string;
  sshConfigPath: string;
  sshConfigured: boolean;
  liveEnabled: boolean;
  destructiveEnabled: boolean;
  extraEnv: Record<string, string>;
}

export interface RemoteCommandResult {
  label: string;
  command: string;
  code: number;
  elapsedMs: number;
  stdout: string;
  stderr: string;
}

export interface RemoteDiagnostics {
  host: string;
  projectPath: string | null;
  commands: RemoteCommandResult[];
  error?: string;
}

export interface E2EResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  output: string;
  envSummary: E2EEnvSummary;
  remoteDiagnostics: RemoteDiagnostics | null;
}

export interface RunFlywheelOptions {
  env?: Record<string, string>;
  stdin?: string;
  timeout?: number;
  silent?: boolean;
  cwd?: string;
  remoteDiagnostics?: boolean;
  remoteProjectName?: string;
}

function ensureArtifactsDir(suite: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const dir = join(ARTIFACTS_DIR, date, suite);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTranscript(dir: string, args: string[], result: E2EResult): void {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const cmdSlug = args[0] ?? "flywheel";
  const path = join(dir, `${ts}-${cmdSlug}.txt`);
  const lines = [
    `=== flywheel ${args.join(" ")} ===`,
    `exit: ${result.exitCode}  duration: ${result.durationMs}ms`,
    `--- env summary ---`,
    JSON.stringify(result.envSummary, null, 2),
    `--- stdout ---`,
    result.stdout || "(empty)",
    `--- stderr ---`,
    result.stderr || "(empty)",
    `--- remote diagnostics ---`,
    result.remoteDiagnostics
      ? JSON.stringify(result.remoteDiagnostics, null, 2)
      : "(none)",
    ``,
  ].join("\n");
  appendFileSync(path, lines, "utf8");
}

export function runFlywheel(
  args: string[],
  opts: RunFlywheelOptions = {}
): E2EResult {
  const result = executeFlywheel(args, opts);
  emitE2ELogs(args, result, opts.silent ?? false);
  maybeWriteTranscript(args, result);
  return result;
}

export async function runFlywheelWithDiagnostics(
  args: string[],
  opts: RunFlywheelOptions = {}
): Promise<E2EResult> {
  const result = executeFlywheel(args, opts);
  result.remoteDiagnostics = opts.remoteDiagnostics
    ? await collectRemoteDiagnostics(opts.remoteProjectName)
    : null;
  emitE2ELogs(args, result, opts.silent ?? false);
  maybeWriteTranscript(args, result);
  return result;
}

function executeFlywheel(
  args: string[],
  opts: RunFlywheelOptions
): E2EResult {
  const effectiveEnv = {
    ...process.env,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    ...(opts.env ?? {}),
  };
  const commandCwd = opts.cwd ?? process.cwd();
  const envSummary = buildEnvSummary(effectiveEnv, opts.env ?? {}, commandCwd);
  const startedAt = Date.now();
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    cwd: commandCwd,
    env: effectiveEnv,
    input: opts.stdin,
    timeout: opts.timeout ?? 30_000,
  });

  const durationMs = Date.now() - startedAt;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitCode = result.status ?? (result.signal ? 1 : 0);

  return {
    exitCode,
    stdout,
    stderr,
    durationMs,
    output: stdout + (stderr ? `\n[stderr]\n${stderr}` : ""),
    envSummary,
    remoteDiagnostics: null,
  };
}

function emitE2ELogs(args: string[], result: E2EResult, silent: boolean): void {
  if (silent) {
    return;
  }

  console.log(`\n[E2E] cmd:    flywheel ${args.join(" ")}`);
  console.log(`[E2E] exit:   ${result.exitCode} in ${result.durationMs}ms`);
  console.log(`[E2E] env:    ${JSON.stringify(result.envSummary)}`);
  if (result.stdout.trim()) {
    console.log(`[E2E] stdout:\n${result.stdout.trimEnd()}`);
  }
  if (result.stderr.trim()) {
    console.log(`[E2E] stderr:\n${result.stderr.trimEnd()}`);
  }
  if (result.remoteDiagnostics) {
    console.log(
      `[E2E] remote diagnostics:\n${JSON.stringify(result.remoteDiagnostics, null, 2)}`
    );
  }
}

function maybeWriteTranscript(args: string[], result: E2EResult): void {
  if (!(process.env.CI || process.env.FLYWHEEL_TEST_ARTIFACTS)) {
    return;
  }

  try {
    const suite = process.env.VITEST_SUITE_NAME ?? "e2e";
    writeTranscript(ensureArtifactsDir(suite), args, result);
  } catch {
    // Never fail the suite because artifact writing failed.
  }
}

function buildEnvSummary(
  effectiveEnv: NodeJS.ProcessEnv,
  extraEnv: Record<string, string>,
  cwd: string
): E2EEnvSummary {
  const flywheelHome = effectiveEnv.FLYWHEEL_HOME ?? join(homedir(), ".flywheel");
  const stateDbPath = effectiveEnv.FLYWHEEL_STATE_DB ?? join(flywheelHome, "state.db");
  const sshConfigPath = join(flywheelHome, "ssh.yaml");

  return {
    cwd,
    ci: Boolean(effectiveEnv.CI),
    flywheelHome,
    stateDbPath,
    sshConfigPath,
    sshConfigured: existsSync(sshConfigPath),
    liveEnabled: effectiveEnv.FLYWHEEL_TEST_LIVE === "1",
    destructiveEnabled: effectiveEnv.FLYWHEEL_TEST_DESTRUCTIVE === "1",
    extraEnv,
  };
}

async function collectRemoteDiagnostics(
  remoteProjectName?: string
): Promise<RemoteDiagnostics> {
  try {
    const config = loadSSHConfig();
    const manager = new SSHManager();
    await manager.connect();

    const projectPath = remoteProjectName
      ? `${config.remoteRepoRoot}/${remoteProjectName}`
      : null;
    const diagnostics: RemoteCommandResult[] = [];

    try {
      for (const command of buildRemoteDiagnosticsCommands(projectPath)) {
        const startedAt = Date.now();
        const result = await manager.exec(command.command, {
          timeoutMs: 20_000,
          noTrim: true,
        });
        diagnostics.push({
          label: command.label,
          command: command.command,
          code: result.code,
          elapsedMs: Date.now() - startedAt,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      }
    } finally {
      manager.disconnect();
    }

    return {
      host: `${config.user}@${config.host}:${config.port}`,
      projectPath,
      commands: diagnostics,
    };
  } catch (error) {
    return {
      host: "unavailable",
      projectPath: remoteProjectName ?? null,
      commands: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildRemoteDiagnosticsCommands(
  projectPath: string | null
): Array<{ label: string; command: string }> {
  const commands: Array<{ label: string; command: string }> = [
    { label: "pwd", command: "pwd" },
    { label: "ntm status", command: "ntm status || true" },
  ];

  if (!projectPath) {
    return commands;
  }

  commands.splice(
    1,
    0,
    {
      label: "git status --short",
      command: `if test -d ${shellQuote(projectPath)}; then cd ${shellQuote(projectPath)} && git status --short || true; else echo "__missing_project__"; fi`,
    },
    {
      label: "br list --all",
      command: `if test -d ${shellQuote(projectPath)}; then cd ${shellQuote(projectPath)} && br list --all || true; else echo "__missing_project__"; fi`,
    }
  );

  return commands;
}

const SSH_YAML_PATH = join(homedir(), ".flywheel", "ssh.yaml");

export function hasSshConfig(): boolean {
  return existsSync(SSH_YAML_PATH);
}

export function skipIfNoSsh(): void {
  // No-op: use describe.skipIf()/describe.skip patterns in Vitest v4.
}

export function assertSshConfigured(): void {
  if (!hasSshConfig()) {
    throw new Error(
      `VPS E2E tests require ~/.flywheel/ssh.yaml.\n` +
        `Run: flywheel settings ssh\n` +
        `Or set FLYWHEEL_TEST_E2E=0 to skip VPS tests.`
    );
  }
}

export function getTestProject(): string {
  return process.env.FLYWHEEL_TEST_PROJECT ?? `flywheel-e2e-${Date.now().toString(36)}`;
}

export async function cleanupTestProject(projectName: string): Promise<void> {
  if (!hasSshConfig()) return;

  try {
    const config = loadSSHConfig();
    const manager = new SSHManager();
    await manager.connect();
    try {
      const projectPath = `${config.remoteRepoRoot}/${projectName}`;
      await manager.exec(`rm -rf ${shellQuote(projectPath)}`);
      console.log(`[E2E] cleanup: removed ${projectPath}`);
    } finally {
      manager.disconnect();
    }
  } catch (err) {
    console.warn(`[E2E] cleanup warning: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function assertSuccess(result: E2EResult, message?: string): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${message ?? "Command"} failed (exit ${result.exitCode}):\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  }
}

export function assertFailure(result: E2EResult, message?: string): void {
  if (result.exitCode === 0) {
    throw new Error(
      `${message ?? "Command"} unexpectedly succeeded:\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  }
}
