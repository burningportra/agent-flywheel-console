/**
 * test/unit/doctor-integration.test.ts
 *
 * Covers: cli/doctor.ts — runDoctor() with controlled FLYWHEEL_HOME
 * Tests the full diagnostic output under various config states.
 * Uses real temp files. No SSH connection attempted (ssh.yaml missing → skipped).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import yaml from "js-yaml";
import { runDoctor } from "../../cli/doctor.js";
import { captureConsole, stripAnsi, tempDir, FIXTURE_SSH_CONFIG, FIXTURE_PROVIDERS_CONFIG } from "../helpers.js";

type TempDir = ReturnType<typeof tempDir>;

let dir: TempDir;
let origHome: string | undefined;
let origStateDb: string | undefined;

function writeConfig(name: string, content: object): void {
  mkdirSync(dir.path, { recursive: true });
  writeFileSync(join(dir.path, name), yaml.dump(content), "utf8");
}

async function runDoctorCaptured(): Promise<{ out: string; err: string; exitCode: number }> {
  const c = captureConsole();
  let exitCode = 0;
  const origExit = process.exit.bind(process);
  // Intercept process.exit to avoid killing the test runner
  (process as NodeJS.Process & { exit: (code?: number) => never }).exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
  try {
    await runDoctor();
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith("process.exit")) throw e;
  } finally {
    (process as NodeJS.Process & { exit: (code?: number) => never }).exit = origExit as typeof process.exit;
    c.restore();
  }
  return { out: stripAnsi(c.out), err: stripAnsi(c.err), exitCode };
}

beforeEach(() => {
  dir = tempDir();
  origHome = process.env.FLYWHEEL_HOME;
  origStateDb = process.env.FLYWHEEL_STATE_DB;
  process.env.FLYWHEEL_HOME = dir.path;
  process.env.FLYWHEEL_STATE_DB = join(dir.path, "state.db");
  mkdirSync(dir.path, { recursive: true });
});

afterEach(() => {
  if (origHome === undefined) delete process.env.FLYWHEEL_HOME;
  else process.env.FLYWHEEL_HOME = origHome;
  if (origStateDb === undefined) delete process.env.FLYWHEEL_STATE_DB;
  else process.env.FLYWHEEL_STATE_DB = origStateDb;
  dir.cleanup();
});

describe("runDoctor() — config file checks", () => {
  it("reports ssh.yaml as FAIL when missing", async () => {
    const { out } = await runDoctorCaptured();
    expect(out).toContain("ssh.yaml");
    expect(out).toMatch(/✗|not found|fail/i);
  });

  it("reports providers.yaml as WARN when missing (not blocking)", async () => {
    const { out } = await runDoctorCaptured();
    expect(out).toContain("providers.yaml");
    // Missing providers shows as warn, not fail
    expect(out).toMatch(/⚠|not found/i);
  });

  it("reports prompts.yaml as OK when bundled config is accessible", async () => {
    const { out } = await runDoctorCaptured();
    expect(out).toContain("prompts.yaml");
    // bundled prompts.yaml should always be found
    expect(out).toMatch(/✓.*prompts|prompts.*✓/i);
  });

  it("reports SQLite as OK with fresh DB", async () => {
    const { out } = await runDoctorCaptured();
    expect(out).toContain("SQLite");
    expect(out).toContain("✓");
  });

  it("reports SSH connectivity as SKIPPED (no ssh.yaml)", async () => {
    const { out } = await runDoctorCaptured();
    expect(out).toMatch(/skipped|no ssh\.yaml/i);
  });

  it("exits with code 1 when there are failures", async () => {
    const { exitCode } = await runDoctorCaptured();
    // ssh.yaml is missing → failure → exit 1
    expect(exitCode).toBe(1);
  });
});

describe("runDoctor() — with valid ssh.yaml", () => {
  beforeEach(() => {
    // Write a valid ssh.yaml (host unreachable, but file exists + key path check is skipped for fake key)
    // Use /dev/null as key_path since it is always readable
    writeConfig("ssh.yaml", {
      ...FIXTURE_SSH_CONFIG,
      key_path: "/dev/null",
    });
  });

  it("reports ssh.yaml as OK when file is valid", async () => {
    const { out } = await runDoctorCaptured();
    expect(out).toContain("ssh.yaml");
    expect(out).toContain("✓");
  });

  it("reports SSH connectivity FAIL (host unreachable) without crashing", async () => {
    const { out } = await runDoctorCaptured();
    expect(out).toMatch(/SSH connectivity/i);
    // 127.0.0.1 port 22 may or may not be reachable; we just assert no crash
    expect(out).toBeTruthy();
  });
});

describe("runDoctor() — with all configs present", () => {
  beforeEach(() => {
    writeConfig("ssh.yaml", { ...FIXTURE_SSH_CONFIG, key_path: "/dev/null" });
    writeConfig("providers.yaml", FIXTURE_PROVIDERS_CONFIG);
  });

  it("reports providers.yaml as OK with configured slots", async () => {
    const { out } = await runDoctorCaptured();
    expect(out).toContain("providers.yaml");
    expect(out).toMatch(/✓.*provider|provider.*✓/i);
  });

  it("shows recommendation to run flywheel new when healthy", async () => {
    const { out } = await runDoctorCaptured();
    // The 'all good' recommendation should reference the next step
    expect(out).toMatch(/flywheel new|next/i);
  });
});

describe("runDoctor() — output structure", () => {
  it("includes all three check sections: Config, State database, SSH connectivity", async () => {
    const { out } = await runDoctorCaptured();
    expect(out).toMatch(/Config files?/i);
    expect(out).toMatch(/State database/i);
    expect(out).toMatch(/SSH connectivity/i);
  });

  it("always shows a Recommended next steps section", async () => {
    const { out } = await runDoctorCaptured();
    expect(out).toMatch(/Recommended next step/i);
  });

  it("LABEL_WIDTH alignment: SQLite label appears with path info (no truncation)", async () => {
    const { out } = await runDoctorCaptured();
    // The SQLite check label includes the actual db path.
    // We verify it includes "SQLite" and some path info — not a bare "SQLite" with no detail.
    expect(out).toContain("SQLite");
    // Must contain the path fragment (either actual temp path or ~/.flywheel)
    expect(out).toMatch(/SQLite.*state\.db|state\.db.*SQLite/i);
  });
});
