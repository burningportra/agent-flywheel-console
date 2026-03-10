/**
 * test/integration/cli-doctor.test.ts
 * Covers: flywheel doctor — spawns real binary with controlled FLYWHEEL_HOME
 * No VPS required.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import yaml from "js-yaml";
import { tempDir, FIXTURE_SSH_CONFIG, FIXTURE_PROVIDERS_CONFIG } from "../helpers.js";

const CLI = resolve("dist/cli.js");

function flywheel(args: string[], extraEnv: Record<string, string> = {}): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...extraEnv },
    timeout: 15_000,
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

let dir: ReturnType<typeof tempDir>;
beforeEach(() => { dir = tempDir(); mkdirSync(dir.path, { recursive: true }); });
afterEach(() => dir.cleanup());

function env(): Record<string, string> {
  return {
    FLYWHEEL_HOME: dir.path,
    FLYWHEEL_STATE_DB: join(dir.path, "state.db"),
  };
}

describe("flywheel doctor — no config files", () => {
  it("exits 1 (ssh.yaml missing = failure)", () => {
    expect(flywheel(["doctor"], env()).exitCode).toBe(1);
  });

  it("shows ssh.yaml check as FAIL", () => {
    const { stdout } = flywheel(["doctor"], env());
    expect(stdout).toContain("ssh.yaml");
    expect(stdout).toMatch(/✗|not found/i);
  });

  it("shows providers.yaml check as WARN (not blocking)", () => {
    const { stdout } = flywheel(["doctor"], env());
    expect(stdout).toContain("providers.yaml");
    expect(stdout).toMatch(/⚠/);
  });

  it("shows prompts.yaml check as OK (bundled config found)", () => {
    const { stdout } = flywheel(["doctor"], env());
    expect(stdout).toContain("prompts.yaml");
    expect(stdout).toMatch(/✓.*14|14.*✓|14 prompts/i);
  });

  it("shows SQLite check as OK with fresh DB", () => {
    const { stdout } = flywheel(["doctor"], env());
    expect(stdout).toContain("SQLite");
    expect(stdout).toMatch(/✓/);
  });

  it("shows SSH connectivity as skipped (no ssh.yaml)", () => {
    const { stdout } = flywheel(["doctor"], env());
    expect(stdout).toMatch(/skipped|no ssh\.yaml/i);
  });

  it("shows all three section headings", () => {
    const { stdout } = flywheel(["doctor"], env());
    expect(stdout).toMatch(/config files?/i);
    expect(stdout).toMatch(/state database/i);
    expect(stdout).toMatch(/ssh connectivity/i);
  });

  it("shows a recommended next steps section", () => {
    const { stdout } = flywheel(["doctor"], env());
    expect(stdout).toMatch(/recommended next step/i);
  });
});

describe("flywheel doctor — with valid ssh.yaml (/dev/null key)", () => {
  beforeEach(() => {
    writeFileSync(
      join(dir.path, "ssh.yaml"),
      yaml.dump({ ...FIXTURE_SSH_CONFIG, key_path: "/dev/null" }),
      "utf8"
    );
  });

  it("shows ssh.yaml as OK", () => {
    const { stdout } = flywheel(["doctor"], env());
    expect(stdout).toContain("ssh.yaml");
    expect(stdout).toMatch(/✓.*loaded|loaded.*✓/i);
  });
});

describe("flywheel doctor — with both ssh.yaml and providers.yaml", () => {
  beforeEach(() => {
    writeFileSync(join(dir.path, "ssh.yaml"), yaml.dump({ ...FIXTURE_SSH_CONFIG, key_path: "/dev/null" }), "utf8");
    writeFileSync(join(dir.path, "providers.yaml"), yaml.dump(FIXTURE_PROVIDERS_CONFIG), "utf8");
  });

  it("shows providers.yaml as OK", () => {
    const { stdout } = flywheel(["doctor"], env());
    expect(stdout).toMatch(/✓.*provider|provider.*✓/i);
  });

  it("shows a Recommended next steps section", () => {
    const { stdout } = flywheel(["doctor"], env());
    expect(stdout).toMatch(/Recommended next step/i);
  });
});
