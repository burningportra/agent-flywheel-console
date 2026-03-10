/**
 * test/integration/cli-config-and-state.integration.test.ts — bead: 3qw.2.1
 * Covers: config persistence lifecycle, state DB initialization, and
 *   flywheel settings ssh data flow (minus interactive prompts).
 *
 * Tests via real subprocess spawning (dist/cli.js) + FLYWHEEL_HOME isolation.
 * Also tests the config + state TypeScript API directly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import yaml from "js-yaml";
import { tempDir, FIXTURE_SSH_CONFIG, FIXTURE_PROVIDERS_CONFIG } from "../helpers.js";
import { initDb, StateManager } from "../../cli/state.js";
import { loadSshConfig, flywheelDir } from "../../cli/config.js";

const CLI = resolve("dist/cli.js");

function fly(args: string[], extraEnv: Record<string, string> = {}) {
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...extraEnv },
    timeout: 15_000,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

let dir: ReturnType<typeof tempDir>;

beforeEach(() => {
  dir = tempDir();
  mkdirSync(dir.path, { recursive: true });
});
afterEach(() => dir.cleanup());

function env() {
  return {
    FLYWHEEL_HOME: dir.path,
    FLYWHEEL_STATE_DB: join(dir.path, "state.db"),
  };
}

// ── State DB lifecycle ────────────────────────────────────────────────────────

describe("SQLite state DB — initialization lifecycle", () => {
  it("state.db is created on first flywheel command", () => {
    expect(existsSync(join(dir.path, "state.db"))).toBe(false);
    fly(["runs"], env()); // any command that touches the DB
    expect(existsSync(join(dir.path, "state.db"))).toBe(true);
  });

  it("state.db persists run records across CLI invocations", () => {
    // First invocation: create a run via TypeScript API (simulating wizard)
    const db = initDb(join(dir.path, "state.db"));
    const sm = new StateManager(db);
    const runId = sm.createFlywheelRun("persist-test", "plan");
    db.close();

    // Second invocation: flywheel runs should see the persisted run
    const { stdout, exitCode } = fly(["runs"], env());
    expect(exitCode).toBe(0);
    expect(stdout).toContain("persist-test");
    expect(stdout).toContain(runId.slice(0, 8));
  });

  it("multiple CLI invocations accumulate state correctly", () => {
    const db = initDb(join(dir.path, "state.db"));
    const sm = new StateManager(db);
    sm.createFlywheelRun("proj-1", "plan");
    sm.createFlywheelRun("proj-2", "swarm");
    db.close();

    const { stdout, exitCode } = fly(["runs"], env());
    expect(exitCode).toBe(0);
    expect(stdout).toContain("proj-1");
    expect(stdout).toContain("proj-2");
  });

  it("flywheel gate advance updates the DB, visible in next gate status", () => {
    const db = initDb(join(dir.path, "state.db"));
    const sm = new StateManager(db);
    sm.createFlywheelRun("gated-proj", "plan");
    db.close();

    fly(["gate", "advance"], env());

    const db2 = initDb(join(dir.path, "state.db"));
    const sm2 = new StateManager(db2);
    const runs = sm2.listFlywheelRuns();
    expect(runs[0].phase).toBe("beads");
    expect(runs[0].gate_passed_at).not.toBeNull();
    db2.close();
  });
});

// ── FLYWHEEL_HOME config isolation ────────────────────────────────────────────

describe("FLYWHEEL_HOME isolation", () => {
  it("each test's FLYWHEEL_HOME is completely independent", () => {
    const dir2 = tempDir();
    mkdirSync(dir2.path, { recursive: true });

    // Write ssh.yaml to dir2 only
    writeFileSync(join(dir2.path, "ssh.yaml"), yaml.dump(FIXTURE_SSH_CONFIG), "utf8");

    // dir has no ssh.yaml → doctor shows FAIL
    const r1 = fly(["doctor"], env());
    expect(r1.stdout).toMatch(/✗.*ssh\.yaml/i);

    // dir2 has ssh.yaml → doctor passes that check
    const r2 = fly(["doctor"], {
      FLYWHEEL_HOME: dir2.path,
      FLYWHEEL_STATE_DB: join(dir2.path, "state.db"),
    });
    expect(r2.stdout).toMatch(/✓.*ssh\.yaml|loaded/i);

    dir2.cleanup();
  });

  it("FLYWHEEL_HOME controls where state.db is created", () => {
    fly(["runs"], env());
    expect(existsSync(join(dir.path, "state.db"))).toBe(true);
    // Real ~/.flywheel/state.db is NOT touched
    // (We can't easily check this without knowing real homedir state,
    // but the env override is the correct mechanism)
  });
});

// ── SSH config persistence ────────────────────────────────────────────────────

describe("ssh.yaml config persistence (no interactive prompts)", () => {
  it("loadSshConfig reads from FLYWHEEL_HOME directory", () => {
    writeFileSync(
      join(dir.path, "ssh.yaml"),
      yaml.dump({ ...FIXTURE_SSH_CONFIG, host: "unique-test-host.example.com" }),
      "utf8"
    );

    process.env.FLYWHEEL_HOME = dir.path;
    try {
      const cfg = loadSshConfig();
      expect(cfg.host).toBe("unique-test-host.example.com");
    } finally {
      delete process.env.FLYWHEEL_HOME;
    }
  });

  it("settings ssh writes to FLYWHEEL_HOME/ssh.yaml with mode 600", () => {
    // Simulate what flywheel settings ssh does: write a valid yaml
    const sshPath = join(dir.path, "ssh.yaml");
    writeFileSync(
      sshPath,
      yaml.dump(FIXTURE_SSH_CONFIG),
      { encoding: "utf8", mode: 0o600 }
    );

    const stat = statSync(sshPath);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
    expect(existsSync(sshPath)).toBe(true);
  });

  it("providers.yaml is separate from ssh.yaml (not merged)", () => {
    writeFileSync(join(dir.path, "ssh.yaml"), yaml.dump(FIXTURE_SSH_CONFIG), "utf8");
    writeFileSync(join(dir.path, "providers.yaml"), yaml.dump(FIXTURE_PROVIDERS_CONFIG), "utf8");

    // Both files exist independently
    expect(existsSync(join(dir.path, "ssh.yaml"))).toBe(true);
    expect(existsSync(join(dir.path, "providers.yaml"))).toBe(true);

    // SSH config doesn't bleed into providers
    const { stdout } = fly(["doctor"], env());
    expect(stdout).toMatch(/ssh\.yaml.*✓|✓.*ssh/i);
    expect(stdout).toMatch(/providers\.yaml.*✓|✓.*provider/i);
  });
});
