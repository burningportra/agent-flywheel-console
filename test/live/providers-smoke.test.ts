import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { beforeAll, describe, expect, it } from "vitest";
import yaml from "js-yaml";

import {
  computeCost,
  flywheelPath,
  loadProvidersConfig,
  type ProviderSlot,
  type ProvidersConfig,
} from "../../cli/config.js";

type ProviderFamily = "anthropic" | "openai" | "gemini";

interface ProviderCase {
  family: ProviderFamily;
  slotName: string;
  slot: ProviderSlot;
}

interface SmokeResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

interface TranscriptEntry {
  at: string;
  family: ProviderFamily;
  slotName: string;
  model: string;
  status: "ok" | "error";
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  contentPreview?: string;
  error?: string;
}

const GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/";
const LIVE_ENABLED = process.env.FLYWHEEL_TEST_LIVE === "1";
const PROVIDERS_PATH = process.env.FLYWHEEL_PROVIDERS_YAML ?? flywheelPath("providers.yaml");
const TRANSCRIPT_DIR = resolve(
  process.env.FLYWHEEL_TEST_ARTIFACTS_DIR ??
    join("test-artifacts", new Date().toISOString().slice(0, 10), "live-providers")
);
const PROMPT_SYSTEM = "Reply with exactly one short token: OK";
const PROMPT_USER = "Return OK.";
const REQUEST_TIMEOUT_MS = 60_000;

const providersConfig = loadProvidersConfigIfPresent();
const providerCases = providersConfig ? collectProviderCases(providersConfig) : [];
const describeLive =
  LIVE_ENABLED && providersConfig && providerCases.length > 0 ? describe : describe.skip;

describeLive("live providers smoke", () => {
  beforeAll(() => {
    console.log(
      `[LIVE][providers] using ${providerCases.length} provider family/families from ${PROVIDERS_PATH}`
    );
  });

  for (const providerCase of providerCases) {
    it(
      `${providerCase.family} responds to a minimal prompt and reports sane usage`,
      async () => {
        const startedAt = Date.now();

        try {
          const result = await callProvider(providerCase);
          const costUsd = computeCost(
            providerCase.slot.model,
            {
              input: result.inputTokens,
              output: result.outputTokens,
            },
            providersConfig!.pricing
          );

          expect(result.content.trim().length).toBeGreaterThan(0);
          expect(result.inputTokens).toBeGreaterThan(0);
          expect(result.outputTokens).toBeGreaterThan(0);
          expect(Number.isFinite(costUsd)).toBe(true);
          expect(costUsd).toBeGreaterThanOrEqual(0);

          const transcript: TranscriptEntry = {
            at: new Date().toISOString(),
            family: providerCase.family,
            slotName: providerCase.slotName,
            model: providerCase.slot.model,
            status: "ok",
            durationMs: result.durationMs,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            costUsd,
            contentPreview: summarizeText(result.content),
          };
          assertTranscriptIsRedacted(transcript, providerCase.slot.key);
          recordTranscript(transcript);
        } catch (error) {
          const sanitizedError = sanitizeError(
            error instanceof Error ? error.message : String(error),
            providerCase.slot.key
          );
          const transcript: TranscriptEntry = {
            at: new Date().toISOString(),
            family: providerCase.family,
            slotName: providerCase.slotName,
            model: providerCase.slot.model,
            status: "error",
            durationMs: Date.now() - startedAt,
            error: sanitizedError,
          };
          assertTranscriptIsRedacted(transcript, providerCase.slot.key);
          recordTranscript(transcript);
          throw new Error(
            `${providerCase.family} smoke failed for ${providerCase.slot.model}: ${sanitizedError}`
          );
        }
      },
      90_000
    );
  }
});

function loadProvidersConfigIfPresent(): ProvidersConfig | undefined {
  if (!LIVE_ENABLED || !existsSync(PROVIDERS_PATH)) {
    return undefined;
  }

  try {
    if (process.env.FLYWHEEL_PROVIDERS_YAML) {
      return yaml.load(readFileSync(PROVIDERS_PATH, "utf8")) as ProvidersConfig;
    }

    return loadProvidersConfig();
  } catch {
    return undefined;
  }
}

function collectProviderCases(config: ProvidersConfig): ProviderCase[] {
  const selected = new Set<ProviderFamily>();
  const cases: ProviderCase[] = [];

  for (const [slotName, slots] of Object.entries(config.slots)) {
    for (const slot of slots ?? []) {
      const family = providerFamilyForModel(slot.model);
      if (!family || selected.has(family) || !hasUsableLiveKey(slot.key)) {
        continue;
      }

      selected.add(family);
      cases.push({ family, slotName, slot });
    }
  }

  return cases;
}

function providerFamilyForModel(model: string): ProviderFamily | undefined {
  if (model.startsWith("claude-")) {
    return "anthropic";
  }

  if (model.startsWith("gpt-")) {
    return "openai";
  }

  if (model.startsWith("gemini-")) {
    return "gemini";
  }

  return undefined;
}

function hasUsableLiveKey(key: string): boolean {
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

async function callProvider(providerCase: ProviderCase): Promise<SmokeResult> {
  switch (providerCase.family) {
    case "anthropic":
      return await callAnthropic(providerCase.slot);
    case "openai":
      return await callOpenAiCompatible(providerCase.slot);
    case "gemini":
      return await callOpenAiCompatible(providerCase.slot, GEMINI_BASE_URL);
  }
}

async function callAnthropic(slot: ProviderSlot): Promise<SmokeResult> {
  const startedAt = Date.now();
  const client = new Anthropic({
    apiKey: slot.key,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 0,
  });
  const response = await client.messages.create({
    model: slot.model,
    max_tokens: 16,
    system: PROMPT_SYSTEM,
    messages: [{ role: "user", content: PROMPT_USER }],
  });

  const content = response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n")
    .trim();

  return {
    content,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    durationMs: Date.now() - startedAt,
  };
}

async function callOpenAiCompatible(
  slot: ProviderSlot,
  baseURL?: string
): Promise<SmokeResult> {
  const startedAt = Date.now();
  const client = new OpenAI({
    apiKey: slot.key,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 0,
    ...(baseURL ? { baseURL } : {}),
  });
  const response = await client.chat.completions.create({
    model: slot.model,
    messages: [
      { role: "system", content: PROMPT_SYSTEM },
      { role: "user", content: PROMPT_USER },
    ],
    max_tokens: 16,
  });

  const content = normalizeOpenAiContent(response.choices[0]?.message?.content);

  return {
    content,
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
    durationMs: Date.now() - startedAt,
  };
}

function normalizeOpenAiContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (
        part &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }

      return "";
    })
    .join("\n")
    .trim();
}

function summarizeText(text: string, maxLength = 80): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length <= maxLength
    ? singleLine
    : `${singleLine.slice(0, maxLength - 1)}…`;
}

function sanitizeError(message: string, secret: string): string {
  return message
    .replaceAll(secret, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
}

function assertTranscriptIsRedacted(entry: TranscriptEntry, secret: string): void {
  const encoded = JSON.stringify(entry);
  expect(encoded).not.toContain(secret);
  expect(encoded.toLowerCase()).not.toContain("authorization");
}

function recordTranscript(entry: TranscriptEntry): void {
  const encoded = JSON.stringify(entry);
  console.log(`[LIVE][providers] ${encoded}`);

  if (!(process.env.CI || process.env.FLYWHEEL_TEST_ARTIFACTS)) {
    return;
  }

  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  appendFileSync(join(TRANSCRIPT_DIR, "providers-smoke.jsonl"), `${encoded}\n`, "utf8");
}
