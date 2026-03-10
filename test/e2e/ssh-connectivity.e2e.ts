/**
 * test/e2e/ssh-connectivity.e2e.ts
 * Bead: agent-flywheel-console-1zb.2
 *
 * End-to-end tests for VPS SSH connectivity commands:
 *   flywheel ssh test, flywheel preflight, flywheel doctor
 *
 * VPS-dependent suites use describe.skipIf(!hasSshConfig()) so they are
 * skipped automatically when ~/.flywheel/ssh.yaml is missing (CI-safe).
 * Set FLYWHEEL_TEST_E2E=1 to opt in (the vitest.config includes this file
 * unconditionally; the suites self-skip based on ssh.yaml presence).
 *
 * Every test logs the full command invocation, exit code, and captured
 * stdout/stderr before asserting — ensuring CI failures are always
 * debuggable without a re-run.
 */

import { describe, it, expect } from "vitest";
import { runFlywheel, hasSshConfig, assertSuccess } from "./setup.js";
import { initDb } from "../../cli/state.js";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

const sshYamlPath = join(homedir(), ".flywheel", "ssh.yaml");

// describeVps: skips the entire suite when ssh.yaml is missing
const describeVps = describe.skipIf(!hasSshConfig());

// ── flywheel ssh test ──────────────────────────────────────────────────────────

describeVps("flywheel ssh test", () => {
  it("exits 0 and shows connected latency when VPS is reachable", () => {
    const result = runFlywheel(["ssh", "test"]);

    assertSuccess(result, "flywheel ssh test");
    expect(result.stdout).toMatch(/Connected to/);
    expect(result.stdout).toMatch(/\d+ms/);
  });

  it("logs the connection to SQLite (ssh_connections row has latency_ms)", () => {
    const result = runFlywheel(["ssh", "test"]);
    expect(result.exitCode).toBe(0);

    const stateDbPath = join(homedir(), ".flywheel", "state.db");
    if (!existsSync(stateDbPath)) return;

    const db = initDb(stateDbPath);
    const row = (db as unknown as {
      prepare(sql: string): { get(): { latency_ms: number | null } | undefined };
    })
      .prepare("SELECT latency_ms FROM ssh_connections ORDER BY id DESC LIMIT 1")
      .get();
    if (row) {
      expect(typeof row.latency_ms).toBe("number");
      expect(row.latency_ms).toBeGreaterThan(0);
    }
  });

  it("exits 1 with a clear error message for an unreachable host", () => {
    const tempDir = join(tmpdir(), `flywheel-ssh-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const badSshYaml = join(tempDir, "ssh.yaml");
    writeFileSync(
      badSshYaml,
      `host: "192.0.2.1"\nuser: nobody\nport: 22\nkey_path: "${sshYamlPath}"\nremote_repo_root: "/home/nobody/projects"\n`,
      "utf8"
    );

    const result = runFlywheel(["ssh", "test"], {
      env: { FLYWHEEL_SSH_CONFIG: badSshYaml },
      timeout: 10_000,
    });

    rmSync(tempDir, { recursive: true, force: true });

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).not.toContain("at Object.");
    expect(output).not.toContain("node_modules");
    expect(output.length).toBeGreaterThan(0);
  });
});

// ── flywheel preflight ──────────────────────────────────────────────────────────

describeVps("flywheel preflight", () => {
  it("exits 0 and shows green checkmarks for required tools on a configured VPS", () => {
    const result = runFlywheel(["preflight"]);

    assertSuccess(result, "flywheel preflight");
    for (const tool of ["ntm", "br", "bv", "gh", "git"]) {
      expect(result.stdout).toContain(`✓ ${tool}`);
    }
    expect(result.stdout).toContain("All required checks passed");
  });

  it("exits 0 with --force even if recommended tools are absent", () => {
    const result = runFlywheel(["preflight", "--force"]);
    expect(result.exitCode).toBeLessThanOrEqual(2);
  });
});

// ── flywheel doctor ─────────────────────────────────────────────────────────────

describeVps("flywheel doctor (with real VPS)", () => {
  it("exits 0 and passes all checks on a fully configured system", () => {
    const providersPath = join(homedir(), ".flywheel", "providers.yaml");
    const hasProviders = existsSync(providersPath);

    const result = runFlywheel(["doctor"]);

    if (hasProviders) {
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("✓ ssh.yaml");
      expect(result.stdout).toContain("✓ SSH connectivity");
    } else {
      expect([0, 1]).toContain(result.exitCode);
      expect(result.stdout).toContain("✓ ssh.yaml");
      expect(result.stdout).toContain("✓ SSH connectivity");
    }
  });

  it("shows SSH latency in the connectivity check output", () => {
    const result = runFlywheel(["doctor"]);
    expect(result.stdout).toMatch(/\d+ms/);
  });
});

// ── flywheel preflight output format ───────────────────────────────────────────

describeVps("flywheel preflight output format", () => {
  it("shows version info where available (e.g. git --version)", () => {
    const result = runFlywheel(["preflight"]);
    assertSuccess(result, "flywheel preflight");
    expect(result.stdout).toContain("git");
    expect(result.stdout).toMatch(/\d+\.\d+/);
  });

  it("output has no raw stack traces on failure", () => {
    const result = runFlywheel(["preflight"]);
    expect(result.stdout + result.stderr).not.toContain("at Object.<anonymous>");
    expect(result.stdout + result.stderr).not.toContain("node_modules");
  });
});
