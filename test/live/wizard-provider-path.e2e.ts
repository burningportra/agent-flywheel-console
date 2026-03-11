/**
 * test/live/wizard-provider-path.e2e.ts — bead: agent-flywheel-console-3qw.7.2
 *
 * Real-provider wizard contract:
 *   - isolated FLYWHEEL_HOME with copied ssh.yaml + providers.yaml
 *   - real `flywheel new <idea> --fast --push-artifacts`
 *   - local + remote artifact assertions
 *   - local SQLite wizard_runs + api_calls evidence
 *   - redacted manifest for post-mortem debugging
 *
 * This suite is intentionally gated:
 *   FLYWHEEL_TEST_LIVE=1 FLYWHEEL_TEST_E2E=1 npx vitest run test/live/wizard-provider-path.e2e.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import yaml from "js-yaml";

import { initDb, StateManager, type ApiCall, type WizardRun } from "../../cli/state.js";
import { loadSSHConfig, SSHManager } from "../../cli/ssh.js";
import { shellQuote } from "../../cli/utils.js";
import { tempDir, type TempDir } from "../helpers.js";
import { hasSshConfig, runFlywheelWithDiagnostics } from "../e2e/setup.js";

interface TestWorkspace {
  temp: TempDir;
  cwd: string;
  flywheelHome: string;
  stateDbPath: string;
  sshConfigPath: string;
  env: Record<string, string>;
}

interface TranscriptEntry {
  at: string;
  step: string;
  detail: string;
}

interface ManifestSummary {
  createdAt: string;
  bead: string;
  projectName: string;
  runId: string | null;
  command: string[];
  localArtifacts?: {
    planPath: string;
    logPath: string;
    logLineCount: number;
    steps: string[];
  };
  remoteArtifacts?: {
    projectPath: string;
    planPath: string;
    logPath: string;
  };
  state?: {
    wizardRunStatus: string;
    apiCallCount: number;
    totalCostUsd: number;
  };
  outputPreview: {
    stdout: string;
    stderr: string;
  };
  transcript: TranscriptEntry[];
}

interface JsonLogEntry {
  step?: string;
}

interface ProvidersConfigLike {
  slots?: Record<string, Array<{ model?: string; key?: string }>>;
}

const ARTIFACTS_ROOT = resolve("test-artifacts");
const sourceSshYaml = join(homedir(), ".flywheel", "ssh.yaml");
const sourceProvidersYaml =
  process.env.FLYWHEEL_PROVIDERS_YAML ?? join(homedir(), ".flywheel", "providers.yaml");
const sourceProviders = loadProvidersConfigIfPresent(sourceProvidersYaml);
const liveSecrets = extractSecrets(sourceProviders);
const runLiveWizard =
  process.env.FLYWHEEL_TEST_LIVE === "1" &&
  process.env.FLYWHEEL_TEST_E2E === "1" &&
  hasSshConfig() &&
  hasUsableWizardProviders(sourceProviders);
const describeLiveWizard = runLiveWizard ? describe : describe.skip;

const projectName = `flywheel-live-wizard-${Date.now().toString(36)}`;
const idea = "Build a release cockpit that tracks operator gates, swarm health, and deploy readiness";
const command = ["new", idea, "--fast", "--push-artifacts"];
const transcript: TranscriptEntry[] = [];

let workspace: TestWorkspace | null = null;
let remoteProjectPath = "";
let manifestPath = "";
let wizardRunId: string | null = null;
let manifestDetails: Omit<
  ManifestSummary,
  "createdAt" | "bead" | "projectName" | "runId" | "command" | "outputPreview" | "transcript"
> = {};
let outputPreview = {
  stdout: "",
  stderr: "",
};

function currentWorkspace(): TestWorkspace {
  if (!workspace) {
    throw new Error("Live wizard workspace was not initialized.");
  }
  return workspace;
}

function nowIso(): string {
  return new Date().toISOString();
}

function record(step: string, detail: string): void {
  transcript.push({ at: nowIso(), step, detail });
}

function createWorkspace(name: string): TestWorkspace {
  const temp = tempDir();
  const flywheelHome = join(temp.path, ".flywheel");
  const cwd = join(temp.path, name);
  const stateDbPath = join(flywheelHome, "state.db");
  const sshConfigPath = join(flywheelHome, "ssh.yaml");

  mkdirSync(flywheelHome, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  writeFileSync(sshConfigPath, readFileSync(sourceSshYaml, "utf8"), "utf8");
  writeFileSync(
    join(flywheelHome, "providers.yaml"),
    readFileSync(sourceProvidersYaml, "utf8"),
    "utf8"
  );

  return {
    temp,
    cwd,
    flywheelHome,
    stateDbPath,
    sshConfigPath,
    env: {
      FLYWHEEL_HOME: flywheelHome,
      FLYWHEEL_STATE_DB: stateDbPath,
      FLYWHEEL_TEST_LIVE: "1",
      FLYWHEEL_TEST_E2E: "1",
    },
  };
}

function artifactsDir(runId: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const dir = join(ARTIFACTS_ROOT, date, "live-wizard", runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function sshExec(commandText: string, timeoutMs = 30_000): Promise<{
  stdout: string;
  stderr: string;
  code: number;
}> {
  const ssh = new SSHManager(currentWorkspace().sshConfigPath);
  await ssh.connect();
  try {
    const result = await ssh.exec(commandText, {
      timeoutMs,
      noTrim: true,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
    };
  } finally {
    ssh.disconnect();
  }
}

async function removeRemoteProject(): Promise<void> {
  if (!remoteProjectPath) {
    return;
  }

  const result = await sshExec(`rm -rf ${shellQuote(remoteProjectPath)}`, 30_000);
  if (result.code !== 0) {
    throw new Error(`Failed to remove remote test project:\n${result.stderr || result.stdout}`);
  }
}

async function readRemoteFile(path: string): Promise<string> {
  const result = await sshExec(`cat ${shellQuote(path)}`, 20_000);
  if (result.code !== 0) {
    throw new Error(`Failed to read remote file ${path}:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function extractOutputPath(stdout: string, label: string): string {
  const match = stdout.match(new RegExp(`${label}:\\s+(.+)$`, "mi"));
  if (!match?.[1]) {
    throw new Error(`Could not find "${label}" in output:\n${stdout}`);
  }
  return match[1].trim();
}

function parseJsonLog(path: string): JsonLogEntry[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonLogEntry);
}

function latestWizardRun(project: string): WizardRun | undefined {
  const db = initDb(currentWorkspace().stateDbPath);
  const state = new StateManager(db);
  try {
    return state.listWizardRuns().find((run) => run.project_name === project);
  } finally {
    db.close();
  }
}

function wizardApiCalls(runId: string): { calls: ApiCall[]; totalCostUsd: number } {
  const db = initDb(currentWorkspace().stateDbPath);
  const state = new StateManager(db);
  try {
    return {
      calls: state.getApiCalls(runId),
      totalCostUsd: state.getTotalCost(runId),
    };
  } finally {
    db.close();
  }
}

function summarizeOutput(output: string, maxLength = 1200): string {
  const trimmed = output.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 1)}…`;
}

function loadProvidersConfigIfPresent(path: string): ProvidersConfigLike | undefined {
  if (!existsSync(path)) {
    return undefined;
  }

  try {
    return yaml.load(readFileSync(path, "utf8")) as ProvidersConfigLike;
  } catch {
    return undefined;
  }
}

function hasUsableWizardProviders(config: ProvidersConfigLike | undefined): boolean {
  if (!config) {
    return false;
  }

  const planSlots = config.slots?.plan ?? [];
  const synthesisSlots = config.slots?.synthesis ?? [];

  const hasPlanSlot = planSlots.some(
    (slot) => typeof slot.model === "string" && hasUsableLiveKey(slot.key)
  );
  const hasSynthesisSlot = synthesisSlots.some(
    (slot) =>
      typeof slot.model === "string" &&
      slot.model.startsWith("claude-") &&
      hasUsableLiveKey(slot.key)
  );

  return hasPlanSlot && hasSynthesisSlot;
}

function hasUsableLiveKey(key: unknown): boolean {
  if (typeof key !== "string") {
    return false;
  }

  const trimmed = key.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const lower = trimmed.toLowerCase();
  return !(
    trimmed.includes("...") ||
    lower.includes("fake") ||
    lower.includes("example") ||
    lower.includes("your-")
  );
}

function extractSecrets(config: ProvidersConfigLike | undefined): string[] {
  if (!config) {
    return [];
  }

  const secrets: string[] = [];
  for (const slots of Object.values(config.slots ?? {})) {
    for (const slot of slots ?? []) {
      if (typeof slot.key === "string" && slot.key.length > 0) {
        secrets.push(slot.key);
      }
    }
  }
  return secrets;
}

function redactText(text: string): string {
  let redacted = text;
  for (const secret of liveSecrets) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }

  return redacted
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9._-]+/g, "sk-[REDACTED]")
    .replace(/AIza[0-9A-Za-z_-]+/g, "AIza[REDACTED]");
}

function writeManifest(): void {
  if (!manifestPath) {
    return;
  }

  const payload: ManifestSummary = {
    createdAt: nowIso(),
    bead: "agent-flywheel-console-3qw.7.2",
    projectName,
    runId: wizardRunId,
    command,
    outputPreview: {
      stdout: redactText(outputPreview.stdout),
      stderr: redactText(outputPreview.stderr),
    },
    transcript: transcript.map((entry) => ({
      ...entry,
      detail: redactText(entry.detail),
    })),
    ...manifestDetails,
  };

  const encoded = JSON.stringify(payload);
  expect(encoded.toLowerCase()).not.toContain("authorization");
  for (const secret of liveSecrets) {
    expect(encoded).not.toContain(secret);
  }

  writeFileSync(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

describeLiveWizard("live wizard provider path", () => {
  beforeAll(async () => {
    workspace = createWorkspace(projectName);
    const sshConfig = loadSSHConfig(workspace.sshConfigPath);
    remoteProjectPath = `${sshConfig.remoteRepoRoot.replace(/\/+$/, "")}/${projectName}`;
    manifestPath = join(artifactsDir(`project-${projectName}`), "manifest.json");

    record("workspace", `cwd=${workspace.cwd}`);
    await removeRemoteProject();
    record("remote-clean", remoteProjectPath);
  });

  afterAll(async () => {
    try {
      writeManifest();
    } finally {
      try {
        await removeRemoteProject();
      } finally {
        workspace?.temp.cleanup();
        workspace = null;
      }
    }
  });

  it(
    "runs the real fast wizard, uploads artifacts, and records SQLite evidence",
    async () => {
      const ws = currentWorkspace();
      const result = await runFlywheelWithDiagnostics(command, {
        cwd: ws.cwd,
        env: ws.env,
        timeout: 300_000,
        remoteDiagnostics: true,
        remoteProjectName: projectName,
      });

      outputPreview = {
        stdout: summarizeOutput(result.stdout),
        stderr: summarizeOutput(result.stderr),
      };
      record("wizard", `exit=${result.exitCode} duration=${result.durationMs}ms`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Wizard complete/i);

      const localPlanPath = extractOutputPath(result.stdout, "Plan");
      const localLogPath = extractOutputPath(result.stdout, "Log");
      const remotePlanPath = extractOutputPath(result.stdout, "VPS plan");
      const remoteLogPath = extractOutputPath(result.stdout, "VPS log");

      expect(existsSync(localPlanPath)).toBe(true);
      expect(existsSync(localLogPath)).toBe(true);

      const localPlan = readFileSync(localPlanPath, "utf8");
      const localLog = readFileSync(localLogPath, "utf8");
      const logEntries = parseJsonLog(localLogPath);
      const steps = [...new Set(logEntries.map((entry) => entry.step).filter(Boolean))].sort();

      expect(localPlan).toContain(`# Plan: ${idea}`);
      expect(localPlan).toContain("## Adversarial Risk Assessment");
      expect(localPlan).toContain("## Brilliant Enhancement Ideas");
      expect(logEntries.length).toBeGreaterThan(0);
      expect(steps).toEqual(expect.arrayContaining(["adversarial", "ideas-1", "synthesis-1"]));

      const remotePlan = await readRemoteFile(remotePlanPath);
      const remoteLog = await readRemoteFile(remoteLogPath);

      expect(remotePlan).toBe(localPlan);
      expect(remoteLog).toBe(localLog);
      expect(remoteLog.trim().split("\n").length).toBeGreaterThan(0);

      const wizardRun = latestWizardRun(projectName);
      expect(wizardRun).toBeTruthy();
      expect(wizardRun?.status).toBe("completed");
      expect(wizardRun?.plan_path).toBe(localPlanPath);

      wizardRunId = wizardRun?.id ?? null;
      expect(wizardRunId).toBeTruthy();

      const api = wizardApiCalls(wizardRunId ?? "");
      expect(api.calls.length).toBeGreaterThan(0);
      expect(api.calls.every((call) => call.phase === "plan")).toBe(true);
      expect(api.totalCostUsd).toBeGreaterThan(0);

      manifestPath = join(artifactsDir(wizardRunId ?? "unknown-run"), "manifest.json");
      manifestDetails = {
        localArtifacts: {
          planPath: localPlanPath,
          logPath: localLogPath,
          logLineCount: logEntries.length,
          steps,
        },
        remoteArtifacts: {
          projectPath: remoteProjectPath,
          planPath: remotePlanPath,
          logPath: remoteLogPath,
        },
        state: {
          wizardRunStatus: wizardRun?.status ?? "missing",
          apiCallCount: api.calls.length,
          totalCostUsd: api.totalCostUsd,
        },
      };

      writeManifest();
      expect(existsSync(manifestPath)).toBe(true);
    },
    300_000
  );
});
