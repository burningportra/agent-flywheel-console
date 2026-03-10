/**
 * test/integration/ntm-bridge-runtime.test.ts — bead: agent-flywheel-console-3qw.6.3
 *
 * Tests NtmBridge across real subprocess boundaries: the loopback SSH server
 * executes a fake `ntm` shell script that returns correct JSON shapes.
 * This validates NtmBridge's JSON parsing, status derivation (idle/stuck/active),
 * error classification, and the unsupported-resume guard.
 *
 * The fake ntm script is created via createFakeNtmBin() and injected into
 * the server's PATH via the extraPath option of startLoopbackSsh().
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SSHManager } from "../../cli/ssh.js";
import { RemoteCommandRunner } from "../../cli/remote.js";
import { NtmBridge, NtmBridgeError } from "../../cli/ntm-bridge.js";
import {
  startLoopbackSsh,
  createFakeNtmBin,
  type LoopbackSshServer,
} from "../helpers/ssh-loopback.js";

// ── Shared lifecycle helpers ──────────────────────────────────────────────────

function buildStack(srv: LoopbackSshServer): {
  ssh: SSHManager;
  runner: RemoteCommandRunner;
  ntm: NtmBridge;
} {
  const ssh = new SSHManager(srv.sshConfigPath);
  const runner = new RemoteCommandRunner(ssh);
  const ntm = new NtmBridge(runner);
  return { ssh, runner, ntm };
}

// ── NtmBridge.list() ─────────────────────────────────────────────────────────

describe("NtmBridge.list() — session listing and JSON parsing", () => {
  let srv: LoopbackSshServer;
  let ssh: SSHManager;
  let ntm: NtmBridge;

  beforeEach(async () => {
    const fakeBin = createFakeNtmBin();
    srv = await startLoopbackSsh({ extraPath: [fakeBin] });
    const stack = buildStack(srv);
    ssh = stack.ssh;
    ntm = stack.ntm;
    await ssh.connect();
  });

  afterEach(async () => {
    ssh.disconnect();
    await srv.stop();
  });

  it("returns an array of NtmSession objects", async () => {
    const sessions = await ntm.list();
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions).toHaveLength(1);
  });

  it("correctly maps session fields from JSON", async () => {
    const sessions = await ntm.list();
    const session = sessions[0];

    expect(session.name).toBe("test-session");
    expect(typeof session.windows).toBe("number");
    expect(typeof session.paneCount).toBe("number");
    expect(typeof session.attached).toBe("boolean");
    expect(typeof session.agentCounts.claude).toBe("number");
    expect(typeof session.agentCounts.total).toBe("number");
  });

  it("returns empty array when sessions list is empty", async () => {
    // Start a new server with a fake ntm that returns empty sessions
    const emptyBin = mkdtempSync(join(tmpdir(), "flywheel-fake-ntm-empty-"));
    writeFileSync(
      join(emptyBin, "ntm"),
      `#!/bin/sh\necho '{"sessions":[]}'\n`,
      { mode: 0o755 }
    );

    const srv2 = await startLoopbackSsh({ extraPath: [emptyBin] });
    const stack2 = buildStack(srv2);
    await stack2.ssh.connect();

    try {
      const sessions = await stack2.ntm.list();
      expect(sessions).toEqual([]);
    } finally {
      stack2.ssh.disconnect();
      await srv2.stop();
    }
  });
});

// ── NtmBridge.activity() ─────────────────────────────────────────────────────

describe("NtmBridge.activity() — pane status derivation", () => {
  it("active pane → status 'active'", async () => {
    const statusJson = {
      exists: true,
      session: "s",
      generated_at: new Date().toISOString(),
      panes: [{ index: 0, title: "work", type: "claude", active: true, command: "claude" }],
    };
    const fakeBin = createFakeNtmBin({ statusJson });
    const srv = await startLoopbackSsh({ extraPath: [fakeBin] });
    const { ssh, ntm } = buildStack(srv);
    await ssh.connect();

    try {
      const agents = await ntm.activity("s");
      expect(agents).toHaveLength(1);
      expect(agents[0].status).toBe("active");
      expect(agents[0].pane).toBe(0);
    } finally {
      ssh.disconnect();
      await srv.stop();
    }
  });

  it("idle pane that appears unchanged for 3+ polls → status 'stuck'", async () => {
    // Same signature (title, command, active=false) across all polls → stuck
    const statusJson = {
      exists: true,
      session: "s",
      generated_at: new Date().toISOString(),
      panes: [
        { index: 0, title: "same-title", type: "claude", active: false, command: "claude" },
      ],
    };
    const fakeBin = createFakeNtmBin({ statusJson });
    const srv = await startLoopbackSsh({ extraPath: [fakeBin] });
    const { ssh, ntm } = buildStack(srv);
    await ssh.connect();

    try {
      // Poll 3 times with identical response — should become "stuck" on 3rd
      await ntm.activity("s"); // unchangedCount = 1 → idle
      await ntm.activity("s"); // unchangedCount = 2 → idle
      const third = await ntm.activity("s"); // unchangedCount = 3 → stuck
      expect(third[0].status).toBe("stuck");
    } finally {
      ssh.disconnect();
      await srv.stop();
    }
  });

  it("returns empty array when session does not exist", async () => {
    const noExistBin = mkdtempSync(join(tmpdir(), "flywheel-fake-ntm-noexist-"));
    writeFileSync(
      join(noExistBin, "ntm"),
      `#!/bin/sh\necho '{"exists":false,"session":"s","panes":null}'\n`,
      { mode: 0o755 }
    );
    const srv = await startLoopbackSsh({ extraPath: [noExistBin] });
    const { ssh, ntm } = buildStack(srv);
    await ssh.connect();

    try {
      const agents = await ntm.activity("s");
      expect(agents).toEqual([]);
    } finally {
      ssh.disconnect();
      await srv.stop();
    }
  });
});

// ── NtmBridge.pause() ────────────────────────────────────────────────────────

describe("NtmBridge.pause() — interrupt command", () => {
  let srv: LoopbackSshServer;
  let ssh: SSHManager;
  let ntm: NtmBridge;

  beforeEach(async () => {
    const fakeBin = createFakeNtmBin();
    srv = await startLoopbackSsh({ extraPath: [fakeBin] });
    const stack = buildStack(srv);
    ssh = stack.ssh;
    ntm = stack.ntm;
    await ssh.connect();
  });

  afterEach(async () => {
    ssh.disconnect();
    await srv.stop();
  });

  it("returns NtmPauseResult with correct session name", async () => {
    const result = await ntm.pause("my-session");
    expect(result.session).toBe("my-session");
    expect(result.raw).toBeDefined();
  });
});

// ── NtmBridge.resume() ───────────────────────────────────────────────────────

describe("NtmBridge.resume() — unsupported guard", () => {
  it("throws NtmBridgeError unconditionally", async () => {
    // resume() never calls the remote — test it without starting a server
    const fakeSsh = {} as SSHManager;
    const fakeRunner = {} as RemoteCommandRunner;
    const ntm = new NtmBridge(fakeRunner);

    await expect(ntm.resume("any-session")).rejects.toThrow(NtmBridgeError);
    await expect(ntm.resume("any-session")).rejects.toThrow(/resume/i);
  });
});

// ── NtmBridge error handling ──────────────────────────────────────────────────

describe("NtmBridge — JSON parsing and transport error handling", () => {
  it("throws NtmBridgeError when ntm outputs empty stdout", async () => {
    const emptyBin = mkdtempSync(join(tmpdir(), "flywheel-fake-ntm-empty2-"));
    writeFileSync(
      join(emptyBin, "ntm"),
      `#!/bin/sh\n# outputs nothing\n`,
      { mode: 0o755 }
    );
    const srv = await startLoopbackSsh({ extraPath: [emptyBin] });
    const { ssh, ntm } = buildStack(srv);
    await ssh.connect();

    try {
      await expect(ntm.list()).rejects.toThrow(NtmBridgeError);
      await expect(ntm.list()).rejects.toThrow(/no JSON output/i);
    } finally {
      ssh.disconnect();
      await srv.stop();
    }
  });

  it("throws NtmBridgeError when ntm outputs malformed JSON", async () => {
    const badBin = mkdtempSync(join(tmpdir(), "flywheel-fake-ntm-badjson-"));
    writeFileSync(
      join(badBin, "ntm"),
      `#!/bin/sh\necho 'this is not json at all'\n`,
      { mode: 0o755 }
    );
    const srv = await startLoopbackSsh({ extraPath: [badBin] });
    const { ssh, ntm } = buildStack(srv);
    await ssh.connect();

    try {
      await expect(ntm.list()).rejects.toThrow(NtmBridgeError);
      await expect(ntm.list()).rejects.toThrow(/parse/i);
    } finally {
      ssh.disconnect();
      await srv.stop();
    }
  });

  it("throws NtmBridgeError when ntm binary is not found in PATH", async () => {
    // Restrict server PATH to /usr/bin:/bin only — no fake ntm injected,
    // and ntm (even if installed on the host) is excluded from the server PATH.
    const srv = await startLoopbackSsh({ extraPath: [], restrictPath: true });
    const { ssh, ntm } = buildStack(srv);
    await ssh.connect();

    try {
      // `ntm` is not on the restricted PATH → command fails → NtmBridgeError
      await expect(ntm.list()).rejects.toThrow(NtmBridgeError);
    } finally {
      ssh.disconnect();
      await srv.stop();
    }
  });
});

// ── supportsResume() ──────────────────────────────────────────────────────────

describe("NtmBridge.supportsResume()", () => {
  it("returns false", () => {
    const ntm = new NtmBridge({} as RemoteCommandRunner);
    expect(ntm.supportsResume()).toBe(false);
  });
});
