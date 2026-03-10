/**
 * Shared test helpers for all test suites.
 *
 * Philosophy: no mocks, no stubs, no spies.
 * Every helper uses a REAL implementation:
 *   - tempDb()    → real better-sqlite3 in-memory DB via initDb(':memory:')
 *   - tempDir()   → real temp directory on disk (cleaned up after test)
 *   - tempYaml()  → real YAML file written to disk
 *   - writeFile() → real file written to disk
 *   - captureConsole() → real console.log/error intercepted via reassignment
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import yaml from "js-yaml";
import { initDb, StateManager } from "../cli/state.js";
import type Database from "better-sqlite3";

// ── Temp directory ────────────────────────────────────────────────────────────

export interface TempDir {
  /** Absolute path to the temp directory */
  path: string;
  /** Delete the directory and all contents */
  cleanup: () => void;
}

/** Create a unique temp directory that is automatically cleaned up. */
export function tempDir(): TempDir {
  const path = mkdtempSync(join(tmpdir(), "flywheel-test-"));
  return {
    path,
    cleanup: () => {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}

// ── In-memory SQLite DB ───────────────────────────────────────────────────────

export interface TempDb {
  db: Database.Database;
  sm: StateManager;
}

/**
 * Create a real in-memory SQLite database with the full schema applied.
 * Suitable for any StateManager test without touching disk.
 */
export function tempDb(): TempDb {
  const db = initDb(":memory:");
  const sm = new StateManager(db);
  return { db, sm };
}

// ── Temp YAML file ────────────────────────────────────────────────────────────

export interface TempFile {
  /** Absolute path to the file */
  path: string;
  cleanup: () => void;
}

/**
 * Write a JavaScript object as YAML to a temp file.
 * Returns the path and a cleanup function.
 */
export function tempYaml(content: object, dir?: string): TempFile {
  const base = dir ?? tmpdir();
  mkdirSync(base, { recursive: true });
  const path = join(base, `flywheel-test-${randomUUID()}.yaml`);
  writeFileSync(path, yaml.dump(content), "utf8");
  return {
    path,
    cleanup: () => {
      try {
        rmSync(path, { force: true });
      } catch {
        // best-effort
      }
    },
  };
}

/**
 * Write arbitrary content to a temp file.
 */
export function writeFile(dir: string, name: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

// ── Console output capture ────────────────────────────────────────────────────

export interface CapturedOutput {
  /** All lines written to console.log */
  stdout: string[];
  /** All lines written to console.error */
  stderr: string[];
  /** Joined stdout as a single string */
  out: string;
  /** Joined stderr as a single string */
  err: string;
  /** Restore original console methods */
  restore: () => void;
}

/**
 * Capture console.log and console.error output during a test.
 * Does NOT suppress output — still prints to real console.
 * Call restore() in afterEach.
 */
export function captureConsole(): CapturedOutput {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    stdout.push(line);
    origLog(...args);
  };
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    stderr.push(line);
    origErr(...args);
  };
  console.warn = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    stderr.push(line);
    origWarn(...args);
  };

  const captured: CapturedOutput = {
    stdout,
    stderr,
    get out() { return stdout.join("\n"); },
    get err() { return stderr.join("\n"); },
    restore: () => {
      console.log = origLog;
      console.error = origErr;
      console.warn = origWarn;
    },
  };

  return captured;
}

// ── ANSI stripping ────────────────────────────────────────────────────────────

/** Strip ANSI escape codes from a string for assertion-safe comparison. */
// eslint-disable-next-line no-control-regex
export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── Fixture configs ───────────────────────────────────────────────────────────

/** Minimal valid SSH config for unit tests. Points at localhost (not real). */
export const FIXTURE_SSH_CONFIG = {
  host: "127.0.0.1",
  user: "ubuntu",
  port: 22,
  key_path: "~/.ssh/id_ed25519",
  remote_repo_root: "/home/ubuntu/projects",
};

/** Minimal valid providers config for unit tests. No real API keys needed. */
export const FIXTURE_PROVIDERS_CONFIG = {
  slots: {
    plan: [{ model: "claude-opus-4-6", key: "sk-ant-test-key" }],
    synthesis: [{ model: "claude-opus-4-6", key: "sk-ant-test-key" }],
    swarm: [{ model: "claude-sonnet-4-6", key: "sk-ant-test-key", max_concurrent: 2 }],
  },
  rotation: "round-robin",
  pricing: {
    "claude-opus-4-6": { input_per_mtok: 15.0, output_per_mtok: 75.0 },
    "claude-sonnet-4-6": { input_per_mtok: 3.0, output_per_mtok: 15.0 },
  },
};

// ── Sleep ─────────────────────────────────────────────────────────────────────

/** Delay for timing-sensitive tests. Keep usage minimal. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
