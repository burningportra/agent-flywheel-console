import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import yaml from "js-yaml";

import { initDb, StateManager } from "../../cli/state.js";
import { tempDir } from "../helpers.js";
import { runFlywheel, type E2EResult } from "../e2e/setup.js";

interface ProvidersConfigLike {
  slots?: Record<string, Array<{ model?: string; key?: string }>>;
}

interface TranscriptManifest {
  generatedAt: string;
  projectName: string;
  providersPath: string;
  command: string[];
  exitCode: number;
  durationMs: number;
  costLine?: string;
  planPath?: string;
  logPath?: string;
  stateDbPath: string;
  wizardRun?: {
    id: string;
    status: string;
    planPath: string | null;
    costCalls: number;
  };
  outputPreview: {
    stdout: string;
    stderr: string;
  };
}

const LIVE_ENABLED = process.env.FLYWHEEL_TEST_LIVE === "1";
const SOURCE_PROVIDERS_PATH =
  process.env.FLYWHEEL_PROVIDERS_YAML ?? join(homedir(), ".flywheel", "providers.yaml");
const ARTIFACTS_DIR = resolve(
  process.env.FLYWHEEL_TEST_ARTIFACTS_DIR ??
    join("test-artifacts", new Date().toISOString().slice(0, 10), "live-wizard")
);

const sourceProvidersConfig = loadProvidersConfigIfPresent(SOURCE_PROVIDERS_PATH);
const hasUsableLiveConfig =
  LIVE_ENABLED &&
  Boolean(sourceProvidersConfig) &&
  hasUsableWizardProviders(sourceProvidersConfig!);
const describeLive = hasUsableLiveConfig ? describe : describe.skip;

describeLive("live wizard provider path", () => {
  beforeAll(() => {
    console.log(`[LIVE][wizard] using providers from ${SOURCE_PROVIDERS_PATH}`);
  });

  it(
    "runs flywheel new --fast with isolated config and records redacted artifacts",
    () => {
      const dir = tempDir();
      const flywheelHome = join(dir.path, "flywheel-home");
      const projectName = `live-wizard-${Date.now().toString(36)}`;
      const workspaceDir = join(dir.path, projectName);
      const stateDbPath = join(flywheelHome, "state.db");
      mkdirSync(flywheelHome, { recursive: true });
      mkdirSync(workspaceDir, { recursive: true });
      copyFileSync(SOURCE_PROVIDERS_PATH, join(flywheelHome, "providers.yaml"));

      const idea = "Build a minimal HTTP health-check endpoint with request logging";
      const args = ["new", idea, "--fast"];

      const result = runFlywheel(args, {
        cwd: workspaceDir,
        timeout: 240_000,
        env: {
          FLYWHEEL_HOME: flywheelHome,
          FLYWHEEL_STATE_DB: stateDbPath,
          FLYWHEEL_TEST_LIVE: "1",
        },
      });

      const redactedResult = redactResult(result, SOURCE_PROVIDERS_PATH);

      try {
        expect(result.exitCode).toBe(0);
        expect(redactedResult.stdout).toContain("Wizard complete");

        const planPath = extractOutputPath(redactedResult.stdout, "Plan");
        const logPath = extractOutputPath(redactedResult.stdout, "Log");

        expect(planPath).toBeTruthy();
        expect(logPath).toBeTruthy();
        expect(planPath && existsSync(planPath)).toBe(true);
        expect(logPath && existsSync(logPath)).toBe(true);

        if (!planPath || !logPath) {
          throw new Error("Wizard output paths were not reported.");
        }

        const plan = readFileSync(planPath, "utf8");
        const logLines = readFileSync(logPath, "utf8").trim().split("\n");

        expect(plan).toContain("# Plan:");
        expect(plan).toContain("## Adversarial Risk Assessment");
        expect(plan).toContain("## Brilliant Enhancement Ideas");
        expect(logLines.length).toBeGreaterThan(0);
        for (const line of logLines) {
          expect(() => JSON.parse(line)).not.toThrow();
        }

        const db = initDb(stateDbPath);
        const state = new StateManager(db);
        const wizardRun = state.listWizardRuns()[0];
        const apiCalls = wizardRun
          ? state.getApiCalls(wizardRun.id)
          : [];
        db.close();

        expect(wizardRun).toBeTruthy();
        expect(wizardRun?.status).toBe("completed");
        expect(wizardRun?.plan_path).toBe(planPath);
        expect(apiCalls.length).toBeGreaterThan(0);
        expect(apiCalls.every((call) => call.cost_usd >= 0)).toBe(true);

        const manifest: TranscriptManifest = {
          generatedAt: new Date().toISOString(),
          projectName,
          providersPath: SOURCE_PROVIDERS_PATH,
          command: args,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          costLine: extractCostLine(redactedResult.stdout),
          planPath,
          logPath,
          stateDbPath,
          wizardRun: wizardRun
            ? {
                id: wizardRun.id,
                status: wizardRun.status,
                planPath: wizardRun.plan_path,
                costCalls: apiCalls.length,
              }
            : undefined,
          outputPreview: {
            stdout: summarizeOutput(redactedResult.stdout),
            stderr: summarizeOutput(redactedResult.stderr),
          },
        };
        assertManifestIsRedacted(manifest, SOURCE_PROVIDERS_PATH);
        writeManifest(manifest);
      } finally {
        dir.cleanup();
      }
    },
    300_000
  );
});

