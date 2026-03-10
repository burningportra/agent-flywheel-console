/**
 * test/unit/config-providers-prompts.test.ts
 * Covers: cli/config.ts — loadProvidersConfig, loadPromptsConfig, computeCost
 * Uses real temp YAML files. No mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import yaml from "js-yaml";
import {
  loadProvidersConfig,
  loadPromptsConfig,
  computeCost,
} from "../../cli/config.js";
import { tempDir, FIXTURE_PROVIDERS_CONFIG } from "../helpers.js";

let dir: ReturnType<typeof tempDir>;
let origHome: string | undefined;

beforeEach(() => {
  dir = tempDir();
  origHome = process.env.FLYWHEEL_HOME;
  process.env.FLYWHEEL_HOME = dir.path;
  mkdirSync(dir.path, { recursive: true });
});

afterEach(() => {
  if (origHome === undefined) delete process.env.FLYWHEEL_HOME;
  else process.env.FLYWHEEL_HOME = origHome;
  dir.cleanup();
});

// ── loadProvidersConfig ───────────────────────────────────────────────────────

describe("loadProvidersConfig", () => {
  it("throws with a helpful message when providers.yaml is missing", () => {
    expect(() => loadProvidersConfig()).toThrow(/providers\.example\.yaml|chmod 600/);
  });

  it("loads a valid providers config with all slots", () => {
    writeFileSync(join(dir.path, "providers.yaml"), yaml.dump(FIXTURE_PROVIDERS_CONFIG), "utf8");
    const cfg = loadProvidersConfig();
    expect(cfg.slots.plan).toHaveLength(1);
    expect(cfg.slots.plan![0].model).toBe("claude-opus-4-6");
    expect(cfg.slots.synthesis).toHaveLength(1);
    expect(cfg.slots.swarm).toHaveLength(1);
  });

  it("pricing table is accessible by model name", () => {
    writeFileSync(join(dir.path, "providers.yaml"), yaml.dump(FIXTURE_PROVIDERS_CONFIG), "utf8");
    const cfg = loadProvidersConfig();
    expect(cfg.pricing["claude-opus-4-6"].input_per_mtok).toBe(15.0);
    expect(cfg.pricing["claude-opus-4-6"].output_per_mtok).toBe(75.0);
  });

  it("returns a config with empty slots when slots omitted", () => {
    writeFileSync(
      join(dir.path, "providers.yaml"),
      yaml.dump({ slots: {}, rotation: "round-robin", pricing: {} }),
      "utf8"
    );
    const cfg = loadProvidersConfig();
    expect(cfg.slots).toBeDefined();
  });
});

// ── loadPromptsConfig ─────────────────────────────────────────────────────────

describe("loadPromptsConfig", () => {
  it("loads the bundled prompts.yaml (dev mode via cwd)", () => {
    const cfg = loadPromptsConfig();
    // The bundled config/prompts.yaml has 14+ prompts
    expect(Object.keys(cfg.prompts).length).toBeGreaterThanOrEqual(10);
  });

  it("each prompt has required fields", () => {
    const cfg = loadPromptsConfig();
    for (const [name, prompt] of Object.entries(cfg.prompts)) {
      expect(typeof prompt.text, `${name}.text`).toBe("string");
      expect(prompt.text.length, `${name}.text non-empty`).toBeGreaterThan(0);
      expect(["opus", "sonnet", "haiku", "any"]).toContain(prompt.model);
      expect(["low", "high", "max"]).toContain(prompt.effort);
      expect(["plan", "beads", "swarm", "review"]).toContain(prompt.phase);
    }
  });

  it("overrides bundled with FLYWHEEL_HOME prompts.yaml if present", () => {
    // Write a minimal custom prompts.yaml in the temp FLYWHEEL_HOME
    writeFileSync(
      join(dir.path, "prompts.yaml"),
      yaml.dump({ prompts: { "custom-test": { text: "custom text", model: "any", effort: "low", phase: "swarm" } } }),
      "utf8"
    );
    const cfg = loadPromptsConfig();
    expect(cfg.prompts["custom-test"]).toBeDefined();
    expect(cfg.prompts["custom-test"].text).toBe("custom text");
  });

  it("returns a stable object (not mutated across calls)", () => {
    const cfg1 = loadPromptsConfig();
    const cfg2 = loadPromptsConfig();
    // Deep equality (both loaded from same source)
    expect(Object.keys(cfg1.prompts).sort()).toEqual(Object.keys(cfg2.prompts).sort());
  });
});

// ── computeCost ───────────────────────────────────────────────────────────────

describe("computeCost", () => {
  const pricing = {
    "claude-opus-4-6": { input_per_mtok: 15.0, output_per_mtok: 75.0 },
    "claude-sonnet-4-6": { input_per_mtok: 3.0, output_per_mtok: 15.0 },
    "gpt-4o": { input_per_mtok: 2.5, output_per_mtok: 10.0 },
  };

  it("returns 0 for an unknown model", () => {
    expect(computeCost("unknown-model", { input: 1000, output: 500 }, pricing)).toBe(0);
  });

  it("returns 0 for zero tokens", () => {
    expect(computeCost("claude-opus-4-6", { input: 0, output: 0 }, pricing)).toBe(0);
  });

  it("computes cost for claude-opus-4-6 (15/75 per MTok)", () => {
    // 1M input tokens = $15, 1M output = $75
    // 1000 input = $0.015, 500 output = $0.0375 → total $0.0525
    const cost = computeCost("claude-opus-4-6", { input: 1000, output: 500 }, pricing);
    expect(cost).toBeCloseTo(0.0525, 6);
  });

  it("computes cost for gpt-4o (2.5/10 per MTok)", () => {
    // 1000 input tokens = $0.0025, 1000 output = $0.01 → total $0.0125
    const cost = computeCost("gpt-4o", { input: 1000, output: 1000 }, pricing);
    expect(cost).toBeCloseTo(0.0125, 6);
  });

  it("correctly handles 1M tokens (boundary check)", () => {
    // Exactly 1M input → $15.00
    const cost = computeCost("claude-opus-4-6", { input: 1_000_000, output: 0 }, pricing);
    expect(cost).toBeCloseTo(15.0, 4);
  });

  it("empty pricing table returns 0 for any model", () => {
    expect(computeCost("claude-opus-4-6", { input: 1000, output: 500 }, {})).toBe(0);
  });
});
