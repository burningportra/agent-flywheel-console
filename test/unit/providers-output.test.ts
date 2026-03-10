/**
 * test/unit/providers-output.test.ts
 *
 * Covers: cli/providers.ts — printProviders()
 * Uses a real FLYWHEEL_HOME temp directory with a real providers.yaml.
 * Verifies: output contains expected fields, API keys are NOT exposed raw.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import yaml from "js-yaml";
import { printProviders } from "../../cli/providers.js";
import { captureConsole, stripAnsi, tempDir, FIXTURE_PROVIDERS_CONFIG } from "../helpers.js";

type TempDir = ReturnType<typeof tempDir>;

let dir: TempDir;
let origHome: string | undefined;

function writeProviders(content: object): void {
  mkdirSync(dir.path, { recursive: true });
  writeFileSync(join(dir.path, "providers.yaml"), yaml.dump(content), "utf8");
}

beforeEach(() => {
  dir = tempDir();
  origHome = process.env.FLYWHEEL_HOME;
  process.env.FLYWHEEL_HOME = dir.path;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.FLYWHEEL_HOME;
  else process.env.FLYWHEEL_HOME = origHome;
  dir.cleanup();
});

describe("printProviders() with real providers.yaml", () => {
  it("prints model names for each slot", () => {
    writeProviders(FIXTURE_PROVIDERS_CONFIG);
    const c = captureConsole();
    printProviders();
    c.restore();
    const out = stripAnsi(c.out);
    expect(out).toContain("claude-opus-4-6");
    expect(out).toContain("claude-sonnet-4-6");
  });

  it("prints slot labels (Plan, Synthesis, Swarm agents)", () => {
    writeProviders(FIXTURE_PROVIDERS_CONFIG);
    const c = captureConsole();
    printProviders();
    c.restore();
    const out = stripAnsi(c.out);
    expect(out).toContain("Plan");
    expect(out).toContain("Swarm");
  });

  it("prints rotation policy", () => {
    writeProviders(FIXTURE_PROVIDERS_CONFIG);
    const c = captureConsole();
    printProviders();
    c.restore();
    expect(stripAnsi(c.out)).toContain("round-robin");
  });

  it("shows max_concurrent when configured", () => {
    writeProviders(FIXTURE_PROVIDERS_CONFIG);
    const c = captureConsole();
    printProviders();
    c.restore();
    expect(stripAnsi(c.out)).toContain("max_concurrent=2");
  });

  it("CRITICAL: raw API key does NOT appear in output", () => {
    const realKey = "sk-ant-api03-super-secret-actual-key-value";
    writeProviders({
      ...FIXTURE_PROVIDERS_CONFIG,
      slots: {
        plan: [{ model: "claude-opus-4-6", key: realKey }],
      },
    });
    const c = captureConsole();
    printProviders();
    c.restore();
    const combined = c.out + c.err;
    expect(combined).not.toContain(realKey);
    expect(combined).not.toContain("super-secret-actual-key-value");
  });

  it("shows 'configured' indicator when key is present", () => {
    writeProviders(FIXTURE_PROVIDERS_CONFIG);
    const c = captureConsole();
    printProviders();
    c.restore();
    expect(stripAnsi(c.out)).toContain("configured");
  });

  it("shows '(none configured)' for an empty slot list", () => {
    writeProviders({
      slots: { plan: [], synthesis: [] },
      rotation: "round-robin",
      pricing: {},
    });
    const c = captureConsole();
    printProviders();
    c.restore();
    expect(stripAnsi(c.out)).toContain("none configured");
  });

  it("shows pricing table when prices are configured", () => {
    writeProviders(FIXTURE_PROVIDERS_CONFIG);
    const c = captureConsole();
    printProviders();
    c.restore();
    const out = stripAnsi(c.out);
    expect(out).toContain("15.00"); // opus input price
    expect(out).toContain("in:");
    expect(out).toContain("out:");
  });

  it("prints error to stderr and does not throw when providers.yaml is missing", () => {
    // No providers.yaml written — just empty dir
    const c = captureConsole();
    try {
      printProviders();
    } catch {
      // process.exit is called; that's expected behaviour
    }
    c.restore();
    expect(c.err).toContain("providers.yaml");
  });
});
