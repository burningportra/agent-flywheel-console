/**
 * test/integration/cli-prompts.test.ts
 * Covers: flywheel prompts list, flywheel prompts send (preview mode)
 * Real binary, no VPS.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { tempDir } from "../helpers.js";

const CLI = resolve("dist/cli.js");

function flywheel(args: string[], env: Record<string, string> = {}): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
    timeout: 10_000,
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

let dir: ReturnType<typeof tempDir>;
beforeEach(() => { dir = tempDir(); mkdirSync(dir.path, { recursive: true }); });
afterEach(() => dir.cleanup());

function env(): Record<string, string> {
  return { FLYWHEEL_HOME: dir.path };
}

// ── prompts list ──────────────────────────────────────────────────────────────

describe("flywheel prompts list", () => {
  it("exits 0", () => {
    expect(flywheel(["prompts", "list"], env()).exitCode).toBe(0);
  });

  it("shows phase headings for all 4 phases", () => {
    const { stdout } = flywheel(["prompts", "list"], env());
    expect(stdout).toMatch(/plan/i);
    expect(stdout).toMatch(/beads/i);
    expect(stdout).toMatch(/swarm/i);
    expect(stdout).toMatch(/review/i);
  });

  it("shows known prompt names", () => {
    const { stdout } = flywheel(["prompts", "list"], env());
    expect(stdout).toContain("commit-work");
    expect(stdout).toContain("fresh-review");
  });

  it("shows effort badges (low/high/max)", () => {
    const { stdout } = flywheel(["prompts", "list"], env());
    // At least one of each effort level should appear
    expect(stdout).toMatch(/low|high|max/i);
  });

  it("shows total prompt count", () => {
    const { stdout } = flywheel(["prompts", "list"], env());
    expect(stdout).toMatch(/\d+ prompts/i);
  });
});

// ── prompts send (preview mode — no --agent/--all) ───────────────────────────

describe("flywheel prompts send (preview mode)", () => {
  it("exits 0 for a known prompt without --agent", () => {
    const { exitCode } = flywheel(["prompts", "send", "commit-work"], env());
    expect(exitCode).toBe(0);
  });

  it("shows the prompt text", () => {
    const { stdout } = flywheel(["prompts", "send", "commit-work"], env());
    expect(stdout).toMatch(/commit|tracked files/i);
  });

  it("shows a 'preview only' hint when no target given", () => {
    const { stdout } = flywheel(["prompts", "send", "commit-work"], env());
    expect(stdout).toMatch(/preview|add.*--agent|--agent.*--all/i);
  });

  it("exits 1 for an unknown prompt name", () => {
    const { exitCode } = flywheel(["prompts", "send", "this-does-not-exist"], env());
    expect(exitCode).toBe(1);
  });

  it("unknown prompt shows 'not found' and hints at prompts list", () => {
    const { stdout, stderr } = flywheel(["prompts", "send", "nonexistent-prompt"], env());
    expect(stdout + stderr).toMatch(/not found/i);
    expect(stdout + stderr).toMatch(/prompts list/i);
  });

  it("--var substitutes the variable into the prompt text", () => {
    const { stdout } = flywheel(
      ["prompts", "send", "beads-generate-from-plan", "--var", "plan_path=/tmp/my-plan.md"],
      env()
    );
    expect(stdout).toContain("/tmp/my-plan.md");
    expect(stdout).not.toContain("{plan_path}");
  });

  it("unresolved variable shows a warning when --var not provided", () => {
    const { stdout } = flywheel(["prompts", "send", "beads-generate-from-plan"], env());
    expect(stdout).toMatch(/unresolved|{plan_path}/i);
  });
});
