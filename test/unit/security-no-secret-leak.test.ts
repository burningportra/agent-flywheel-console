/**
 * test/unit/security-no-secret-leak.test.ts
 *
 * Security regression tests: no CLI command must expose raw API keys in output.
 * Uses a real FLYWHEEL_HOME with a providers.yaml containing a known fake key.
 * Asserts the known key string does NOT appear anywhere in stdout/stderr.
 *
 * No network, no SSH. Pure output inspection.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import yaml from "js-yaml";
import { printProviders } from "../../cli/providers.js";
import { captureConsole, tempDir } from "../helpers.js";

type TempDir = ReturnType<typeof tempDir>;

// A realistic-looking fake API key — unique enough to not appear by accident
const FAKE_KEY = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE-SECRETKEYVALUE-99999-aa1bb2cc3dd4";
const FAKE_OPENAI_KEY = "sk-openai-FAKESECRETAPIKEY-openai-999-zzzzzz";
const FAKE_GEMINI_KEY = "AIzaFAKEFAKEFAKEFAKEFAKEkeyvalueGemini12345";

let dir: TempDir;
let origHome: string | undefined;

function writeProviders(slots: object): void {
  mkdirSync(dir.path, { recursive: true });
  writeFileSync(
    join(dir.path, "providers.yaml"),
    yaml.dump({
      slots,
      rotation: "round-robin",
      pricing: {
        "claude-opus-4-6": { input_per_mtok: 15.0, output_per_mtok: 75.0 },
      },
    }),
    "utf8"
  );
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

describe("flywheel providers — key secrecy", () => {
  it("does not leak an Anthropic (claude-*) API key", () => {
    writeProviders({
      plan: [{ model: "claude-opus-4-6", key: FAKE_KEY }],
    });
    const c = captureConsole();
    try { printProviders(); } catch { /* process.exit */ }
    c.restore();
    const combined = c.out + c.err;
    expect(combined).not.toContain(FAKE_KEY);
    expect(combined).not.toContain("SECRETKEYVALUE");
    expect(combined).not.toContain("FAKEFAKEFAKEFAKE");
  });

  it("does not leak an OpenAI (gpt-*) API key", () => {
    writeProviders({
      plan: [{ model: "gpt-4o", key: FAKE_OPENAI_KEY }],
    });
    const c = captureConsole();
    try { printProviders(); } catch { /* process.exit */ }
    c.restore();
    const combined = c.out + c.err;
    expect(combined).not.toContain(FAKE_OPENAI_KEY);
    expect(combined).not.toContain("FAKESECRETAPIKEY");
  });

  it("does not leak a Gemini API key", () => {
    writeProviders({
      plan: [{ model: "gemini-1.5-pro", key: FAKE_GEMINI_KEY }],
    });
    const c = captureConsole();
    try { printProviders(); } catch { /* process.exit */ }
    c.restore();
    const combined = c.out + c.err;
    expect(combined).not.toContain(FAKE_GEMINI_KEY);
    expect(combined).not.toContain("FAKEFAKEFAKEFAKEFAKEkeyvalueGemini");
  });

  it("does not leak keys from multiple slots", () => {
    writeProviders({
      plan:       [{ model: "claude-opus-4-6", key: FAKE_KEY }],
      swarm:      [{ model: "gpt-4o",          key: FAKE_OPENAI_KEY }],
      synthesis:  [{ model: "gemini-1.5-pro",  key: FAKE_GEMINI_KEY }],
    });
    const c = captureConsole();
    try { printProviders(); } catch { /* process.exit */ }
    c.restore();
    const combined = c.out + c.err;
    expect(combined).not.toContain(FAKE_KEY);
    expect(combined).not.toContain(FAKE_OPENAI_KEY);
    expect(combined).not.toContain(FAKE_GEMINI_KEY);
  });

  it("shows 'configured' indicator (so users know the key is present) without revealing it", () => {
    writeProviders({
      plan: [{ model: "claude-opus-4-6", key: FAKE_KEY }],
    });
    const c = captureConsole();
    try { printProviders(); } catch { /* process.exit */ }
    c.restore();
    // Must show SOMETHING to indicate key presence
    expect(c.out).toContain("configured");
    // Must NOT reveal key material
    expect(c.out).not.toContain(FAKE_KEY);
  });

  it("does not leak a key even when key is very short (≤8 chars)", () => {
    const shortKey = "sk-12345";
    writeProviders({
      plan: [{ model: "claude-opus-4-6", key: shortKey }],
    });
    const c = captureConsole();
    try { printProviders(); } catch { /* process.exit */ }
    c.restore();
    // The short key should not appear in full — credential state only
    const combined = c.out + c.err;
    expect(combined).not.toContain(shortKey);
  });
});
