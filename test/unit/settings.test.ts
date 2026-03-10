/**
 * test/unit/settings.test.ts
 * Covers: cli/settings.ts — all exported pure helpers + persistSshConfig/loadStoredSshConfig
 * round-trip.
 * Uses real temp files via FLYWHEEL_HOME — no mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  validatePort,
  validateReadablePath,
  asTrimmedString,
  asPort,
  persistSshConfig,
  loadStoredSshConfig,
} from "../../cli/settings.js";
import type { SshConfig } from "../../cli/config.js";
import { tempDir } from "../helpers.js";

// ── validatePort ──────────────────────────────────────────────────────────────

describe("validatePort", () => {
  it("accepts port 22", () => expect(validatePort("22")).toBe(true));
  it("accepts port 1", () => expect(validatePort("1")).toBe(true));
  it("accepts port 65535", () => expect(validatePort("65535")).toBe(true));
  it("rejects port 0", () => expect(validatePort("0")).not.toBe(true));
  it("rejects port 65536", () => expect(validatePort("65536")).not.toBe(true));
  it("rejects non-numeric string", () => expect(validatePort("abc")).not.toBe(true));
  it("rejects float", () => expect(validatePort("22.5")).not.toBe(true));
  it("rejects empty string", () => expect(validatePort("")).not.toBe(true));
  it("rejects negative number", () => expect(validatePort("-1")).not.toBe(true));
  it("trims whitespace before checking", () => expect(validatePort("  22  ")).toBe(true));
});

// ── validateReadablePath ──────────────────────────────────────────────────────

describe("validateReadablePath", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => { dir = tempDir(); });
  afterEach(() => dir.cleanup());

  it("returns true for a file that exists and is readable", () => {
    const path = join(dir.path, "test.key");
    writeFileSync(path, "key content", "utf8");
    expect(validateReadablePath(path)).toBe(true);
  });

  it("returns error string for a non-existent path", () => {
    const result = validateReadablePath("/nonexistent/path/to/key");
    expect(result).not.toBe(true);
    expect(typeof result).toBe("string");
    expect(result as string).toContain("/nonexistent");
  });

  it("returns error for empty string", () => {
    expect(validateReadablePath("")).not.toBe(true);
  });

  it("accepts /dev/null (always readable)", () => {
    expect(validateReadablePath("/dev/null")).toBe(true);
  });

  it("returns error for a file with no read permission", () => {
    const path = join(dir.path, "no-read.key");
    writeFileSync(path, "secret", "utf8");
    chmodSync(path, 0o000);
    const result = validateReadablePath(path);
    if (process.getuid && process.getuid() !== 0) {
      expect(result).not.toBe(true);
    }
    chmodSync(path, 0o600);
  });
});

// ── asTrimmedString ───────────────────────────────────────────────────────────

describe("asTrimmedString", () => {
  it("returns trimmed string for a plain string", () => {
    expect(asTrimmedString("  hello  ")).toBe("hello");
  });
  it("returns undefined for empty string", () => {
    expect(asTrimmedString("")).toBeUndefined();
  });
  it("returns undefined for whitespace-only string", () => {
    expect(asTrimmedString("   ")).toBeUndefined();
  });
  it("returns undefined for null", () => {
    expect(asTrimmedString(null)).toBeUndefined();
  });
  it("returns undefined for undefined", () => {
    expect(asTrimmedString(undefined)).toBeUndefined();
  });
  it("returns undefined for number", () => {
    expect(asTrimmedString(42)).toBeUndefined();
  });
});

// ── asPort ────────────────────────────────────────────────────────────────────

describe("asPort", () => {
  it("returns integer when given a valid integer", () => {
    expect(asPort(22)).toBe(22);
  });
  it("returns integer when given a numeric string", () => {
    expect(asPort("2222")).toBe(2222);
  });
  it("returns undefined for 0", () => {
    expect(asPort(0)).toBeUndefined();
  });
  it("returns undefined for 65536", () => {
    expect(asPort(65536)).toBeUndefined();
  });
  it("returns undefined for a float", () => {
    expect(asPort(22.5)).toBeUndefined();
  });
  it("returns undefined for non-numeric string", () => {
    expect(asPort("abc")).toBeUndefined();
  });
  it("returns undefined for null", () => {
    expect(asPort(null)).toBeUndefined();
  });
});

// ── persistSshConfig + loadStoredSshConfig round-trip ────────────────────────

describe("persistSshConfig + loadStoredSshConfig round-trip", () => {
  let dir: ReturnType<typeof tempDir>;
  let origHome: string | undefined;

  beforeEach(() => {
    dir = tempDir();
    origHome = process.env.FLYWHEEL_HOME;
    process.env.FLYWHEEL_HOME = dir.path;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.FLYWHEEL_HOME;
    else process.env.FLYWHEEL_HOME = origHome;
    dir.cleanup();
  });

  const sshConfigPath = () => join(dir.path, "ssh.yaml");

  const fullConfig: SshConfig = {
    host: "my-vps.example.com",
    user: "ubuntu",
    port: 2222,
    key_path: "~/.ssh/id_ed25519",
    remote_repo_root: "/home/ubuntu/projects",
  };

  it("persists all fields and reloads them exactly", () => {
    persistSshConfig(sshConfigPath(), fullConfig);
    const loaded = loadStoredSshConfig(sshConfigPath());
    expect(loaded.host).toBe("my-vps.example.com");
    expect(loaded.user).toBe("ubuntu");
    expect(loaded.port).toBe(2222);
    expect(loaded.key_path).toBe("~/.ssh/id_ed25519");
    expect(loaded.remote_repo_root).toBe("/home/ubuntu/projects");
  });

  it("key_path is stored raw (tilde not expanded)", () => {
    persistSshConfig(sshConfigPath(), fullConfig);
    const loaded = loadStoredSshConfig(sshConfigPath());
    expect(loaded.key_path).toContain("~");
    expect(loaded.key_path).not.toMatch(/^\/home/);
  });

  it("re-running persistSshConfig overwrites cleanly", () => {
    persistSshConfig(sshConfigPath(), fullConfig);
    persistSshConfig(sshConfigPath(), { ...fullConfig, host: "updated.example.com" });
    const loaded = loadStoredSshConfig(sshConfigPath());
    expect(loaded.host).toBe("updated.example.com");
  });

  it("written file has mode 0o600", () => {
    persistSshConfig(sshConfigPath(), fullConfig);
    const stat = statSync(sshConfigPath());
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("loadStoredSshConfig returns {} when file does not exist", () => {
    const loaded = loadStoredSshConfig(join(dir.path, "nonexistent.yaml"));
    expect(loaded).toEqual({});
  });

  it("loadStoredSshConfig returns {} for corrupted yaml", () => {
    writeFileSync(sshConfigPath(), "{ bad yaml: [", "utf8");
    const loaded = loadStoredSshConfig(sshConfigPath());
    expect(loaded).toEqual({});
  });

  it("loadStoredSshConfig returns partial config with defaults for missing fields", () => {
    persistSshConfig(sshConfigPath(), fullConfig);
    // Manually write a partial config
    writeFileSync(sshConfigPath(), "host: partial.example.com\n", "utf8");
    const loaded = loadStoredSshConfig(sshConfigPath());
    expect(loaded.host).toBe("partial.example.com");
    // Missing fields get defaults from DEFAULT_SSH_CONFIG
    expect(loaded.user).toBe("ubuntu");
    expect(loaded.port).toBe(22);
  });
});
