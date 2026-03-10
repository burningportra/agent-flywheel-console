import { createInterface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join, resolve } from "node:path";

import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";

import { tempDir } from "../helpers.js";

interface TranscriptEntry {
  at: string;
  step: string;
  request?: string;
  status?: number;
  body?: string;
  note?: string;
}

interface ServeProcess {
  child: ChildProcessWithoutNullStreams;
  port: number;
  stdoutLines: string[];
  stderrLines: string[];
  stop: () => Promise<void>;
}

const CLI = resolve("dist/cli.js");
const READY_PATTERN = /running at http:\/\/127\.0\.0\.1:(\d+)/i;

function nowIso(): string {
  return new Date().toISOString();
}

function trimForLog(value: string, max = 300): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForServerReady(
  transcript: TranscriptEntry[],
  env: Record<string, string>,
  timeoutMs = 15_000
): Promise<ServeProcess> {
  const child = spawn("node", [CLI, "serve", "--port", "0"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const stdoutRl = createInterface({ input: child.stdout });
  const stderrRl = createInterface({ input: child.stderr });

  let settled = false;
  const cleanupReaders = (): void => {
    stdoutRl.close();
    stderrRl.close();
  };

  const port = await new Promise<number>((resolvePort, rejectPort) => {
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanupReaders();
      rejectPort(
        new Error(
          `Timed out waiting for serve readiness (${timeoutMs}ms). stdout=${JSON.stringify(stdoutLines)} stderr=${JSON.stringify(stderrLines)}`
        )
      );
    }, timeoutMs);

    const fail = (reason: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanupReaders();
      rejectPort(new Error(reason));
    };

    stdoutRl.on("line", (line) => {
      stdoutLines.push(line);
      transcript.push({
        at: nowIso(),
        step: "serve.stdout",
        note: line,
      });
      const match = line.match(READY_PATTERN);
      if (match) {
        const parsed = Number.parseInt(match[1] ?? "", 10);
        if (!Number.isInteger(parsed)) {
          fail(`Could not parse serve port from line: ${line}`);
          return;
        }
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cleanupReaders();
        resolvePort(parsed);
      }
    });

    stderrRl.on("line", (line) => {
      stderrLines.push(line);
      transcript.push({
        at: nowIso(),
        step: "serve.stderr",
        note: line,
      });
    });

    child.once("error", (error) => {
      fail(`Failed to start serve process: ${toMessage(error)}`);
    });

    child.once("exit", (code, signal) => {
      if (settled) return;
      fail(
        `serve exited before readiness (code=${String(code)} signal=${String(signal)}). stdout=${JSON.stringify(stdoutLines)} stderr=${JSON.stringify(stderrLines)}`
      );
    });
  });

  const stop = async (): Promise<void> => {
    if (child.killed || child.exitCode !== null) {
      return;
    }
    child.kill("SIGINT");

    await new Promise<void>((resolveStop) => {
      const forceKill = setTimeout(() => {
        if (!child.killed && child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 5_000);

      child.once("exit", () => {
        clearTimeout(forceKill);
        resolveStop();
      });
    });
  };

  return { child, port, stdoutLines, stderrLines, stop };
}

async function readFirstWsMessage(url: string, timeoutMs = 5_000): Promise<string> {
  return await new Promise<string>((resolveMessage, rejectMessage) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.terminate();
      rejectMessage(new Error(`WebSocket first-message timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    ws.once("message", (data) => {
      clearTimeout(timeout);
      const message = data.toString("utf8");
      ws.close();
      resolveMessage(message);
    });

    ws.once("error", (error) => {
      clearTimeout(timeout);
      rejectMessage(error);
    });
  });
}

describe("CLI integration: flywheel serve loopback", () => {
  it("handles health/snapshot/assets/ws + malformed and oversized actions with transcript logging", async () => {
    const transcript: TranscriptEntry[] = [];
    const tmp = tempDir();
    const env = {
      FLYWHEEL_HOME: tmp.path,
      FLYWHEEL_STATE_DB: join(tmp.path, "state.db"),
    };

    let serve: ServeProcess | null = null;
    try {
      transcript.push({
        at: nowIso(),
        step: "spawn",
        request: "node dist/cli.js serve --port 0",
      });
      serve = await waitForServerReady(transcript, env);
      const baseUrl = `http://127.0.0.1:${serve.port}`;

      transcript.push({
        at: nowIso(),
        step: "ready",
        note: `server listening on ${baseUrl}`,
      });

      const healthRes = await fetch(`${baseUrl}/health`);
      const healthRaw = await healthRes.text();
      transcript.push({
        at: nowIso(),
        step: "health",
        request: "GET /health",
        status: healthRes.status,
        body: trimForLog(healthRaw),
      });
      expect(healthRes.status).toBe(200);
      const health = JSON.parse(healthRaw) as { ok: boolean };
      expect(health.ok).toBe(true);

      const snapshotRes = await fetch(`${baseUrl}/snapshot`);
      const snapshotRaw = await snapshotRes.text();
      transcript.push({
        at: nowIso(),
        step: "snapshot",
        request: "GET /snapshot",
        status: snapshotRes.status,
        body: trimForLog(snapshotRaw),
      });
      expect(snapshotRes.status).toBe(200);
      const snapshot = JSON.parse(snapshotRaw) as { server?: { port?: number } };
      expect(snapshot.server?.port).toBe(serve.port);

      for (const path of ["/", "/main.js", "/style.css"]) {
        const response = await fetch(`${baseUrl}${path}`);
        const body = await response.text();
        transcript.push({
          at: nowIso(),
          step: "asset",
          request: `GET ${path}`,
          status: response.status,
          body: trimForLog(body),
        });
        expect(response.status).toBe(200);
        expect(body.length).toBeGreaterThan(0);
      }

      const wsRaw = await readFirstWsMessage(`ws://127.0.0.1:${serve.port}/ws`);
      transcript.push({
        at: nowIso(),
        step: "ws-first-message",
        request: "WS /ws",
        body: trimForLog(wsRaw),
      });
      const wsPayload = JSON.parse(wsRaw) as { type?: string };
      expect(wsPayload.type).toBe("snapshot");

      const malformedJsonBody = "{ not valid json";
      const malformedJsonRes = await fetch(`${baseUrl}/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: malformedJsonBody,
      });
      const malformedJsonRaw = await malformedJsonRes.text();
      transcript.push({
        at: nowIso(),
        step: "action-malformed-json",
        request: `POST /action body=${trimForLog(malformedJsonBody)}`,
        status: malformedJsonRes.status,
        body: trimForLog(malformedJsonRaw),
      });
      expect(malformedJsonRes.status).toBe(400);
      const malformedJson = JSON.parse(malformedJsonRaw) as { ok?: boolean; error?: string };
      expect(malformedJson.ok).toBe(false);
      expect(malformedJson.error).toMatch(/parse|json|invalid/i);

      const unknownActionBody = JSON.stringify({ type: "unknown.action" });
      const unknownActionRes = await fetch(`${baseUrl}/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: unknownActionBody,
      });
      const unknownActionRaw = await unknownActionRes.text();
      transcript.push({
        at: nowIso(),
        step: "action-unknown-type",
        request: `POST /action body=${trimForLog(unknownActionBody)}`,
        status: unknownActionRes.status,
        body: trimForLog(unknownActionRaw),
      });
      expect(unknownActionRes.status).toBe(500);
      const unknownAction = JSON.parse(unknownActionRaw) as { ok?: boolean; error?: string };
      expect(unknownAction.ok).toBe(false);
      expect(unknownAction.error).toMatch(/Unhandled dashboard action/i);

      const oversizedBody = "x".repeat(300 * 1024);
      let oversizedStatus: number | null = null;
      let oversizedRaw = "";
      let oversizedError = "";

      try {
        const oversizedRes = await fetch(`${baseUrl}/action`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: oversizedBody,
        });
        oversizedStatus = oversizedRes.status;
        oversizedRaw = await oversizedRes.text();
      } catch (error) {
        oversizedError = toMessage(error);
      }

      transcript.push({
        at: nowIso(),
        step: "action-oversized-body",
        request: `POST /action body=<${oversizedBody.length} bytes>`,
        status: oversizedStatus ?? undefined,
        body: oversizedRaw ? trimForLog(oversizedRaw) : undefined,
        note: oversizedError || undefined,
      });

      expect(oversizedStatus === null || oversizedStatus >= 400).toBe(true);
      if (oversizedStatus !== null) {
        if (oversizedRaw) {
          const oversizedJson = JSON.parse(oversizedRaw) as { ok?: boolean; error?: string };
          expect(oversizedJson.ok).toBe(false);
        }
      } else {
        expect(oversizedError.length).toBeGreaterThan(0);
      }
    } finally {
      if (serve) {
        await serve.stop();
      }
      transcript.push({
        at: nowIso(),
        step: "shutdown",
        note: "serve process stopped",
      });

      console.log("[INTEGRATION][serve-loopback] transcript start");
      for (const entry of transcript) {
        const line = [
          `[${entry.at}]`,
          entry.step,
          entry.request ? `request=${entry.request}` : "",
          typeof entry.status === "number" ? `status=${entry.status}` : "",
          entry.body ? `body=${entry.body}` : "",
          entry.note ? `note=${entry.note}` : "",
        ]
          .filter(Boolean)
          .join(" | ");
        console.log(`[INTEGRATION][serve-loopback] ${line}`);
      }
      console.log("[INTEGRATION][serve-loopback] transcript end");
      tmp.cleanup();
    }
  }, 40_000);
});
