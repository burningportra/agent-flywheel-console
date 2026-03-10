import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { createFlywheelServer, type FlywheelServer } from "../../cli/server.js";
import { initDb, StateManager } from "../../cli/state.js";

let server: FlywheelServer;
let baseUrl: string;
let wsUrl: string;

beforeEach(async () => {
  const db = initDb(":memory:");
  const state = new StateManager(db);
  const runId = state.createFlywheelRun("server-contract-project", "plan");

  server = createFlywheelServer({
    port: 0,
    stateManager: state,
    runId,
  });
  await server.start();

  const address = (server as unknown as {
    httpServer: { address(): { port: number } };
  }).httpServer.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  wsUrl = `ws://127.0.0.1:${address.port}/ws`;
});

afterEach(async () => {
  await server.stop();
});

function assertIsoString(value: unknown): void {
  expect(typeof value).toBe("string");
  expect(new Date(value as string).toISOString()).toBe(value);
}

describe("FlywheelServer JSON contract", () => {
  it("GET /snapshot returns the expected DashboardSnapshot envelope", async () => {
    const response = await fetch(`${baseUrl}/snapshot`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = await response.json() as Record<string, unknown>;
    assertIsoString(body.generatedAt);

    const serverInfo = body.server as Record<string, unknown>;
    expect(serverInfo.host).toBe("127.0.0.1");
    expect(typeof serverInfo.port).toBe("number");
    expect(typeof serverInfo.sessionName).toBe("string");
    expect(
      serverInfo.remoteProjectPath === undefined ||
        typeof serverInfo.remoteProjectPath === "string"
    ).toBe(true);

    const ssh = body.ssh as Record<string, unknown>;
    expect(typeof ssh.connected).toBe("boolean");
    expect(
      ssh.host === undefined || typeof ssh.host === "string"
    ).toBe(true);

    const run = body.run as Record<string, unknown>;
    expect(typeof run.id).toBe("string");
    expect(run.projectName).toBe("server-contract-project");
    expect(run.phase).toBe("plan");
    assertIsoString(run.startedAt);
    expect(run.gatePassedAt === null || typeof run.gatePassedAt === "string").toBe(true);
    expect(run.checkpointSha === null || typeof run.checkpointSha === "string").toBe(true);

    expect(Array.isArray(body.agents)).toBe(true);
    expect(body.beads === null || typeof body.beads === "object").toBe(true);
    expect(body.vpsHealth === null || typeof body.vpsHealth === "object").toBe(true);

    const mail = body.mail as Record<string, unknown>;
    expect(typeof mail.available).toBe("boolean");
    expect(mail.reason === undefined || typeof mail.reason === "string").toBe(true);

    expect(Array.isArray(body.prompts)).toBe(true);
    for (const prompt of body.prompts as Array<Record<string, unknown>>) {
      expect(typeof prompt.name).toBe("string");
      expect(typeof prompt.phase).toBe("string");
      expect(typeof prompt.model).toBe("string");
      expect(typeof prompt.effort).toBe("string");
    }

    const guidance = body.guidance as Record<string, unknown>;
    expect(typeof guidance.title).toBe("string");
    expect(typeof guidance.detail).toBe("string");

    expect(Array.isArray(body.actions)).toBe(true);
    for (const action of body.actions as unknown[]) {
      expect(typeof action).toBe("string");
    }

    const actionStates = body.actionStates as Record<
      string,
      { enabled?: unknown; reason?: unknown }
    >;
    for (const [actionName, actionState] of Object.entries(actionStates)) {
      expect(typeof actionName).toBe("string");
      expect(typeof actionState.enabled).toBe("boolean");
      expect(
        actionState.reason === undefined || typeof actionState.reason === "string"
      ).toBe(true);
    }
  });

  it("POST /action returns a consistent success envelope", async () => {
    const response = await fetch(`${baseUrl}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "gate.advance", nextPhase: "beads" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.action).toBe("gate.advance");

    const payload = body.payload as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(typeof payload.runId).toBe("string");
    expect(payload.nextPhase).toBe("beads");
  });

  it("POST /action returns {ok:false,error:string} for malformed JSON", async () => {
    const response = await fetch(`${baseUrl}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ definitely not json",
    });

    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
  });

  it("POST /action returns {ok:false,error:string} for oversized bodies", async () => {
    try {
      const response = await fetch(`${baseUrl}/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "prompt.send", padding: "x".repeat(300_000) }),
      });

      expect(response.status).toBe(500);
      const body = await response.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe("string");
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect(String(error)).toMatch(/ECONNRESET|fetch failed/i);
    }
  });

  it("WebSocket sends snapshot and action_result messages with the expected shape", async () => {
    const ws = new WebSocket(wsUrl);
    const messages: Array<Record<string, unknown>> = [];

    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    ws.on("message", (data) => {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });

    ws.send(JSON.stringify({ type: "gate.advance", nextPhase: "beads" }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    ws.close();

    const snapshotMessage = messages.find((message) => message.type === "snapshot");
    expect(snapshotMessage).toBeDefined();
    const snapshotPayload = snapshotMessage?.payload as Record<string, unknown>;
    assertIsoString(snapshotPayload.generatedAt);
    expect(Array.isArray(snapshotPayload.actions)).toBe(true);

    const actionResult = messages.find((message) => message.type === "action_result");
    expect(actionResult).toBeDefined();
    expect(actionResult?.ok).toBe(true);
    expect(actionResult?.action).toBe("gate.advance");

    const payload = actionResult?.payload as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(payload.nextPhase).toBe("beads");
  });
});
