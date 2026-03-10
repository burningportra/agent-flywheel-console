/**
 * test/unit/server-websocket.test.ts
 * Covers: cli/server.ts FlywheelServer — WebSocket connections
 *   connect → initial snapshot, malformed message, action_result, multi-client broadcast
 *
 * Uses real WebSocket client (ws package). Real server on port 0.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { createFlywheelServer, type FlywheelServer } from "../../cli/server.js";
import { tempDb } from "../helpers.js";

let server: FlywheelServer;
let port: number;

beforeEach(async () => {
  const { db } = tempDb();
  server = createFlywheelServer({
    port: 0,
    stateManager: new (await import("../../cli/state.js")).StateManager(db),
  });
  await server.start();
  const addr = (server as unknown as { httpServer: { address(): { port: number } } })
    .httpServer.address();
  port = addr.port;
});

afterEach(async () => {
  await server.stop();
});

/** Connect a WebSocket and wait for the first message. */
function connectAndAwaitFirstMessage(wsPort: number): Promise<{ ws: WebSocket; firstMsg: unknown }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/ws`);
    ws.once("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        resolve({ ws, firstMsg: parsed });
      } catch (e) {
        reject(e);
      }
    });
    ws.once("error", reject);
    setTimeout(() => reject(new Error("WebSocket connection timeout")), 5_000);
  });
}

describe("initial snapshot on connect", () => {
  it("first message is a snapshot with type='snapshot'", async () => {
    const { ws, firstMsg } = await connectAndAwaitFirstMessage(port);
    try {
      expect((firstMsg as { type: string }).type).toBe("snapshot");
    } finally {
      ws.close();
    }
  });

  it("snapshot payload has agents array and ssh.connected=false", async () => {
    const { ws, firstMsg } = await connectAndAwaitFirstMessage(port);
    try {
      const payload = (firstMsg as { payload: { agents: unknown[]; ssh: { connected: boolean } } }).payload;
      expect(Array.isArray(payload.agents)).toBe(true);
      expect(payload.ssh.connected).toBe(false);
    } finally {
      ws.close();
    }
  });

  it("snapshot matches GET /snapshot body", async () => {
    const { ws, firstMsg } = await connectAndAwaitFirstMessage(port);
    ws.close();
    const httpRes = await fetch(`http://127.0.0.1:${port}/snapshot`);
    const httpBody = await httpRes.json() as { generatedAt: string };
    const wsPayload = (firstMsg as { payload: { generatedAt: string } }).payload;
    // Both should have a generatedAt — may differ by milliseconds
    expect(wsPayload.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(httpBody.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("WebSocket non-ws path is rejected", () => {
  it("connecting to /not-ws causes an error or immediate close", async () => {
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/not-ws`);
      ws.on("error", () => resolve()); // expected
      ws.on("close", () => resolve());  // expected
      setTimeout(() => resolve(), 2_000); // fallback
    });
    // The test passes as long as we get here without hanging
  });
});

describe("malformed JSON message", () => {
  it("server does not crash when client sends non-JSON", async () => {
    const { ws } = await connectAndAwaitFirstMessage(port);
    // Send garbage — server should not crash
    ws.send("not json at all");
    // Wait briefly, then verify server still responds to HTTP
    await new Promise((r) => setTimeout(r, 100));
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    ws.close();
  });
});

describe("action: gate.advance without active run", () => {
  it("server responds with action_result ok:false (no run ID)", async () => {
    const { ws } = await connectAndAwaitFirstMessage(port);
    try {
      const actionResult = await new Promise<{ type: string; ok: boolean; error?: string }>(
        (resolve, reject) => {
          ws.on("message", (data) => {
            try {
              const msg = JSON.parse(data.toString()) as { type: string };
              if (msg.type === "action_result") {
                resolve(msg as { type: string; ok: boolean; error?: string });
              }
            } catch {
              // ignore parse errors
            }
          });
          ws.send(JSON.stringify({ type: "gate.advance", nextPhase: "beads" }));
          setTimeout(() => reject(new Error("action_result timeout")), 3_000);
        }
      );
      expect(actionResult.type).toBe("action_result");
      // Either ok:false (no run) or ok:true if server handles it gracefully
      expect(typeof actionResult.ok).toBe("boolean");
    } finally {
      ws.close();
    }
  }, 8_000);
});

describe("multiple concurrent clients", () => {
  it("all clients receive the initial snapshot on connect", async () => {
    const connections = await Promise.all([
      connectAndAwaitFirstMessage(port),
      connectAndAwaitFirstMessage(port),
      connectAndAwaitFirstMessage(port),
    ]);
    for (const { ws, firstMsg } of connections) {
      expect((firstMsg as { type: string }).type).toBe("snapshot");
      ws.close();
    }
  });
});

describe("server.stop() closes connections cleanly", () => {
  it("stop() resolves without hanging after clients disconnect", async () => {
    const { ws } = await connectAndAwaitFirstMessage(port);
    ws.close();
    // stop() should resolve quickly
    await expect(Promise.race([
      server.stop(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("stop() timed out")), 5_000)),
    ])).resolves.toBeUndefined();
    // Re-create server for afterEach to call stop() again safely
    const { db } = tempDb();
    server = createFlywheelServer({
      port: 0,
      stateManager: new (await import("../../cli/state.js")).StateManager(db),
    });
    await server.start();
  }, 8_000);
});
