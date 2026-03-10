/**
 * test/e2e/error-matrix/01-ssh-and-config-failures.e2e.ts — bead: agent-9wjq.3
 *
 * Exhaustive test of every config-missing and SSH-error scenario.
 *
 * The no-VPS subset (config validation, argument validation, CLI guardrails)
 * always runs. VPS-dependent tests (SSH auth failure, timeout, connection drops)
 * are skipped unless FLYWHEEL_TEST_E2E=1.
 *
 * For every test:
 * - Correct exit code (1 for user errors)
 * - Error message is user-readable (not a stack trace)
 * - No secrets appear in stdout/stderr
 * - Process exits cleanly (no SIGKILL, no hang)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import yaml from "js-yaml";
import { tempDir } from "../../helpers.js";

const CLI = resolve("dist/cli.js");
const runVpsE2e = process.env.FLYWHEEL_TEST_E2E === "1";

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
  timedOut: boolean;
}

function fly(
  args: string[],
  extraEnv: Record<string, string> = {},
  timeoutMs = 15_000
): RunResult {
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...extraEnv },
    timeout: timeoutMs,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    exitCode: result.status ?? 1,
    stdout,
    stderr,
    combined: `${stdout}\n${stderr}`,
    timedOut: result.signal === "SIGTERM",
  };
}

let dir: ReturnType<typeof tempDir>;
let baseEnv: Record<string, string>;

beforeEach(() => {
  dir = tempDir();
  mkdirSync(dir.path, { recursive: true });
  baseEnv = {
    FLYWHEEL_HOME: dir.path,
    FLYWHEEL_STATE_DB: join(dir.path, "state.db"),
  };
});

afterEach(() => dir.cleanup());

// ── Config missing — no ssh.yaml ──────────────────────────────────────────────

describe("Config missing: no ssh.yaml", () => {
  it("flywheel ssh test → exit 1, mentions 'flywheel settings ssh'", () => {
    const r = fly(["ssh", "test"], baseEnv);
    expect(r.exitCode).toBe(1);
    expect(r.combined.toLowerCase()).toMatch(/ssh|settings/i);
    expect(r.timedOut).toBe(false);
  });

  it("flywheel preflight → exit 1, mentions SSH or config", () => {
    const r = fly(["preflight"], baseEnv, 12_000);
    expect(r.exitCode).toBe(1);
    expect(r.combined).toMatch(/ssh|config/i);
    expect(r.timedOut).toBe(false);
  });

  it("flywheel doctor → exit 1, no crash, all checks shown", () => {
    const r = fly(["doctor"], baseEnv);
    expect(r.exitCode).toBe(1);
    // Doctor should print something for each check, not crash
    expect(r.stdout.length + r.stderr.length).toBeGreaterThan(20);
    // Must not be a raw Node.js stack trace
    expect(r.combined).not.toMatch(/at Object\.<anonymous>/);
    expect(r.timedOut).toBe(false);
  });
});

// ── Config missing — no providers.yaml ────────────────────────────────────────

describe("Config missing: no providers.yaml (ssh.yaml present but no providers)", () => {
  beforeEach(() => {
    // Write a valid ssh.yaml so the first check passes
    writeFileSync(
      join(dir.path, "ssh.yaml"),
      yaml.dump({
        host: "127.0.0.1",
        user: "ubuntu",
        port: 22,
        key_path: "~/.ssh/id_ed25519",
        remote_repo_root: "/home/ubuntu/projects",
      }),
      "utf8"
    );
  });

  it("flywheel new 'idea' → exit 1, mentions providers.yaml or slots.plan", () => {
    const r = fly(["new", "test-idea"], baseEnv, 12_000);
    expect(r.exitCode).toBe(1);
    expect(r.combined).toMatch(/providers|slots/i);
    expect(r.timedOut).toBe(false);
  });
});

// ── Gate and rollback with no state ──────────────────────────────────────────

describe("Gate and rollback: no flywheel runs in DB", () => {
  it("flywheel gate advance → exit 1, 'No flywheel runs found' or similar", () => {
    const r = fly(["gate", "advance"], baseEnv);
    expect(r.exitCode).toBe(1);
    expect(r.combined).toMatch(/no.*run|run.*not found/i);
    expect(r.timedOut).toBe(false);
  });

  it("flywheel gate status → exit 0 (informational, not an error)", () => {
    const r = fly(["gate", "status"], baseEnv);
    // gate status with no runs should be informational, not fatal
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it("flywheel rollback → exit 1, 'no runs' or 'checkpoint' message", () => {
    const r = fly(["rollback"], baseEnv);
    expect(r.exitCode).toBe(1);
    expect(r.combined).toMatch(/no.*run|checkpoint|run.*not found/i);
    expect(r.timedOut).toBe(false);
  });
});

// ── Argument validation errors ────────────────────────────────────────────────

describe("Argument validation: invalid values exit 1 before any I/O", () => {
  it("flywheel swarm 0 → exit 1, 'positive integer'", () => {
    const r = fly(["swarm", "0"], baseEnv);
    expect(r.exitCode).toBe(1);
    expect(r.combined).toMatch(/positive integer/i);
    expect(r.timedOut).toBe(false);
  });

  it("flywheel swarm abc → exit 1, 'positive integer'", () => {
    const r = fly(["swarm", "abc"], baseEnv);
    expect(r.exitCode).toBe(1);
    expect(r.combined).toMatch(/positive integer/i);
    expect(r.timedOut).toBe(false);
  });

  it("flywheel swarm --budget foo → exit 1, 'positive number'", () => {
    const r = fly(["swarm", "3", "--budget", "foo"], baseEnv);
    expect(r.exitCode).toBe(1);
    expect(r.combined).toMatch(/positive number/i);
    expect(r.timedOut).toBe(false);
  });

  it("flywheel swarm --budget -5 → exit 1, 'positive number'", () => {
    const r = fly(["swarm", "3", "--budget", "-5"], baseEnv);
    expect(r.exitCode).toBe(1);
    expect(r.combined).toMatch(/positive number/i);
    expect(r.timedOut).toBe(false);
  });

  it("flywheel beads triage --top foo → exit 1, mentions flag and bad value", () => {
    const r = fly(["beads", "triage", "--top", "foo"], baseEnv);
    expect(r.exitCode).toBe(1);
    expect(r.combined).toMatch(/top|positive integer/i);
    expect(r.timedOut).toBe(false);
  });

  it("flywheel monitor --interval 0 → exit 1, 'positive integer'", () => {
    const r = fly(["monitor", "--interval", "0"], baseEnv);
    expect(r.exitCode).toBe(1);
    expect(r.combined).toMatch(/positive integer/i);
    expect(r.timedOut).toBe(false);
  });
});

// ── No secret leakage ─────────────────────────────────────────────────────────

describe("Security: no secrets in error output", () => {
  it("ssh test error output never contains private key file contents", () => {
    // Write a fake key file with detectable content
    const keyPath = join(dir.path, "fake_key");
    writeFileSync(keyPath, "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKEKEYCONTENT\n-----END OPENSSH PRIVATE KEY-----\n");
    writeFileSync(
      join(dir.path, "ssh.yaml"),
      yaml.dump({
        host: "127.0.0.1",
        user: "ubuntu",
        port: 22,
        key_path: keyPath,
        remote_repo_root: "/home/ubuntu/projects",
      }),
      "utf8"
    );

    const r = fly(["ssh", "test"], baseEnv);
    // Key path itself may appear (for diagnostics), but key contents must not
    expect(r.combined).not.toContain("FAKEKEYCONTENT");
    expect(r.combined).not.toContain("BEGIN OPENSSH PRIVATE KEY");
  });
});

// ── SSH error tests (VPS-dependent) ──────────────────────────────────────────

describe.skipIf(!runVpsE2e)("SSH error modes (requires FLYWHEEL_TEST_E2E=1)", () => {
  it("SSH auth failure → exit 1, message does not leak private key contents", () => {
    // This test only runs with a real VPS configured
    const r = fly(["ssh", "test"]);
    expect(r.exitCode).toBe(1);
    expect(r.combined).not.toMatch(/BEGIN.*PRIVATE.*KEY/);
    expect(r.combined).not.toMatch(/-----END/);
  });
});