function loadProvidersConfigIfPresent(path: string): ProvidersConfigLike | undefined {
  if (!LIVE_ENABLED || !existsSync(path)) {
    return undefined;
  }

  try {
    return yaml.load(readFileSync(path, "utf8")) as ProvidersConfigLike;
  } catch {
    return undefined;
  }
}

function hasUsableWizardProviders(config: ProvidersConfigLike): boolean {
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

function extractOutputPath(stdout: string, label: "Plan" | "Log"): string | undefined {
  return stdout.match(new RegExp(`${label}:\\s+(.+)`))?.[1]?.trim();
}

function extractCostLine(stdout: string): string | undefined {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("Cost:"));
}

function redactResult(result: E2EResult, providersPath: string): E2EResult {
  const secrets = extractSecrets(providersPath);
  return {
    ...result,
    stdout: redactText(result.stdout, secrets),
    stderr: redactText(result.stderr, secrets),
    output: redactText(result.output, secrets),
  };
}

function extractSecrets(providersPath: string): string[] {
  if (!existsSync(providersPath)) {
    return [];
  }

  try {
    const parsed = yaml.load(readFileSync(providersPath, "utf8")) as ProvidersConfigLike;
    const secrets: string[] = [];
    for (const slots of Object.values(parsed.slots ?? {})) {
      for (const slot of slots ?? []) {
        if (typeof slot.key === "string" && slot.key.length > 0) {
          secrets.push(slot.key);
        }
      }
    }
    return secrets;
  } catch {
    return [];
  }
}

function redactText(text: string, secrets: string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
}

function summarizeOutput(output: string, maxLength = 1200): string {
  const trimmed = output.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 1)}…`;
}

function assertManifestIsRedacted(manifest: TranscriptManifest, providersPath: string): void {
  const encoded = JSON.stringify(manifest);
  expect(encoded.toLowerCase()).not.toContain("authorization");

  for (const secret of extractSecrets(providersPath)) {
    expect(encoded).not.toContain(secret);
  }
}

function writeManifest(manifest: TranscriptManifest): void {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const fileName = `${manifest.projectName}.json`;
  writeFileSync(join(ARTIFACTS_DIR, fileName), JSON.stringify(manifest, null, 2), "utf8");

  const stat = statSync(join(ARTIFACTS_DIR, fileName));
  expect(stat.size).toBeGreaterThan(0);
}
