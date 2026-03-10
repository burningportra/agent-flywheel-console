/**
 * test/live/providers-smoke.test.ts — bead: agent-flywheel-console-3qw.7.1
 *
 * Minimal live provider contract checks with real configured credentials.
 *
 * Scope:
 *   - Anthropic SDK request path (when a claude-* slot is configured)
 *   - OpenAI-compatible SDK request path (when a gpt-* / gemini-* slot is configured)
 *   - redacted transcript manifest written to test-artifacts/
 *   - token/cost values logged into the real SQLite state DB
 *
 * This suite is opt-in only:
 *   FLYWHEEL_TEST_LIVE=1 npx vitest run test/live/providers-smoke.test.ts
 *
 * Source providers config defaults to ~/.flywheel/providers.yaml but can be
 * overridden with FLYWHEEL_PROVIDERS_YAML for isolated local runs.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import yaml from "js-yaml";

import {
  computeCost,
  loadProvidersConfig,
  type ProviderSlot,
  type ProvidersConfig,
} from "../../cli/config.js";
import { initDb, StateManager } from "../../cli/state.js";
import { tempDir, type TempDir } from "../helpers.js";

interface LiveWorkspace {
  temp: TempDir;
  flywheelHome: string;
  stateDbPath: string;
}

interface ProviderSelection {
  slotName: string;
  slot: ProviderSlot;
}

interface SmokeResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

interface TranscriptEntry {
  at: string;
  provider: string;
  slotName: string;
  model: string;
  ok: boolean;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  responseLength: number;
  stateRunId: string;
  artifactPath?: string;
  error?: string;
}

const GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/";
const ARTIFACTS_ROOT = resolve("test-artifacts");
const sourceProvidersPath =
  process.env.FLYWHEEL_PROVIDERS_YAML ?? join(homedir(), ".flywheel", "providers.yaml");
const sourceProviders = loadSourceProviders(sourceProvidersPath);
const runLive = process.env.FLYWHEEL_TEST_LIVE === "1" && sourceProviders !== null;
const describeLive = runLive ? describe : describe.skip;

const anthropicSelection = sourceProviders
  ? findSlot(sourceProviders, (model) => model.startsWith("claude-"))
  : null;
const openAiCompatibleSelection = sourceProviders
  ? findSlot(sourceProviders, isOpenAiCompatibleModel)
  : null;
const transcript: TranscriptEntry[] = [];

let workspace: LiveWorkspace | null = null;
let manifestPath = "";
let previousFlywheelHome: string | undefined;
let previousStateDb: string | undefined;

function currentWorkspace(): LiveWorkspace {
  if (!workspace) {
    throw new Error("Live provider workspace was not initialized.");
  }
  return workspace;
}

function nowIso(): string {
  return new Date().toISOString();
}

function artifactDir(): string {
  const date = new Date().toISOString().slice(0, 10);
  const dir = join(ARTIFACTS_ROOT, date, "live");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function loadSourceProviders(path: string): ProvidersConfig | null {
  if (!existsSync(path)) {
    return null;
  }
  return yaml.load(readFileSync(path, "utf8")) as ProvidersConfig;
}

function createWorkspace(): LiveWorkspace {
  const temp = tempDir();
  const flywheelHome = join(temp.path, ".flywheel");
  const stateDbPath = join(flywheelHome, "state.db");

  mkdirSync(flywheelHome, { recursive: true });
  writeFileSync(join(flywheelHome, "providers.yaml"), readFileSync(sourceProvidersPath, "utf8"), "utf8");

  return {
    temp,
    flywheelHome,
    stateDbPath,
  };
}

function isOpenAiCompatibleModel(model: string): boolean {
  return (
    model.startsWith("gpt-") ||
    model.startsWith("gemini-")
  );
}

function findSlot(
  config: ProvidersConfig,
  predicate: (model: string) => boolean
): ProviderSelection | null {
  for (const [slotName, slots] of Object.entries(config.slots)) {
    for (const slot of slots ?? []) {
      if (predicate(slot.model)) {
        return { slotName, slot };
      }
    }
  }

  return null;
}

function redactSecrets(value: string, secrets: string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }

  return redacted
    .replace(/sk-[A-Za-z0-9._-]+/g, "sk-[REDACTED]")
    .replace(/AIza[0-9A-Za-z_-]+/g, "AIza[REDACTED]");
}

function record(entry: TranscriptEntry): void {
  transcript.push(entry);
}

function pricingCost(model: string, inputTokens: number, outputTokens: number): number {
  const config = loadProvidersConfig();
  return computeCost(
    model,
    { input: inputTokens, output: outputTokens },
    config.pricing
  );
}

function logApiCallToState(
  projectName: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number
): string {
  const state = new StateManager(initDb(currentWorkspace().stateDbPath));
  const runId = state.createFlywheelRun(projectName, "plan");
  state.logApiCall(
    runId,
    "plan",
    model,
    { input: inputTokens, output: outputTokens },
    costUsd
  );
  return runId;
}

function assertLoggedState(runId: string, model: string, costUsd: number): void {
  const state = new StateManager(initDb(currentWorkspace().stateDbPath));
  const calls = state.getApiCalls(runId);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.model).toBe(model);
  expect(calls[0]?.input_tokens).toBeGreaterThan(0);
  expect(calls[0]?.output_tokens).toBeGreaterThan(0);
  expect(state.getTotalCost(runId)).toBeCloseTo(costUsd, 8);
}

async function runAnthropicSmoke(selection: ProviderSelection): Promise<SmokeResult> {
  const startedAt = Date.now();
  const client = new Anthropic({ apiKey: selection.slot.key });
  const response = await client.messages.create({
    model: selection.slot.model,
    max_tokens: 16,
    system: "Respond concisely and follow the user's instruction exactly.",
    messages: [
      {
        role: "user",
        content: "Reply with exactly LIVE-SMOKE-OK and nothing else.",
      },
    ],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  return {
    text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    durationMs: Date.now() - startedAt,
  };
}

async function runOpenAiCompatibleSmoke(selection: ProviderSelection): Promise<SmokeResult> {
  const startedAt = Date.now();
  const client = new OpenAI({
    apiKey: selection.slot.key,
    ...(selection.slot.model.startsWith("gemini-") ? { baseURL: GEMINI_BASE_URL } : {}),
  });

  const response = await client.chat.completions.create({
    model: selection.slot.model,
    max_tokens: 16,
    messages: [
      {
        role: "system",
        content: "Respond concisely and follow the user's instruction exactly.",
      },
      {
        role: "user",
        content: "Reply with exactly LIVE-SMOKE-OK and nothing else.",
      },
    ],
  });

  return {
    text: response.choices[0]?.message?.content ?? "",
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
    durationMs: Date.now() - startedAt,
  };
}

async function executeSmoke(
  provider: "anthropic" | "openai-compatible",
  selection: ProviderSelection
): Promise<{ runId: string; result: SmokeResult; costUsd: number }> {
  try {
    const result =
      provider === "anthropic"
        ? await runAnthropicSmoke(selection)
        : await runOpenAiCompatibleSmoke(selection);
    const costUsd = pricingCost(
      selection.slot.model,
      result.inputTokens,
      result.outputTokens
    );
    const runId = logApiCallToState(
      `live-provider-smoke-${provider}`,
      selection.slot.model,
      result.inputTokens,
      result.outputTokens,
      costUsd
    );

    record({
      at: nowIso(),
      provider,
      slotName: selection.slotName,
      model: selection.slot.model,
      ok: true,
      durationMs: result.durationMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd,
      responseLength: result.text.length,
      stateRunId: runId,
      artifactPath: manifestPath,
    });

    return { runId, result, costUsd };
  } catch (error) {
    const sanitized = redactSecrets(
      error instanceof Error ? error.message : String(error),
      [selection.slot.key]
    );

    record({
      at: nowIso(),
      provider,
      slotName: selection.slotName,
      model: selection.slot.model,
      ok: false,
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      responseLength: 0,
      stateRunId: "",
      artifactPath: manifestPath,
      error: sanitized,
    });

    throw new Error(`${provider} smoke failed for ${selection.slot.model}: ${sanitized}`);
  }
}

describeLive("live provider smoke contracts", () => {
  beforeAll(() => {
    previousFlywheelHome = process.env.FLYWHEEL_HOME;
    previousStateDb = process.env.FLYWHEEL_STATE_DB;

    workspace = createWorkspace();
    process.env.FLYWHEEL_HOME = workspace.flywheelHome;
    process.env.FLYWHEEL_STATE_DB = workspace.stateDbPath;

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    manifestPath = join(artifactDir(), `providers-smoke-${stamp}.json`);
  });

  afterAll(() => {
    try {
      if (manifestPath) {
        writeFileSync(
          manifestPath,
          JSON.stringify(
            {
              createdAt: nowIso(),
              sourceProvidersPath,
              entries: transcript,
            },
            null,
            2
          ) + "\n",
          "utf8"
        );
      }
    } finally {
      if (previousFlywheelHome === undefined) {
        delete process.env.FLYWHEEL_HOME;
      } else {
        process.env.FLYWHEEL_HOME = previousFlywheelHome;
      }

      if (previousStateDb === undefined) {
        delete process.env.FLYWHEEL_STATE_DB;
      } else {
        process.env.FLYWHEEL_STATE_DB = previousStateDb;
      }

      workspace?.temp.cleanup();
      workspace = null;
    }
  });

  const itAnthropic = anthropicSelection ? it : it.skip;
  itAnthropic("makes a minimal live Anthropic call with redacted logging", async () => {
    const selection = anthropicSelection;
    if (!selection) {
      return;
    }

    const { runId, result, costUsd } = await executeSmoke("anthropic", selection);

    expect(result.text).toMatch(/LIVE-SMOKE-OK/i);
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(costUsd).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(transcript)).not.toContain(selection.slot.key);
    assertLoggedState(runId, selection.slot.model, costUsd);
  }, 60_000);

  const itOpenAi = openAiCompatibleSelection ? it : it.skip;
  itOpenAi("makes a minimal live OpenAI-compatible call with redacted logging", async () => {
    const selection = openAiCompatibleSelection;
    if (!selection) {
      return;
    }

    const { runId, result, costUsd } = await executeSmoke("openai-compatible", selection);

    expect(result.text).toMatch(/LIVE-SMOKE-OK/i);
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(costUsd).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(transcript)).not.toContain(selection.slot.key);
    assertLoggedState(runId, selection.slot.model, costUsd);
  }, 60_000);
});
