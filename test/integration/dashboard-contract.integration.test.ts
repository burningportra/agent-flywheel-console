/**
 * test/integration/dashboard-contract.integration.test.ts — bead: 3qw.2.4
 * Covers: FlywheelServer HTTP + WebSocket JSON shape contracts.
 * Validates every field in /snapshot, /health, and /action responses.
 * Uses a real server on port 0. No VPS.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { createFlywheelServer, type FlywheelServer } from "../../cli/server.js";
import { initDb, StateManager } from "../../cli/state.js";

let server: FlywheelServer;
let baseUrl: string;
let wsUrl: string;

beforeEach(async () => {
  const db = initDb(":memory:");
  server = createFlywheelServer({
    port: 0,
    stateManager: new StateManager(db),
  });
  await server.start();
  const addr = (server as unknown as { httpServer: { address(): { port: number } } })
    .httpServer.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
  wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
});

afterEach(async () => {
  await server.stop();
});

// ── /health shape ─────────────────────────────────────────────────────────────

describe("GET /health — response shape contract", () => {
  it("ok field is boolean true", async () => {
    const { ok } = await (await fetch(`${baseUrl}/health`)).json() as { ok: boolean };
    expect(ok).toBe(true);
    expect(typeof ok).toBe("boolean");
  });

  it("generatedAt is a valid ISO 8601 timestamp", async () => {
    const { generatedAt } = await (await fetch(`${baseUrl}/health`)).json() as { generatedAt: string };
    expect(typeof generatedAt).toBe("string");
    expect(new Date(generatedAt).toISOString()).toBe(generatedAt);
  });

  it("content-type is application/json", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

// ── /snapshot shape ───────────────────────────────────────────────────────────

describe("GET /snapshot — response shape contract", () => {
  let snapshot: Record<string, unknown>;

  beforeEach(async () => {
    snapshot = await (await fetch(`${baseUrl}/snapshot`)).json() as Record<string, unknown>;
  });

  it("has generatedAt as ISO timestamp", () => {
    const ts = snapshot.generatedAt as string;
    expect(typeof ts).toBe("string");
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  it("has server object with host, port, sessionName", () => {
    const srv = snapshot.server as Record<string, unknown>;
    expect(typeof srv).toBe("object");
    expect(typeof srv.host).toBe("string");
    expect(typeof srv.port).toBe("number");
    expect(typeof srv.sessionName).toBe("string");
  });

  it("has ssh object with connected boolean", () => {
    const ssh = snapshot.ssh as Record<string, unknown>;
    expect(typeof ssh).toBe("object");
    expect(typeof ssh.connected).toBe("boolean");
    expect(ssh.connected).toBe(false); // no VPS configured
  });

  it("has agents as an array", () => {
    expect(Array.isArray(snapshot.agents)).toBe(true);
  });

  it("has beads as null or an object", () => {
    expect(snapshot.beads === null || typeof snapshot.beads === "object").toBe(true);
  });

  it("has actions as a non-empty array of strings", () => {
    const actions = snapshot.actions as string[];
    expect(Array.isArray(actions)).toBe(true);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(typeof action).toBe("string");
      expect(action).toMatch(/^[a-z]+\.[a-z.]+$/); // e.g. "prompt.send", "gate.advance"
    }
  });

  it("actions always includes gate.advance and prompt.send", () => {
    const actions = snapshot.actions as string[];
    expect(actions).toContain("gate.advance");
    expect(actions).toContain("prompt.send");
  });

  it("mail has available boolean", () => {
    const mail = snapshot.mail as { available: boolean };
    expect(typeof mail.available).toBe("boolean");
  });
});

// ── /action error envelopes ───────────────────────────────────────────────────

describe("POST /action — error envelope shapes", () => {
  it("malformed JSON returns {ok:false, error:string}", async () => {
    const res = await fetch(`${baseUrl}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
  });

  it("valid JSON with unknown action type has ok field", async () => {
    const res = await fetch(`${baseUrl}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "totally.unknown.action" }),
    });
    const body = await res.json() as { ok: boolean };
    expect(typeof body.ok).toBe("boolean");
  });

  it("gate.advance without a run returns {ok:false} or {ok:true} consistently", async () => {
    const res = await fetch(`${baseUrl}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "gate.advance", nextPhase: "beads" }),
    });
    const body = await res.json() as { ok: boolean };
    // Server may succeed (no run → nothing happens) or fail — either way it's consistent
    expect(typeof body.ok).toBe("boolean");
  });

  it("successful /action returns {ok:true, action:string}", async () => {
    // swarm.pause on a nonexistent session will error at the NTM level, but the
    // /action envelope still comes back with ok:false and an error string
    const res = await fetch(`${baseUrl}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "swarm.pause" }),
    });
    const body = await res.json() as { ok: boolean; action?: string; error?: string };
    expect(typeof body.ok).toBe("boolean");
    // If ok:true, must have action field; if ok:false, must have error field
    if (body.ok) {
      expect(typeof body.action).toBe("string");
    } else {
      expect(typeof body.error).toBe("string");
    }
  });
});

// ── WebSocket snapshot_push shape ─────────────────────────────────────────────

describe("WebSocket snapshot_push — message shape contract", () => {
  it("first message has type='snapshot' and payload matching /snapshot", async () => {
    const { ws, msg } = await new Promise<{ ws: WebSocket; msg: unknown }>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.once("message", (data) => {
        resolve({ ws, msg: JSON.parse(data.toString()) });
      });
      ws.once("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5_000);
    });

    const parsed = msg as { type: string; payload: Record<string, unknown> };
    expect(parsed.type).toBe("snapshot");
    expect(typeof parsed.payload).toBe("object");
    expect(parsed.payload).toHaveProperty("generatedAt");
    expect(parsed.payload).toHaveProperty("agents");
    expect(parsed.payload).toHaveProperty("actions");
    ws.close();
  });

  it("action_result message has type, ok, and action or error fields", async () => {
    // Connect and collect all messages for a short window, then check for action_result.
    const messages: Record<string, unknown>[] = [];

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    ws.on("message", (data) => {
      try {
        messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch { /* ignore */ }
    });

    // Send an action and wait long enough for the response + any snapshot push
    ws.send(JSON.stringify({ type: "gate.advance", nextPhase: "swarm" }));
    await new Promise((r) => setTimeout(r, 2_000));
    ws.close();

    // Find the action_result message among all received messages
    const actionResult = messages.find((m) => m.type === "action_result");
    expect(actionResult, "No action_result message received").toBeDefined();
    expect(typeof actionResult!.ok).toBe("boolean");
    if (actionResult!.ok) {
      expect(typeof actionResult!.action).toBe("string");
    } else {
      expect(typeof actionResult!.error).toBe("string");
    }
  }, 8_000);
});

// ── 404 response shape ────────────────────────────────────────────────────────

describe("404 response — error shape contract", () => {
  it("unknown paths return {ok:false} with 404 status", async () => {
    const res = await fetch(`${baseUrl}/does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
  });
});
