/**
 * test/unit/config-ssh.test.ts
 * Covers: cli/config.ts — loadSshConfig, expandTilde, flywheelDir with FLYWHEEL_HOME
 *         cli/ssh.ts — loadSSHConfig, expandHomeDir, expectPort (via error messages)
 * Uses real temp files — no mocking.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { expandTilde, flywheelDir, loadSshConfig } from "../../cli/config.js";
import { loadSSHConfig, expandHomeDir } from "../../cli/ssh.js";
import { tempDir } from "../helpers.js";

describe("expandTilde (config.ts)", () => {
  it("expands ~/ to the home directory", () => {
    const result = expandTilde("~/.ssh/id_ed25519");
    expect(result).toMatch(/\/\.ssh\/id_ed25519$/);
    expect(result.startsWith("/")).toBe(true);
  });
  it("expands bare ~ to the home directory", () => {
    expect(expandTilde("~")).toMatch(/\/[^/]+$/); // ends with a path component
  });
  it("leaves absolute paths unchanged (or resolves them)", () => {
    expect(expandTilde("/absolute/path")).toBe("/absolute/path");
  });
});

describe("expandHomeDir (ssh.ts)", () => {
  it("expands ~/ correctly", () => {
    expect(expandHomeDir("~/.ssh/key")).toMatch(/\.ssh\/key$/);
  });
  it("expands bare ~", () => {
    expect(expandHomeDir("~")).not.toContain("~");
  });
  it("leaves absolute paths unchanged", () => {
    expect(expandHomeDir("/abs/path")).toBe("/abs/path");
  });
});

describe("flywheelDir with FLYWHEEL_HOME", () => {
  const orig = process.env.FLYWHEEL_HOME;
  afterEach(() => {
    if (orig === undefined) delete process.env.FLYWHEEL_HOME;
    else process.env.FLYWHEEL_HOME = orig;
  });

  it("uses FLYWHEEL_HOME when set", () => {
    process.env.FLYWHEEL_HOME = "/tmp/test-flywheel";
    expect(flywheelDir()).toBe("/tmp/test-flywheel");
  });
  it("falls back to ~/.flywheel when FLYWHEEL_HOME not set", () => {
    delete process.env.FLYWHEEL_HOME;
    expect(flywheelDir()).toMatch(/\.flywheel$/);
  });
});

describe("loadSshConfig (config.ts) with real temp files", () => {
  let dir: ReturnType<typeof tempDir>;
  let origHome: string | undefined;

  beforeEach(() => {
    dir = tempDir();
    origHome = process.env.FLYWHEEL_HOME;
    process.env.FLYWHEEL_HOME = dir.path;
    mkdirSync(dir.path, { recursive: true });
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.FLYWHEEL_HOME;
    else process.env.FLYWHEEL_HOME = origHome;
    dir.cleanup();
  });

  it("throws with actionable message when ssh.yaml is missing", () => {
    expect(() => loadSshConfig()).toThrow(/flywheel settings ssh/);
  });

  it("loads a valid ssh.yaml correctly", () => {
    writeFileSync(
      join(dir.path, "ssh.yaml"),
      yaml.dump({ host: "my-vps.com", user: "ubuntu", port: 22, key_path: "~/.ssh/id_ed25519", remote_repo_root: "/home/ubuntu/projects" }),
      "utf8"
    );
    const config = loadSshConfig();
    expect(config.host).toBe("my-vps.com");
    expect(config.user).toBe("ubuntu");
    expect(config.port).toBe(22);
  });
});

describe("loadSSHConfig (ssh.ts) with real temp files", () => {
  let dir: ReturnType<typeof tempDir>;

  beforeEach(() => { dir = tempDir(); });
  afterEach(() => dir.cleanup());

  function writeSsh(content: object) {
    mkdirSync(dir.path, { recursive: true });
    writeFileSync(join(dir.path, "ssh.yaml"), yaml.dump(content), "utf8");
    return join(dir.path, "ssh.yaml");
  }

  it("throws SSHError when file missing", () => {
    expect(() => loadSSHConfig("/nonexistent/ssh.yaml")).toThrow(/flywheel settings ssh/);
  });

  it("throws when user field is missing", () => {
    const p = writeSsh({ host: "h", port: 22, key_path: "~/.ssh/id_ed25519", remote_repo_root: "/r" });
    expect(() => loadSSHConfig(p)).toThrow(/"user"/);
  });

  it("throws when port is out of range", () => {
    const p = writeSsh({ host: "h", user: "u", port: 99999, key_path: "~/.ssh/id_ed25519", remote_repo_root: "/r" });
    expect(() => loadSSHConfig(p)).toThrow(/port/);
  });

  it("throws when port is 0", () => {
    const p = writeSsh({ host: "h", user: "u", port: 0, key_path: "~/.ssh/id_ed25519", remote_repo_root: "/r" });
    expect(() => loadSSHConfig(p)).toThrow(/port/);
  });

  it("throws when key_path points to a nonexistent file", () => {
    const p = writeSsh({ host: "h", user: "u", port: 22, key_path: "/nonexistent/key", remote_repo_root: "/r" });
    expect(() => loadSSHConfig(p)).toThrow(/key/);
  });
});
