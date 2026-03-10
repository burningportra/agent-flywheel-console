// Config loader — reads flywheel config files and bundled prompts.yaml
// Never commits API keys. providers.yaml must be chmod 600.

import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";

// ─── SSH config ───────────────────────────────────────────────────────────────

export interface SshConfig {
  host: string;
  user: string;
  port: number;
  key_path: string;
  remote_repo_root: string;
}

// ─── Providers config ─────────────────────────────────────────────────────────

export interface ProviderSlot {
  model: string;
  key: string;
  max_concurrent?: number;
}

export interface ModelPricing {
  input_per_mtok: number;
  output_per_mtok: number;
}

export interface ProvidersConfig {
  slots: {
    plan?: ProviderSlot[];
    synthesis?: ProviderSlot[];
    swarm?: ProviderSlot[];
    commit_slot?: ProviderSlot[];
    [key: string]: ProviderSlot[] | undefined;
  };
  rotation: string;
  pricing: Record<string, ModelPricing>;
}

// ─── Prompts config ───────────────────────────────────────────────────────────

export interface Prompt {
  text: string;
  model: string;
  effort: string;
  phase: string;
}

export interface PromptsConfig {
  prompts: Record<string, Prompt>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the flywheel config directory.
 * Defaults to ~/.flywheel but respects FLYWHEEL_HOME for test isolation —
 * set FLYWHEEL_HOME=/tmp/some-dir to redirect all config reads/writes.
 */
export function flywheelDir(): string {
  return process.env.FLYWHEEL_HOME ?? join(homedir(), ".flywheel");
}

/** Build a path rooted in the active flywheel home. */
export function flywheelPath(...segments: string[]): string {
  return join(flywheelDir(), ...segments);
}

/** Default SQLite path, overridable for tests and isolated runs. */
export function defaultStateDbPath(): string {
  return process.env.FLYWHEEL_STATE_DB ?? flywheelPath("state.db");
}

/** Render a local absolute path in a shorter, human-readable form. */
export function formatPathForDisplay(path: string): string {
  const home = homedir();
  if (path === home) {
    return "~";
  }

  if (path.startsWith(`${home}/`)) {
    return `~/${path.slice(home.length + 1)}`;
  }

  return path;
}

/** Expands a leading ~ to the home directory. */
export function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(2));
  }
  return resolve(p);
}

// ─── Loaders ──────────────────────────────────────────────────────────────────

/**
 * Load the SSH config from the active flywheel home.
 * Throws with a helpful message if the file doesn't exist.
 */
export function loadSshConfig(): SshConfig {
  const p = flywheelPath("ssh.yaml");
  if (!existsSync(p)) {
    throw new Error(
      `SSH config not found at ${p}.\nRun: flywheel settings ssh`
    );
  }
  const raw = yaml.load(readFileSync(p, "utf8")) as SshConfig;
  // Expand tilde in key_path so node-ssh receives an absolute path
  raw.key_path = expandTilde(raw.key_path);
  return raw;
}

/**
 * Load the providers config from the active flywheel home.
 * Throws with a helpful message if the file doesn't exist.
 * The file must be chmod 600 — never committed to git.
 */
export function loadProvidersConfig(): ProvidersConfig {
  const p = flywheelPath("providers.yaml");
  if (!existsSync(p)) {
    throw new Error(
      `Providers config not found at ${p}.\n` +
        `Copy config/providers.example.yaml to ${p}, fill in your API keys, then chmod 600 ${p}`
    );
  }
  return yaml.load(readFileSync(p, "utf8")) as ProvidersConfig;
}

/**
 * Load the bundled prompts.yaml.
 * Searches next to the running script first (dist/), then falls back to the
 * repo root config/ directory (dev mode).
 */
export function loadPromptsConfig(): PromptsConfig {
  // In ESM we can't use __dirname, so derive it from import.meta.url
  const selfDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    flywheelPath("prompts.yaml"), // test/dev override via FLYWHEEL_HOME
    join(selfDir, "..", "config", "prompts.yaml"), // dist/cli.js → config/
    join(selfDir, "..", "..", "config", "prompts.yaml"), // dist/cli/ → config/
    join(process.cwd(), "config", "prompts.yaml"), // dev: repo root
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return yaml.load(readFileSync(p, "utf8")) as PromptsConfig;
    }
  }
  throw new Error(
    `prompts.yaml not found. Checked:\n${candidates.join("\n")}`
  );
}

/**
 * Compute the USD cost for a model call given token counts and the pricing table.
 * Returns 0 if the model isn't in the pricing table.
 */
export function computeCost(
  model: string,
  tokens: { input: number; output: number },
  pricing: Record<string, ModelPricing>
): number {
  const p = pricing[model];
  if (!p) return 0;
  return (
    (tokens.input / 1_000_000) * p.input_per_mtok +
    (tokens.output / 1_000_000) * p.output_per_mtok
  );
}
