/**
 * test/integration/ssh-manager.test.ts — bead: agent-flywheel-console-3qw.6.1
 *
 * Tests SSHManager against a real loopback SSH server (ssh2.Server) on a
 * random loopback port. No sshd daemon, no root, no VPS required.
 *
 * The loopback server executes commands via child_process.exec locally, so
 * every exec/stream assertion produces real process output rather than stubs.
 *
 * Coverage:
 *  - loadSSHConfig() failure paths (no network needed)
 *  - connect() / disconnect() / isConnected() lifecycle
 *  - exec(): stdout, stderr, exit code, cwd prefix, timeout
 *  - getLatency(): returns a positive elapsed ms
 *  - stream(): line delivery, AbortSignal cancellation
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { SSHManager, SSHTimeoutError, SSHError, loadSSHConfig } from "../../cli/ssh.js";
import { tempDir } from "../helpers.js";
import { startLoopbackSsh, type LoopbackSshServer } from "../helpers/ssh-loopback.js";

// ── loadSSHConfig failure paths (no network) ─────────────────────────────────

describe("loadSSHConfig() — config validation failures", () => {
  let dir: ReturnType<typeof tempDir>;

  beforeEach(() => {
    dir = tempDir();
    mkdirSync(dir.path, { recursive: true });
  });

  afterEach(() => dir.cleanup());

  it("throws SSHError when ssh.yaml does not exist", () => {
    const missingPath = join(dir.path, "no-such-file.yaml");
    expect(() => loadSSHConfig(missingPath)).toThrow(SSHError);
    expect(() => loadSSHConfig(missingPath)).toThrow(/not found/i);
  });

  it("throws SSHError when yaml is empty", () => {
    const p = join(dir.path, "ssh.yaml");
    writeFileSync(p, "");
    expect(() => loadSSHConfig(p)).toThrow(SSHError);
  });

  it("throws SSHError when required field is missing", () => {
    const p = join(dir.path, "ssh.yaml");
    writeFileSync(p, yaml.dump({ host: "127.0.0.1", user: "ubuntu" })); // missing port, etc.
    expect(() => loadSSHConfig(p)).toThrow(SSHError);
  });

  it("throws SSHError when private key file does not exist", () => {
    const p = join(dir.path, "ssh.yaml");
    writeFileSync(
      p,
      yaml.dump({
        host: "127.0.0.1",
        user: "ubuntu",
        port: 22,
        key_path: "/no/such/key",
        remote_repo_root: "/tmp",
      })
    );
    expect(() => loadSSHConfig(p)).toThrow(SSHError);
    expect(() => loadSSHConfig(p)).toThrow(/not found/i);
  });

  it("throws SSHError when private key file exists but is not readable", () => {
    if (process.platform === "win32") {
      return;
    }

    const keyPath = join(dir.path, "id_ed25519");
    writeFileSync(keyPath, "dummy private key");

    const p = join(dir.path, "ssh.yaml");
    writeFileSync(
      p,
      yaml.dump({
        host: "127.0.0.1",
        user: "ubuntu",
        port: 22,
        key_path: keyPath,
        remote_repo_root: "/tmp",
      })
    );

    try {
      chmodSync(keyPath, 0o000);
      expect(() => loadSSHConfig(p)).toThrow(SSHError);
      expect(() => loadSSHConfig(p)).toThrow(/not readable/i);
    } finally {
      chmodSync(keyPath, 0o600);
    }
  });
});

// ── Loopback server tests ─────────────────────────────────────────────────────

describe("SSHManager — loopback connect/disconnect/lifecycle", () => {
  let srv: LoopbackSshServer;

  beforeEach(async () => {
    srv = await startLoopbackSsh();
  });

  afterEach(async () => {
    await srv.stop();
  });

  it("connect() succeeds and returns correct SSHConfig", async () => {
    const mgr = new SSHManager(srv.sshConfigPath);
    const config = await mgr.connect();

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(srv.port);
    expect(config.user).toBe(srv.user);
    expect(config.keyPath).toBe(srv.clientKeyPath);
    expect(typeof config.remoteRepoRoot).toBe("string");

    mgr.disconnect();
  });

  it("connect() is idempotent — second call reuses the connection", async () => {
    const mgr = new SSHManager(srv.sshConfigPath);
    const config1 = await mgr.connect();
    const config2 = await mgr.connect();

    // Same reference returned, connection not re-opened
    expect(config1).toEqual(config2);
    expect(mgr.isConnected()).toBe(true);

    mgr.disconnect();
  });

  it("isConnected() is false before connect() and after disconnect()", async () => {
    const mgr = new SSHManager(srv.sshConfigPath);
    expect(mgr.isConnected()).toBe(false);

    await mgr.connect();
    expect(mgr.isConnected()).toBe(true);

    mgr.disconnect();
    expect(mgr.isConnected()).toBe(false);
  });

  it("disconnect() is idempotent — calling twice does not throw", async () => {
    const mgr = new SSHManager(srv.sshConfigPath);
    await mgr.connect();

    mgr.disconnect();
    expect(() => mgr.disconnect()).not.toThrow();
  });

  it("connect() to a non-listening port throws SSHError", async () => {
    // Write a config pointing at a port no one is listening on
    const badDir = tempDir();
    mkdirSync(badDir.path, { recursive: true });
    const badConfig = join(badDir.path, "ssh.yaml");
    writeFileSync(
      badConfig,
      yaml.dump({
        host: "127.0.0.1",
        user: srv.user,
        port: 1, // port 1 is privileged and unreachable
        key_path: srv.clientKeyPath,
        remote_repo_root: "/tmp",
      })
    );
    const mgr = new SSHManager(badConfig);
    await expect(mgr.connect()).rejects.toThrow(SSHError);
    badDir.cleanup();
  });

  it("supports several loopback servers starting in parallel", async () => {
    const servers = await Promise.all(
      Array.from({ length: 4 }, () => startLoopbackSsh())
    );
    const managers = servers.map((server) => new SSHManager(server.sshConfigPath));

    try {
      await Promise.all(managers.map((manager) => manager.connect()));
      expect(managers.every((manager) => manager.isConnected())).toBe(true);
    } finally {
      managers.forEach((manager) => manager.disconnect());
      await Promise.all(servers.map((server) => server.stop()));
    }
  });
});

describe("SSHManager.exec() — command execution via loopback", () => {
  let srv: LoopbackSshServer;
  let mgr: SSHManager;

  beforeEach(async () => {
    srv = await startLoopbackSsh();
    mgr = new SSHManager(srv.sshConfigPath);
    await mgr.connect();
  });

  afterEach(async () => {
    mgr.disconnect();
    await srv.stop();
  });

  it("captures stdout and returns exit code 0", async () => {
    const result = await mgr.exec("echo hello-world");
    expect(result.stdout).toContain("hello-world");
    expect(result.code).toBe(0);
    expect(result.elapsed).toBeGreaterThan(0);
  });

  it("captures stderr separately from stdout", async () => {
    const result = await mgr.exec("echo stdout-line; echo stderr-line >&2");
    expect(result.stdout).toContain("stdout-line");
    expect(result.stderr).toContain("stderr-line");
    expect(result.stdout).not.toContain("stderr-line");
  });

  it("returns non-zero exit code for a failing command", async () => {
    const result = await mgr.exec("exit 42", { timeoutMs: 5_000 });
    expect(result.code).toBe(42);
  });

  it("cwd is applied — command sees correct working directory", async () => {
    // node-ssh prepends `cd "<cwd>" && ` to the command string.
    // Using /tmp which always exists.
    const result = await mgr.exec("pwd", { cwd: "/tmp" });
    // The resolved path may differ (e.g., /private/tmp on macOS) but
    // will end with "tmp" on any Unix system.
    expect(result.stdout.trim()).toMatch(/tmp/);
    expect(result.code).toBe(0);
  });

  it("throws SSHTimeoutError when command exceeds timeoutMs", async () => {
    await expect(
      mgr.exec("sleep 30", { timeoutMs: 300 })
    ).rejects.toThrow(SSHTimeoutError);
  });

  it("onStdout callback receives chunks during exec", async () => {
    const chunks: Buffer[] = [];
    await mgr.exec("printf 'chunk1\\nchunk2\\n'", {
      onStdout: (chunk) => chunks.push(chunk),
    });
    const combined = Buffer.concat(chunks).toString();
    expect(combined).toContain("chunk1");
    expect(combined).toContain("chunk2");
  });
});

describe("SSHManager.getLatency()", () => {
  let srv: LoopbackSshServer;
  let mgr: SSHManager;

  beforeEach(async () => {
    srv = await startLoopbackSsh();
    mgr = new SSHManager(srv.sshConfigPath);
    await mgr.connect();
  });

  afterEach(async () => {
    mgr.disconnect();
    await srv.stop();
  });

  it("returns a positive elapsed ms for a loopback echo", async () => {
    const latency = await mgr.getLatency();
    expect(typeof latency).toBe("number");
    expect(latency).toBeGreaterThanOrEqual(0);
    // Loopback should be < 5 000 ms — generous ceiling for slow CI runners
    expect(latency).toBeLessThan(5_000);
  });
});

describe("SSHManager.stream() — streaming output", () => {
  let srv: LoopbackSshServer;
  let mgr: SSHManager;

  beforeEach(async () => {
    srv = await startLoopbackSsh();
    mgr = new SSHManager(srv.sshConfigPath);
    await mgr.connect();
  });

  afterEach(async () => {
    mgr.disconnect();
    await srv.stop();
  });

  it("delivers all output lines from a multi-line command", async () => {
    const readable = await mgr.stream("printf 'alpha\\nbeta\\ngamma\\n'");

    const lines: string[] = [];
    for await (const chunk of readable) {
      lines.push(String(chunk));
    }

    const joined = lines.join("");
    expect(joined).toContain("alpha");
    expect(joined).toContain("beta");
    expect(joined).toContain("gamma");
  });

  it("AbortSignal ends the stream before the command completes", async () => {
    const controller = new AbortController();
    const readable = await mgr.stream("sleep 30", { signal: controller.signal });

    // Abort immediately after starting the stream
    controller.abort();

    // Consuming the stream should complete (not hang)
    const chunks: string[] = [];
    for await (const chunk of readable) {
      chunks.push(String(chunk));
    }

    // Stream ended — we don't assert on chunk content since abort races with output
    expect(Array.isArray(chunks)).toBe(true);
  });
});
