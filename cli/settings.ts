import { input } from "@inquirer/prompts";
import chalk from "chalk";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

import { expandTilde, flywheelDir, type SshConfig } from "./config.js";

interface StoredSshConfig {
  host?: unknown;
  user?: unknown;
  port?: unknown;
  key_path?: unknown;
  remote_repo_root?: unknown;
}

const DEFAULT_SSH_CONFIG: SshConfig = {
  host: "",
  user: "ubuntu",
  port: 22,
  key_path: "~/.ssh/id_ed25519",
  remote_repo_root: "/home/ubuntu/projects",
};

export interface ConfigureSshSettingsResult {
  configPath: string;
  config: SshConfig;
}

export async function configureSshSettings(): Promise<ConfigureSshSettingsResult> {
  const configPath = join(flywheelDir(), "ssh.yaml");
  const existing = loadStoredSshConfig(configPath);
  const defaults = {
    ...DEFAULT_SSH_CONFIG,
    ...existing,
  };

  const host = await input({
    message: "VPS host",
    default: defaults.host,
    validate: (value) => (value.trim().length > 0 ? true : "Host is required."),
  });

  const user = await input({
    message: "SSH user",
    default: defaults.user,
    validate: (value) => (value.trim().length > 0 ? true : "User is required."),
  });

  const portValue = await input({
    message: "SSH port",
    default: String(defaults.port),
    validate: validatePort,
  });

  const keyPath = await input({
    message: "Private key path",
    default: defaults.key_path,
    validate: validateReadablePath,
  });

  const remoteRepoRoot = await input({
    message: "Remote repo root",
    default: defaults.remote_repo_root,
    validate: (value) =>
      value.trim().length > 0 ? true : "Remote repo root is required.",
  });

  const config: SshConfig = {
    host: host.trim(),
    user: user.trim(),
    port: parseInt(portValue, 10),
    key_path: keyPath.trim(),
    remote_repo_root: remoteRepoRoot.trim(),
  };

  persistSshConfig(configPath, config);

  console.log(chalk.green(`✓ SSH config saved to ${configPath}`));

  return { configPath, config };
}

export function loadStoredSshConfig(configPath: string): Partial<SshConfig> {
  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const raw = yaml.load(readFileSync(configPath, "utf8")) as StoredSshConfig | null;
    if (!raw || typeof raw !== "object") {
      return {};
    }

    return {
      host: asTrimmedString(raw.host) ?? DEFAULT_SSH_CONFIG.host,
      user: asTrimmedString(raw.user) ?? DEFAULT_SSH_CONFIG.user,
      port: asPort(raw.port) ?? DEFAULT_SSH_CONFIG.port,
      key_path: asTrimmedString(raw.key_path) ?? DEFAULT_SSH_CONFIG.key_path,
      remote_repo_root:
        asTrimmedString(raw.remote_repo_root) ?? DEFAULT_SSH_CONFIG.remote_repo_root,
    };
  } catch {
    return {};
  }
}

export function persistSshConfig(configPath: string, config: SshConfig): void {
  mkdirSync(flywheelDir(), { recursive: true });
  const serialized = yaml.dump(
    {
      host: config.host,
      user: config.user,
      port: config.port,
      key_path: config.key_path,
      remote_repo_root: config.remote_repo_root,
    },
    { noRefs: true, lineWidth: -1 }
  );
  writeFileSync(configPath, serialized, { encoding: "utf8", mode: 0o600 });
  // Explicitly set 600 — writeFileSync mode only applies on creation, not overwrite.
  chmodSync(configPath, 0o600);
}

export function validatePort(value: string): true | string {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return "Port must be a positive integer.";
  }

  const port = parseInt(trimmed, 10);
  if (port < 1 || port > 65535) {
    return "Port must be between 1 and 65535.";
  }

  return true;
}

export function validateReadablePath(value: string): true | string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "Private key path is required.";
  }

  try {
    const expandedPath = expandTilde(trimmed);
    accessSync(expandedPath, constants.R_OK);
    return true;
  } catch {
    return `Private key path is not readable: ${trimmed}`;
  }
}

export function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function asPort(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535) {
    return value;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = parseInt(value.trim(), 10);
    if (parsed > 0 && parsed <= 65535) {
      return parsed;
    }
  }

  return undefined;
}
