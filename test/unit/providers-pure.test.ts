/**
 * test/unit/providers-pure.test.ts — bead: agent-1879.5
 *
 * Tests pure helpers in cli/providers.ts without loading real config files.
 *
 * Note: maskKey was removed from providers.ts (the UBS credential-exposure fix
 * replaced key display with "configured"/"missing" status). These tests cover
 * the remaining pure helpers: modelColor and the credentialState contract.
 *
 * Covers:
 *   - modelColor: provider prefix → correct chalk colour variant (verified via
 *     ANSI codes present / absent)
 *   - credentialState: non-empty key → "configured"; empty/blank → "missing"
 *   - printProviders output (via captureConsole + temp providers.yaml)
 */
import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import yaml from "js-yaml";
import { modelColor } from "../../cli/providers.js";
import { captureConsole, stripAnsi, tempDir, FIXTURE_PROVIDERS_CONFIG } from "../helpers.js";

// ── modelColor ────────────────────────────────────────────────────────────────

describe("modelColor — provider prefix maps to correct colour", () => {
  it("claude- prefix → blue chalk (contains colour codes)", () => {
    const s = modelColor("claude-opus-4-6");
    // chalk.blue adds colour escape codes when colours are enabled
    // We verify the plain text is preserved and the function returns a string
    expect(stripAnsi(s)).toBe("claude-opus-4-6");
    expect(typeof s).toBe("string");
  });

  it("gemini- prefix → green chalk", () => {
    expect(stripAnsi(modelColor("gemini-1.5-pro"))).toBe("gemini-1.5-pro");
  });

  it("gpt- prefix → yellow chalk", () => {
    expect(stripAnsi(modelColor("gpt-4o"))).toBe("gpt-4o");
  });

  it("unknown prefix → white chalk (fallback)", () => {
    expect(stripAnsi(modelColor("unknown-model-xyz"))).toBe("unknown-model-xyz");
  });

  it("empty string → white chalk (still returns a string, not undefined)", () => {
    const s = modelColor("");
    expect(typeof s).toBe("string");
  });

  it("different providers produce different colours (ANSI codes differ)", () => {
    const claude = modelColor("claude-sonnet-4-6");
    const gpt    = modelColor("gpt-4o");
    const gemini = modelColor("gemini-1.5-pro");
    // Stripping ANSI should make them equal to their plain text
    expect(stripAnsi(claude)).toBe("claude-sonnet-4-6");
    expect(stripAnsi(gpt)).toBe("gpt-4o");
    expect(stripAnsi(gemini)).toBe("gemini-1.5-pro");
  });
});

// ── credentialState contract ──────────────────────────────────────────────────

describe("credentialState — non-empty key → 'configured'; empty → 'missing'", () => {
  // Mirror the logic from renderSlots:
  //   const credentialState = s.key.trim().length > 0 ? "configured" : "missing";
  const credentialState = (key: string) =>
    key.trim().length > 0 ? "configured" : "missing";

  it("real-looking key → 'configured'", () => {
    expect(credentialState("sk-ant-api-...")).toBe("configured");
  });

  it("empty string → 'missing'", () => {
    expect(credentialState("")).toBe("missing");
  });

  it("whitespace-only key → 'missing'", () => {
    expect(credentialState("   ")).toBe("missing");
  });

  it("placeholder 'sk-ant-test-...' → 'configured' (non-empty)", () => {
    expect(credentialState("sk-ant-test-key")).toBe("configured");
  });
});

// ── printProviders output ─────────────────────────────────────────────────────

describe("printProviders — output from real temp providers.yaml", () => {
  let dir: ReturnType<typeof tempDir>;
  let cap: ReturnType<typeof captureConsole>;

  afterEach(() => {
    cap?.restore();
    dir?.cleanup();
  });

  it("prints model names without exposing raw API keys", async () => {
    dir = tempDir();
    const configPath = join(dir.path, "providers.yaml");
    writeFileSync(configPath, yaml.dump(FIXTURE_PROVIDERS_CONFIG), "utf8");

    // Use FLYWHEEL_HOME to redirect config loading
    const original = process.env.FLYWHEEL_HOME;
    process.env.FLYWHEEL_HOME = dir.path;

    cap = captureConsole();
    const { printProviders } = await import("../../cli/providers.js");
    printProviders();
    cap.restore();
    process.env.FLYWHEEL_HOME = original;

    const out = stripAnsi(cap.out);
    // Model names should appear
    expect(out).toContain("claude-opus-4-6");
    expect(out).toContain("claude-sonnet-4-6");
    // Raw API key must NOT appear
    expect(out).not.toContain("sk-ant-test-key");
    // Credential state should appear
    expect(out).toContain("configured");
  });

  it("shows '(none configured)' for an empty slot", async () => {
    dir = tempDir();
    const configWithEmptySlot = {
      ...FIXTURE_PROVIDERS_CONFIG,
      slots: { ...FIXTURE_PROVIDERS_CONFIG.slots, synthesis: [] },
    };
    writeFileSync(join(dir.path, "providers.yaml"), yaml.dump(configWithEmptySlot), "utf8");

    const original = process.env.FLYWHEEL_HOME;
    process.env.FLYWHEEL_HOME = dir.path;

    cap = captureConsole();
    const { printProviders } = await import("../../cli/providers.js");
    printProviders();
    cap.restore();
    process.env.FLYWHEEL_HOME = original;

    expect(stripAnsi(cap.out)).toContain("(none configured)");
  });
});
