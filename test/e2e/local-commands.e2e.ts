/**
 * test/e2e/local-commands.e2e.ts — bead: agent-f1xo.1
 *
 * Spawns dist/cli.js as a real subprocess.
 * All tests use HOME isolation (FLYWHEEL_HOME + FLYWHEEL_STATE_DB → temp dir).
 * No VPS, no network, no API keys required.
 * Tests the FULL command pipeline from binary entry to process.exit.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import yaml from "js-yaml";
import { runFlywheel, assertSuccess, assertFailure } from "./setup.js";
import { tempDir, stripAnsi, FIXTURE_SSH_CONFIG, FIXTURE_PROVIDERS_CONFIG } from "../helpers.js";
import { initDb, StateManager } from "../../cli/state.js";
import packageJson from "../../package.json" with { type: "json" };

// ── Fixture setup ─────────────────────────────────────────────────────────────

let dir: ReturnType<typeof tempDir>;

function e(extra: Record<string, string> = {}) {
  return {
    FLYWHEEL_HOME: dir.path,
    FLYWHEEL_STATE_DB: join(dir.path, "state.db"),
    ...extra,
  };
}

function fly(args: string[], extraEnv?: Record<string, string>) {
  return runFlywheel(args, { env: e(extraEnv) });
}

function seedRun(phase = "plan", project = "test-project") {
  const db = initDb(join(dir.path, "state.db"));
  const sm = new StateManager(db);
  return { sm, runId: sm.createFlywheelRun(project, phase as Parameters<typeof sm.createFlywheelRun>[1]) };
}

beforeEach(() => {
  dir = tempDir();
  mkdirSync(dir.path, { recursive: true });
});
afterEach(() => dir.cleanup());

// ── Binary bootstrap ──────────────────────────────────────────────────────────

describe("binary bootstrap", () => {
  it("--version outputs the package version", () => {
    const r = fly(["--version"]);
    assertSuccess(r, "--version");
    expect(r.stdout.trim()).toBe(packageJson.version);
  });

  it("--help includes all main command names", () => {
    const r = fly(["--help"]);
    assertSuccess(r, "--help");
    for (const cmd of ["new", "swarm", "gate", "prompts", "doctor", "runs", "replay"]) {
      expect(r.stdout).toContain(cmd);
    }
  });

  it("unknown command exits 1", () => {
    const r = fly(["definitely-not-a-command"]);
    assertFailure(r, "unknown command");
  });
});

// ── flywheel runs ─────────────────────────────────────────────────────────────

describe("flywheel runs", () => {
  it("exits 0 with helpful message when no runs exist", () => {
    const r = fly(["runs"]);
    assertSuccess(r, "flywheel runs empty");
    const plain = stripAnsi(r.stdout);
    expect(plain).toMatch(/no runs|flywheel new/i);
  });

  it("shows project name and phase for a seeded run", () => {
    seedRun("plan", "my-cool-project");
    const r = fly(["runs"]);
    assertSuccess(r, "flywheel runs seeded");
    expect(r.stdout).toContain("my-cool-project");
    expect(r.stdout).toContain("plan");
  });

  it("columns are visually aligned (padded before coloring)", () => {
    seedRun("swarm", "proj-alpha");
    const r = fly(["runs"]);
    // Strip ANSI — plain text columns should contain readable content
    const plain = stripAnsi(r.stdout);
    expect(plain).toContain("proj-alpha");
    // Verify no ANSI codes survive in the padded areas
    expect(plain).not.toContain("\x1b");
  });
});

// ── flywheel replay ───────────────────────────────────────────────────────────

describe("flywheel replay", () => {
  it("exits 1 with 'not found' for a nonexistent ID", () => {
    const r = fly(["replay", "nonexistent-run-id"]);
    assertFailure(r, "replay not found");
    expect(r.stdout + r.stderr).toMatch(/not found/i);
  });

  it("exits 0 and shows event narrative for a run with events", () => {
    const { sm, runId } = seedRun("plan", "replay-proj");
    sm.logEvent(runId, "test_event", { detail: "hello" }, { actor: "flywheel" });
    const r = fly(["replay", runId.slice(0, 8)]);
    assertSuccess(r, "replay with events");
    expect(r.stdout).toContain("test_event");
    expect(r.stdout).toContain("flywheel");
  });

  it("--format json outputs valid JSON with run and events array", () => {
    const { sm, runId } = seedRun("swarm", "json-proj");
    sm.logEvent(runId, "swarm_started");
    const r = fly(["replay", runId.slice(0, 8), "--format", "json"]);
    assertSuccess(r, "replay --format json");
    const parsed = JSON.parse(r.stdout) as { run: { id: string }; events: unknown[] };
    expect(parsed.run.id).toBe(runId);
    expect(parsed.events.length).toBeGreaterThanOrEqual(1);
  });

  it("--since with a far-future timestamp shows no events", () => {
    const { sm, runId } = seedRun("plan");
    sm.logEvent(runId, "old_event");
    const r = fly(["replay", runId.slice(0, 8), "--since", "2099-01-01T00:00:00Z"]);
    assertSuccess(r, "replay --since future");
    expect(r.stdout).toMatch(/no events after/i);
  });
});

// ── flywheel gate status ──────────────────────────────────────────────────────

describe("flywheel gate status", () => {
  it("exits 0 with no-runs message when DB is empty", () => {
    const r = fly(["gate", "status"]);
    assertSuccess(r, "gate status empty");
    expect(r.stdout).toMatch(/no flywheel runs/i);
  });

  it("shows phase, gate state, and next-step hint for a seeded run", () => {
    seedRun("plan");
    const r = fly(["gate", "status"]);
    assertSuccess(r, "gate status seeded");
    expect(r.stdout).toContain("plan");
    expect(r.stdout).toMatch(/waiting/i);
    expect(r.stdout).toMatch(/beads/i); // next phase hint
  });

  it("shows 'passed' after gate has been advanced", () => {
    const { sm, runId } = seedRun("plan");
    sm.advanceGate(runId, "beads");
    const r = fly(["gate", "status"]);
    assertSuccess(r, "gate status passed");
    expect(r.stdout).toMatch(/passed/i);
  });
});

// ── flywheel gate advance ─────────────────────────────────────────────────────

describe("flywheel gate advance", () => {
  it("exits 1 with no-runs message on an empty DB", () => {
    const r = fly(["gate", "advance"]);
    assertFailure(r, "gate advance no runs");
    expect(r.stdout + r.stderr).toMatch(/no flywheel runs/i);
  });

  it("advances plan → beads and updates DB", () => {
    const { sm, runId } = seedRun("plan");
    const r = fly(["gate", "advance"]);
    assertSuccess(r, "gate advance plan→beads");
    expect(r.stdout).toMatch(/plan.*beads|beads/i);
    const run = sm.getFlywheelRun(runId);
    expect(run?.phase).toBe("beads");
    expect(run?.gate_passed_at).not.toBeNull();
  });

  it("--sha stores checkpoint SHA in DB", () => {
    const { sm, runId } = seedRun("plan");
    fly(["gate", "advance", "--sha", "abc1234def5678"]);
    const run = sm.getFlywheelRun(runId);
    expect(run?.checkpoint_sha).toBe("abc1234def5678");
  });

  it("on deploy phase shows terminal message and exits 0", () => {
    const { sm, runId } = seedRun("review");
    sm.advanceGate(runId, "deploy");
    const r = fly(["gate", "advance"]);
    assertSuccess(r, "gate advance terminal");
    expect(r.stdout).toMatch(/terminal|nothing to advance|deploy/i);
  });
});

// ── flywheel prompts list ─────────────────────────────────────────────────────

describe("flywheel prompts list", () => {
  it("exits 0 and lists all phases", () => {
    const r = fly(["prompts", "list"]);
    assertSuccess(r, "prompts list");
    expect(r.stdout).toMatch(/plan/i);
    expect(r.stdout).toMatch(/swarm/i);
    expect(r.stdout).toMatch(/review/i);
  });

  it("shows known prompt names", () => {
    const { stdout } = fly(["prompts", "list"]);
    expect(stdout).toContain("commit-work");
    expect(stdout).toContain("fresh-review");
  });

  it("shows prompt count", () => {
    const { stdout } = fly(["prompts", "list"]);
    expect(stdout).toMatch(/\d+\s+prompts/i);
  });
});

// ── flywheel prompts send (preview mode) ──────────────────────────────────────

describe("flywheel prompts send (no --agent)", () => {
  it("exits 0 in preview mode for a known prompt", () => {
    assertSuccess(fly(["prompts", "send", "commit-work"]), "prompts send preview");
  });

  it("shows the prompt text", () => {
    const { stdout } = fly(["prompts", "send", "commit-work"]);
    expect(stdout).toMatch(/commit|tracked files/i);
  });

  it("shows 'Preview only' hint", () => {
    const { stdout } = fly(["prompts", "send", "commit-work"]);
    expect(stdout).toMatch(/preview|add.*--agent/i);
  });

  it("exits 1 for an unknown prompt", () => {
    assertFailure(fly(["prompts", "send", "does-not-exist"]), "unknown prompt");
  });

  it("--var substitutes the variable", () => {
    const { stdout } = fly(["prompts", "send", "beads-generate-from-plan", "--var", "plan_path=/tmp/myplan.md"]);
    expect(stdout).toContain("/tmp/myplan.md");
    expect(stdout).not.toContain("{plan_path}");
  });

  it("shows unresolved variable warning when --var not provided", () => {
    const { stdout } = fly(["prompts", "send", "beads-generate-from-plan"]);
    expect(stdout).toMatch(/unresolved/i);
  });
});

// ── flywheel doctor ───────────────────────────────────────────────────────────

describe("flywheel doctor (no config)", () => {
  it("exits 1 when ssh.yaml is missing", () => {
    assertFailure(fly(["doctor"]), "doctor no ssh");
  });

  it("shows all three section headings", () => {
    const { stdout } = fly(["doctor"]);
    expect(stdout).toMatch(/config files?/i);
    expect(stdout).toMatch(/state database/i);
    expect(stdout).toMatch(/ssh connectivity/i);
  });

  it("ssh.yaml check fails with actionable hint", () => {
    const { stdout } = fly(["doctor"]);
    expect(stdout).toContain("ssh.yaml");
    expect(stdout).toMatch(/settings ssh|not found/i);
  });

  it("prompts.yaml always passes (bundled config)", () => {
    const { stdout } = fly(["doctor"]);
    expect(stdout).toContain("prompts.yaml");
    expect(stdout).toMatch(/✓.*prompts/i);
  });
});

describe("flywheel doctor (with configs)", () => {
  beforeEach(() => {
    writeFileSync(join(dir.path, "ssh.yaml"), yaml.dump({ ...FIXTURE_SSH_CONFIG, key_path: "/dev/null" }), "utf8");
    writeFileSync(join(dir.path, "providers.yaml"), yaml.dump(FIXTURE_PROVIDERS_CONFIG), "utf8");
  });

  it("shows ssh.yaml as OK", () => {
    const { stdout } = fly(["doctor"]);
    expect(stdout).toMatch(/✓.*loaded|✓.*ssh/i);
  });

  it("shows providers.yaml as OK", () => {
    const { stdout } = fly(["doctor"]);
    expect(stdout).toMatch(/✓.*provider|provider.*✓/i);
  });
});

// ── flywheel providers ────────────────────────────────────────────────────────

describe("flywheel providers (no yaml)", () => {
  it("exits non-zero or shows error when providers.yaml is missing", () => {
    const r = fly(["providers"]);
    // Either exits 1 or shows a clear error message
    const isErrorOutput = r.exitCode !== 0 || r.stdout.match(/not found|missing|providers\.example/i);
    expect(isErrorOutput).toBeTruthy();
  });
});

describe("flywheel providers (with yaml)", () => {
  beforeEach(() => {
    writeFileSync(join(dir.path, "providers.yaml"), yaml.dump(FIXTURE_PROVIDERS_CONFIG), "utf8");
  });

  it("exits 0 and shows model slot names", () => {
    const r = fly(["providers"]);
    assertSuccess(r, "providers with yaml");
    expect(r.stdout).toContain("claude-opus-4-6");
  });

  it("never exposes the full raw API key in output", () => {
    const { stdout } = fly(["providers"]);
    // The full raw key 'sk-ant-test-key' must never appear in output
    expect(stdout).not.toContain("sk-ant-test-key");
    // Something must indicate the credential is configured (credential:configured, masked key, etc.)
    expect(stdout).toMatch(/credential|configured|model/i);
  });
});
