// Shared utilities used across multiple CLI modules.
// Import from here rather than defining locally in each file.

import { basename } from "node:path";
import chalk from "chalk";

/**
 * Shell-quote a string for safe interpolation into a bash command.
 * Wraps the value in single quotes and escapes any embedded single quotes.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Remove trailing slash(es) from a path string.
 * Useful when building remote paths from config.remoteRepoRoot.
 */
export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Extract a human-readable message from an unknown caught value.
 * Safe replacement for the `(err as Error).message` anti-pattern.
 */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Get the project name from the current working directory (basename only).
 * Falls back to "project" if cwd is the filesystem root.
 */
export function getProjectName(): string {
  return basename(process.cwd()) || "project";
}

/**
 * Canonical phase colour palette — used everywhere phases are displayed.
 * plan=blue  beads=cyan  swarm=yellow  review=magenta  deploy=green
 *
 * Import this instead of defining a local phaseColor so all views are consistent.
 */
const PHASE_COLORS: Record<string, (s: string) => string> = {
  plan:   chalk.blue,
  beads:  chalk.cyan,
  swarm:  chalk.yellow,
  review: chalk.magenta,
  deploy: chalk.green,
};

export function phaseColor(phase: string): string {
  return (PHASE_COLORS[phase] ?? chalk.white)(phase);
}

/**
 * Truncate a string to maxLen, appending "…" if it exceeds the limit.
 * Safe to use on chalk-coloured strings? No — only use on plain strings.
 */
export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

/**
 * Parse a CLI option string as a positive integer.
 * Returns the parsed integer, or throws with a user-facing error message
 * if the value is not a valid positive integer.
 * Note: parseInt('1.9') → 1 (positive), so '1.9' is accepted.
 */
export function parsePositiveInt(raw: string, flagName = "value"): number {
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `Invalid ${flagName}: "${raw}" is not a positive integer.`
    );
  }
  return n;
}
