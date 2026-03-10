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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function tempBin(script: string): { binDir: string; cleanup: () => void } {
  const binDir = mkdtempSync(join(tmpdir(), "flywheel-fake-ntm-"));
  writeFileSync(join(binDir, "ntm"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return {
    binDir,
    cleanup: () => { try { rmSync(binDir, { recursive: true, force: true }); } catch { /* best-effort */ } },
  };
}

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
  let cleanupFakeBin: () => void;

  beforeEach(async () => {
    const fakeBin = createFakeNtmBin();
    cleanupFakeBin = fakeBin.cleanup;
    srv = await startLoopbackSsh({ extraPath: [fakeBin.binDir] });
    const stack = buildStack(srv);
    ssh = stack.ssh;
    ntm = stack.ntm;
    await ssh.connect();
  });

  afterEach(async () => {
    ssh.disconnect();
    await srv.stop();
    cleanupFakeBin();
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
    const emptyBin = tempBin(`echo '{"sessions":[]}'`);
    const srv2 = await startLoopbackSsh({ extraPath: [emptyBin.binDir] });
    const stack2 = buildStack(srv2);
    await stack2.ssh.connect();

    try {
      const sessions = await stack2.ntm.list();
      expect(sessions).toEqual([]);
    } finally {
      stack2.ssh.disconnect();
      await srv2.stop();
      emptyBin.cleanup();
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
    const srv = await startLoopbackSsh({ extraPath: [fakeBin.binDir] });
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
      fakeBin.cleanup();
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
    const srv = await startLoopbackSsh({ extraPath: [fakeBin.binDir] });
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
      fakeBin.cleanup();
    }
  });

  it("returns empty array when session does not exist", async () => {
    const noExistBin = tempBin(`echo '{"exists":false,"session":"s","panes":null}'`);
    const srv = await startLoopbackSsh({ extraPath: [noExistBin.binDir] });
    const { ssh, ntm } = buildStack(srv);
    await ssh.connect();

    try {
      const agents = await ntm.activity("s");
      expect(agents).toEqual([]);
    } finally {
      ssh.disconnect();
      await srv.stop();
      noExistBin.cleanup();
    }
  });

  it("clears stale idle snapshots when a session disappears and later returns", async () => {
    const responses = [
      {
        exists: true,
        session: "s",
        generated_at: "2026-01-01T00:00:00Z",
        panes: [{ index: 0, title: "same-title", type: "claude", active: false, command: "claude" }],
      },
      { exists: false, session: "s", panes: null },
      {
        exists: true,
        session: "s",
        generated_at: "2026-01-01T00:00:10Z",
        panes: [{ index: 0, title: "same-title", type: "claude", active: false, command: "claude" }],
      },
    ];

    const ntm = new NtmBridge({
      runRemote: async () => {
        const response = responses.shift();
        if (!response) {
          throw new Error("Unexpected extra runRemote() call in idle snapshot reset test.");
        }
        return {
          stdout: JSON.stringify(response),
          stderr: "",
          exitCode: 0,
          duration: 0,
        };
      },
    } as unknown as RemoteCommandRunner);

    expect((await ntm.activity("s"))[0].status).toBe("idle");
    expect(await ntm.activity("s")).toEqual([]);
    expect((await ntm.activity("s"))[0].status).toBe("idle");
  });
});

// ── NtmBridge.pause() ────────────────────────────────────────────────────────

describe("NtmBridge.pause() — interrupt command", () => {
  let srv: LoopbackSshServer;
  let ssh: SSHManager;
  let ntm: NtmBridge;
  let cleanupFakeBin: () => void;

  beforeEach(async () => {
    const fakeBin = createFakeNtmBin();
    cleanupFakeBin = fakeBin.cleanup;
    srv = await startLoopbackSsh({ extraPath: [fakeBin.binDir] });
    const stack = buildStack(srv);
    ssh = stack.ssh;
    ntm = stack.ntm;
    await ssh.connect();
  });

  afterEach(async () => {
    ssh.disconnect();
    await srv.stop();
    cleanupFakeBin();
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
    // resume() never calls the remote — no server needed
    const ntm = new NtmBridge({} as RemoteCommandRunner);

    await expect(ntm.resume("any-session")).rejects.toThrow(NtmBridgeError);
    await expect(ntm.resume("any-session")).rejects.toThrow(/resume/i);
  });
});

// ── NtmBridge error handling ──────────────────────────────────────────────────

describe("NtmBridge — JSON parsing and transport error handling", () => {
  it("throws NtmBridgeError when ntm outputs empty stdout", async () => {
    const emptyBin = tempBin(`# outputs nothing — no echo`);
    const srv = await startLoopbackSsh({ extraPath: [emptyBin.binDir] });
    const { ssh, ntm } = buildStack(srv);
    await ssh.connect();

    try {
      await expect(ntm.list()).rejects.toThrow(NtmBridgeError);
      await expect(ntm.list()).rejects.toThrow(/no JSON output/i);
    } finally {
      ssh.disconnect();
      await srv.stop();
      emptyBin.cleanup();
    }
  });

  it("throws NtmBridgeError when ntm outputs malformed JSON", async () => {
    const badBin = tempBin(`echo 'this is not json at all'`);
    const srv = await startLoopbackSsh({ extraPath: [badBin.binDir] });
    const { ssh, ntm } = buildStack(srv);
    await ssh.connect();

    try {
      await expect(ntm.list()).rejects.toThrow(NtmBridgeError);
      await expect(ntm.list()).rejects.toThrow(/parse/i);
    } finally {
      ssh.disconnect();
      await srv.stop();
      badBin.cleanup();
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
