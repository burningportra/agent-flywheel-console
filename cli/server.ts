import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocketServer, WebSocket } from "ws";

import { getPrompt, loadPrompts, substituteVariables } from "./prompts.js";
import { NtmBridge, type AgentStatus } from "./ntm-bridge.js";
import { RemoteCommandRunner } from "./remote.js";
import { SSHManager, loadSSHConfig } from "./ssh.js";
import { StateManager, initDb, type FlywheelRun, type Phase } from "./state.js";
import { shellQuote } from "./utils.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4200;

const AGENT_POLL_MS = 10_000;
const BEAD_POLL_MS = 20_000;
const VPS_HEALTH_POLL_MS = 45_000;
const MAIL_POLL_MS = 10_000;

export type ActionName = "prompt.send" | "swarm.pause" | "swarm.resume" | "gate.advance";

interface FlywheelServerOptions {
  host?: string;
  port?: number;
  sessionName?: string;
  remoteProjectPath?: string;
  runId?: string;
  sshManager?: SSHManager;
  remoteRunner?: RemoteCommandRunner;
  ntmBridge?: NtmBridge;
  stateManager?: StateManager;
  promptVariables?: Record<string, string>;
}

export interface BeadSummary {
  total: number;
  open: number;
  inProgress: number;
  closed: number;
  blocked: number;
  velocityPerHour?: number;
  etaHours?: number;
  topRecommendation?: {
    id: string;
    title: string;
    score?: number;
  };
}

export interface PromptSummary {
  name: string;
  phase: string;
  model: string;
  effort: string;
}

export interface VpsHealth {
  uptime: string;
  memory: string;
  disk: string;
}

export interface MailStatus {
  available: boolean;
  reason?: string;
}

export interface CostSummary {
  totalCostUsd: number;
  byModel: Record<string, number>;
  byPhase: Record<string, number>;
}

export interface ActionState {
  enabled: boolean;
  reason?: string;
}

export interface RunSummary {
  id: string;
  projectName: string;
  phase: Phase;
  startedAt: string;
  gatePassedAt: string | null;
  checkpointSha: string | null;
}

export interface WorkflowGuidance {
  title: string;
  detail: string;
}

export interface DashboardSnapshot {
  generatedAt: string;
  server: {
    host: string;
    port: number;
    sessionName: string;
    remoteProjectPath?: string;
  };
  ssh: {
    connected: boolean;
    host?: string;
  };
  run: RunSummary | null;
  agents: AgentStatus[];
  beads: BeadSummary | null;
  vpsHealth: VpsHealth | null;
  mail: MailStatus;
  prompts: PromptSummary[];
  guidance: WorkflowGuidance;
  actions: ActionName[];
  actionStates: Record<ActionName, ActionState>;
  lastError?: string;
}

export type DashboardAction =
  | {
      type: "prompt.send";
      promptName: string;
      pane?: number;
      all?: boolean;
      variables?: Record<string, string>;
      sessionName?: string;
    }
  | {
      type: "swarm.pause";
      sessionName?: string;
    }
  | {
      type: "swarm.resume";
      sessionName?: string;
    }
  | {
      type: "gate.advance";
      nextPhase: Phase;
      checkpointSha?: string;
    };

export class FlywheelServer {
  private readonly host: string;
  private readonly port: number;
  private readonly configuredSessionName?: string;
  private readonly configuredRemoteProjectPath?: string;
  private readonly configuredRunId?: string;
  private readonly sshManager: SSHManager;
  private readonly remoteRunner: RemoteCommandRunner;
  private readonly ntmBridge: NtmBridge;
  private readonly stateManager: StateManager;
  private readonly promptVariables: Record<string, string>;
  private readonly promptSummaries: PromptSummary[];
  private readonly timers: NodeJS.Timeout[] = [];

  private httpServer = createServer(this.handleRequest.bind(this));
  private wsServer = new WebSocketServer({ noServer: true });
  private snapshot: DashboardSnapshot;

  constructor(options: FlywheelServerOptions = {}) {
    this.host = options.host ?? DEFAULT_HOST;
    this.port = options.port ?? DEFAULT_PORT;
    this.sshManager = options.sshManager ?? new SSHManager();
    this.remoteRunner = options.remoteRunner ?? new RemoteCommandRunner(this.sshManager);
    this.ntmBridge = options.ntmBridge ?? new NtmBridge(this.remoteRunner);
    this.stateManager = options.stateManager ?? new StateManager(initDb());
    this.configuredSessionName = options.sessionName;
    this.configuredRemoteProjectPath = options.remoteProjectPath;
    this.configuredRunId = options.runId;
    this.promptVariables = options.promptVariables ?? {};
    this.promptSummaries = loadPromptSummaries();

    this.snapshot = this.withDerivedSnapshot({
      generatedAt: new Date().toISOString(),
      server: {
        host: this.host,
        port: this.port,
        sessionName: this.resolveSessionName(),
        remoteProjectPath: this.resolveRemoteProjectPath(),
      },
      ssh: {
        connected: false,
      },
      run: this.getLatestRunSummary(),
      agents: [],
      beads: null,
      vpsHealth: null,
      mail: {
        available: false,
        reason: "Agent Mail polling is not wired into cli/server.ts yet.",
      },
      prompts: this.promptSummaries,
      guidance: {
        title: "Waiting for flywheel activity",
        detail: 'Start with `flywheel new "<idea>"`, then reopen the dashboard after a run exists.',
      },
      actions: [
        "prompt.send",
        "swarm.pause",
        ...(this.ntmBridge.supportsResume() ? (["swarm.resume"] as const) : []),
        "gate.advance",
      ],
      actionStates: emptyActionStates(),
    });

    this.httpServer.on("upgrade", (request, socket, head) => {
      if (request.url !== "/ws") {
        socket.destroy();
        return;
      }

      this.wsServer.handleUpgrade(request, socket, head, (ws) => {
        this.wsServer.emit("connection", ws, request);
      });
    });

    this.wsServer.on("connection", (ws) => {
      this.sendJson(ws, {
        type: "snapshot",
        payload: this.snapshot,
      });

      ws.on("message", async (message) => {
        await this.handleWebSocketMessage(ws, message.toString("utf8"));
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.port, this.host, () => {
        this.httpServer.removeListener("error", reject);
        resolve();
      });
    });

    const address = this.httpServer.address();
    if (address && typeof address === "object") {
      this.snapshot = this.withDerivedSnapshot({
        ...this.snapshot,
        server: {
          ...this.snapshot.server,
          port: address.port,
        },
      });
    }

    this.schedulePolling();
    await this.refreshAll();
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers.length = 0;

    await new Promise<void>((resolve, reject) => {
      this.wsServer.clients.forEach((client) => client.close());
      this.httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  getSnapshot(): DashboardSnapshot {
    return this.snapshot;
  }

  private schedulePolling(): void {
    this.addPollingTimer(AGENT_POLL_MS, () => this.refreshAgents());
    this.addPollingTimer(BEAD_POLL_MS, () => this.refreshBeads());
    this.addPollingTimer(VPS_HEALTH_POLL_MS, () => this.refreshVpsHealth());
    this.addPollingTimer(MAIL_POLL_MS, () => this.refreshMail());
  }

  private addPollingTimer(intervalMs: number, callback: () => Promise<void>): void {
    const timer = setInterval(() => {
      void callback();
    }, intervalMs);

    timer.unref?.();
    this.timers.push(timer);
  }

  private async refreshAll(): Promise<void> {
    await Promise.allSettled([
      this.refreshAgents(),
      this.refreshBeads(),
      this.refreshVpsHealth(),
      this.refreshMail(),
    ]);
  }

  private async refreshAgents(): Promise<void> {
    try {
      const agents = await this.ntmBridge.activity(this.resolveSessionName());
      this.updateSnapshot({
        agents,
        ssh: {
          connected: this.sshManager.isConnected(),
          host: this.sshManager.getConfig()?.host,
        },
        lastError: undefined,
      });
    } catch (error) {
      this.updateSnapshot({
        ssh: {
          connected: this.sshManager.isConnected(),
          host: this.sshManager.getConfig()?.host,
        },
        lastError: error instanceof Error ? error.message : "Failed to refresh agent status.",
      });
    }
  }

  private async refreshBeads(): Promise<void> {
    const remoteProjectPath = this.resolveRemoteProjectPath();
    if (!remoteProjectPath) {
      this.updateSnapshot({
        beads: null,
      });
      return;
    }

    try {
      const [issuesResult, triageResult] = await Promise.all([
        this.remoteRunner.runRemote("br list --all --json", {
          cwd: remoteProjectPath,
          silent: true,
          timeoutMs: 15_000,
        }),
        this.remoteRunner.runRemote("bv --robot-triage --format json", {
          cwd: remoteProjectPath,
          silent: true,
          timeoutMs: 15_000,
        }),
      ]);

      const issues = parseJsonOrThrow<Array<{ status?: string }>>(
        issuesResult.stdout,
        "br list --all --json"
      );
      const triage = parseJsonOrThrow<{
        triage?: {
          recommendations?: Array<{ id?: string; title?: string; score?: number }>;
        };
      }>(triageResult.stdout, "bv --robot-triage --format json");

      const summary: BeadSummary = {
        total: issues.length,
        open: issues.filter((issue) => issue.status === "open").length,
        inProgress: issues.filter((issue) => issue.status === "in_progress").length,
        closed: issues.filter((issue) => issue.status === "closed").length,
        blocked: issues.filter((issue) => issue.status === "blocked").length,
        topRecommendation: triage.triage?.recommendations?.[0]
          ? {
              id: triage.triage.recommendations[0].id ?? "unknown",
              title: triage.triage.recommendations[0].title ?? "unknown",
              score: triage.triage.recommendations[0].score,
            }
          : undefined,
      };

      const runId = this.resolveRunId();
      if (runId) {
        // Only write a snapshot when counts actually changed to avoid flooding the DB.
        const prior = this.snapshot.beads;
        if (
          !prior ||
          prior.total !== summary.total ||
          prior.closed !== summary.closed ||
          prior.blocked !== summary.blocked
        ) {
          this.stateManager.captureBeadSnapshot(runId, {
            bead_count: summary.total,
            closed_count: summary.closed,
            blocked_count: summary.blocked,
            bead_graph_json: JSON.stringify(triage),
          });
        }

        const velocityPerHour = this.stateManager.beadVelocity(runId);
        const remaining = Math.max(summary.total - summary.closed, 0);
        summary.velocityPerHour = velocityPerHour;
        summary.etaHours =
          velocityPerHour > 0 && remaining > 0 ? remaining / velocityPerHour : undefined;
      }

      this.updateSnapshot({
        beads: summary,
        lastError: undefined,
      });
    } catch (error) {
      this.updateSnapshot({
        lastError: error instanceof Error ? error.message : "Failed to refresh beads.",
      });
    }
  }

  private async refreshVpsHealth(): Promise<void> {
    try {
      const result = await this.remoteRunner.runRemote(
        "sh -lc \"uptime; echo '---'; free -m; echo '---'; df -h .\"",
        {
          silent: true,
          timeoutMs: 15_000,
        }
      );

      const [uptime = "", memory = "", disk = ""] = result.stdout.split("\n---\n");

      this.updateSnapshot({
        vpsHealth: {
          uptime: uptime.trim(),
          memory: memory.trim(),
          disk: disk.trim(),
        },
        ssh: {
          connected: this.sshManager.isConnected(),
          host: this.sshManager.getConfig()?.host,
        },
        lastError: undefined,
      });
    } catch (error) {
      this.updateSnapshot({
        ssh: {
          connected: this.sshManager.isConnected(),
          host: this.sshManager.getConfig()?.host,
        },
        lastError: error instanceof Error ? error.message : "Failed to refresh VPS health.",
      });
    }
  }

  private async refreshMail(): Promise<void> {
    this.updateSnapshot({
      mail: {
        available: false,
        reason: "Agent Mail polling is not wired into cli/server.ts yet.",
      },
    });
  }

  private async handleAction(action: DashboardAction): Promise<unknown> {
    switch (action.type) {
      case "prompt.send":
        return await this.handlePromptSend(action);
      case "swarm.pause":
        return await this.ntmBridge.pause(action.sessionName ?? this.resolveSessionName());
      case "swarm.resume":
        return await this.ntmBridge.resume(action.sessionName ?? this.resolveSessionName());
      case "gate.advance": {
        const runId = this.resolveRunId();
        if (!runId) {
          throw new Error("Cannot advance a gate without an active or recent run.");
        }
        this.stateManager.advanceGate(runId, action.nextPhase, action.checkpointSha);
        return { ok: true, runId, nextPhase: action.nextPhase };
      }
      default:
        return assertNever(action);
    }
  }

  private async handlePromptSend(
    action: Extract<DashboardAction, { type: "prompt.send" }>
  ): Promise<unknown> {
    const prompt = getPrompt(action.promptName);

    if (!prompt) {
      throw new Error(`Unknown prompt: ${action.promptName}`);
    }

    const resolvedPrompt = substituteVariables(prompt.text, {
      ...this.promptVariables,
      ...(action.variables ?? {}),
    });

    const targetSession = action.sessionName ?? this.resolveSessionName();
    const target = action.all ? "all" : `pane:${action.pane ?? "unknown"}`;

    if (action.all) {
      const command = [
        "ntm",
        "send",
        shellQuote(targetSession),
        "--all",
        "--json",
        shellQuote(resolvedPrompt),
      ].join(" ");

      const result = await this.remoteRunner.runRemote(command, {
        timeoutMs: 30_000,
      });

      this.stateManager.logPromptSend(action.promptName, target, this.resolveRunId());
      return parseJsonOrThrow(result.stdout, "ntm send --all --json");
    }

    if (typeof action.pane !== "number") {
      throw new Error('prompt.send requires either "all": true or a numeric "pane".');
    }

    const result = await this.ntmBridge.send(targetSession, action.pane, resolvedPrompt);
    this.stateManager.logPromptSend(action.promptName, target, this.resolveRunId());
    return result;
  }

  private async handleWebSocketMessage(ws: WebSocket, rawMessage: string): Promise<void> {
    try {
      const action = parseJsonOrThrow<DashboardAction>(rawMessage, "dashboard websocket action");
      const payload = await this.handleAction(action);
      await this.refreshAll();
      this.sendJson(ws, {
        type: "action_result",
        ok: true,
        action: action.type,
        payload,
      });
    } catch (error) {
      this.sendJson(ws, {
        type: "action_result",
        ok: false,
        error: error instanceof Error ? error.message : "Unknown dashboard action error.",
      });
    }
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    if (request.method === "GET" && request.url === "/health") {
      this.respondJson(response, 200, {
        ok: true,
        generatedAt: this.snapshot.generatedAt,
      });
      return;
    }

    if (request.method === "GET" && request.url === "/snapshot") {
      this.respondJson(response, 200, this.snapshot);
      return;
    }

    if (request.method === "POST" && request.url === "/action") {
      this.handleHttpAction(request, response).catch((error) => {
        this.respondJson(response, 500, {
          ok: false,
          error: error instanceof Error ? error.message : "Unknown dashboard action error.",
        });
      });
      return;
    }

    if (request.method === "GET" && request.url === "/") {
      void this.respondDashboardAsset(response, "index.html", "text/html; charset=utf-8");
      return;
    }

    if (request.method === "GET" && (request.url === "/main.js" || request.url === "/main.ts")) {
      const assetName = request.url === "/main.ts" ? "main.ts" : "main.js";
      void this.respondDashboardAsset(response, assetName, "application/javascript; charset=utf-8");
      return;
    }

    if (request.method === "GET" && request.url === "/style.css") {
      void this.respondDashboardAsset(response, "style.css", "text/css; charset=utf-8");
      return;
    }

    if (request.method === "GET" && request.url === "/cost") {
      this.respondJson(response, 200, this.getCostSummary());
      return;
    }

    this.respondJson(response, 404, {
      ok: false,
      error: "Not found",
    });
  }

  private async handleHttpAction(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const body = await readRequestBody(request);
    let action: DashboardAction;
    try {
      action = parseJsonOrThrow<DashboardAction>(body, "dashboard HTTP action");
    } catch (error) {
      this.respondJson(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : "Invalid JSON in request body.",
      });
      return;
    }
    const payload = await this.handleAction(action);
    await this.refreshAll();
    this.respondJson(response, 200, {
      ok: true,
      action: action.type,
      payload,
    });
  }

  private updateSnapshot(patch: Partial<DashboardSnapshot>): void {
    this.snapshot = this.withDerivedSnapshot({
      ...this.snapshot,
      ...patch,
      generatedAt: new Date().toISOString(),
    });

    this.broadcast({
      type: "snapshot",
      payload: this.snapshot,
    });
  }

  private withDerivedSnapshot(snapshot: DashboardSnapshot): DashboardSnapshot {
    const run = this.getLatestRunSummary();
    const sessionName = this.resolveSessionName(run?.projectName);
    const remoteProjectPath = this.resolveRemoteProjectPath(run?.projectName);
    const runId = this.resolveRunId(run?.id);

    return {
      ...snapshot,
      run,
      prompts: this.promptSummaries,
      server: {
        ...snapshot.server,
        sessionName,
        remoteProjectPath,
      },
      guidance: deriveGuidance({
        connected: snapshot.ssh.connected,
        remoteProjectPath,
        run,
        agents: snapshot.agents,
        beads: snapshot.beads,
        lastError: snapshot.lastError,
      }),
      actionStates: {
        "prompt.send": {
          enabled: this.promptSummaries.length > 0,
          reason:
            this.promptSummaries.length > 0
              ? snapshot.ssh.connected
                ? undefined
                : "Prompt sends can still attempt an on-demand SSH reconnect, but the link is not currently healthy."
              : "No prompts were loaded from prompts.yaml.",
        },
        "swarm.pause": {
          enabled: snapshot.agents.length > 0,
          reason:
            snapshot.agents.length > 0
              ? undefined
              : "No active agents are currently visible in the target NTM session.",
        },
        "swarm.resume": {
          enabled: this.ntmBridge.supportsResume(),
          reason: this.ntmBridge.supportsResume()
            ? undefined
            : "This NTM build exposes pause/interrupt only; resume must be done by re-sending prompts.",
        },
        "gate.advance": {
          enabled: Boolean(runId),
          reason: runId ? undefined : "No local flywheel run is available to advance.",
        },
      },
    };
  }

  private getCostSummary(): CostSummary {
    const runId = this.resolveRunId();
    if (!runId) {
      return { totalCostUsd: 0, byModel: {}, byPhase: {} };
    }
    const calls = this.stateManager.getApiCalls(runId);
    const byModel: Record<string, number> = {};
    const byPhase: Record<string, number> = {};
    let totalCostUsd = 0;
    for (const call of calls) {
      const cost = call.cost_usd ?? 0;
      totalCostUsd += cost;
      byModel[call.model] = (byModel[call.model] ?? 0) + cost;
      byPhase[call.phase] = (byPhase[call.phase] ?? 0) + cost;
    }
    return { totalCostUsd, byModel, byPhase };
  }

  private getLatestRun(): FlywheelRun | undefined {
    const preferredRun = this.configuredRunId
      ? this.stateManager.getFlywheelRun(this.configuredRunId)
      : undefined;
    return preferredRun ?? this.stateManager.listFlywheelRuns()[0];
  }

  private getLatestRunSummary(): RunSummary | null {
    const run = this.getLatestRun();
    if (!run) {
      return null;
    }

    return {
      id: run.id,
      projectName: run.project_name,
      phase: run.phase,
      startedAt: run.started_at,
      gatePassedAt: run.gate_passed_at,
      checkpointSha: run.checkpoint_sha,
    };
  }

  private resolveRunId(fallbackRunId?: string): string | undefined {
    return this.configuredRunId ?? fallbackRunId ?? this.getLatestRun()?.id;
  }

  private resolveSessionName(projectName?: string): string {
    if (this.configuredSessionName) {
      return this.configuredSessionName;
    }

    return slugify(projectName ?? this.getLatestRun()?.project_name ?? basename(process.cwd()));
  }

  private resolveRemoteProjectPath(projectName?: string): string | undefined {
    if (this.configuredRemoteProjectPath) {
      return this.configuredRemoteProjectPath;
    }

    const inferredProjectName = projectName ?? this.getLatestRun()?.project_name;
    if (!inferredProjectName) {
      return undefined;
    }

    try {
      const sshConfig = loadSSHConfig();
      return `${trimTrailingSlash(sshConfig.remoteRepoRoot)}/${inferredProjectName}`;
    } catch {
      return undefined;
    }
  }

  private broadcast(payload: unknown): void {
    const encoded = JSON.stringify(payload);
    for (const client of this.wsServer.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(encoded);
      }
    }
  }

  private sendJson(ws: WebSocket, payload: unknown): void {
    ws.send(JSON.stringify(payload));
  }

  private respondJson(response: ServerResponse, statusCode: number, payload: unknown): void {
    response.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify(payload, null, 2));
  }

  private async respondDashboardAsset(
    response: ServerResponse,
    assetName: string,
    contentType: string
  ): Promise<void> {
    try {
      const assetPath = await resolveDashboardAssetPath(assetName);
      const body = await readFile(assetPath, "utf8");
      response.writeHead(200, { "content-type": contentType });
      response.end(body);
    } catch {
      this.respondJson(response, 404, {
        ok: false,
        error: `Dashboard asset not found: ${assetName}`,
      });
    }
  }
}

export function createFlywheelServer(options: FlywheelServerOptions = {}): FlywheelServer {
  return new FlywheelServer(options);
}

const MAX_REQUEST_BODY_BYTES = 256 * 1024; // 256 KB — sufficient for any action payload

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    totalBytes += buf.byteLength;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      request.destroy();
      throw new Error(`Request body exceeds ${MAX_REQUEST_BODY_BYTES}-byte limit.`);
    }
    chunks.push(buf);
  }

  return Buffer.concat(chunks).toString("utf8");
}


function emptyActionStates(): Record<ActionName, ActionState> {
  return {
    "prompt.send": { enabled: false },
    "swarm.pause": { enabled: false },
    "swarm.resume": { enabled: false },
    "gate.advance": { enabled: false },
  };
}

function loadPromptSummaries(): PromptSummary[] {
  try {
    return Object.entries(loadPrompts())
      .map(([name, prompt]) => ({
        name,
        phase: prompt.phase,
        model: prompt.model,
        effort: prompt.effort,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

function deriveGuidance(input: {
  connected: boolean;
  remoteProjectPath?: string;
  run: RunSummary | null;
  agents: AgentStatus[];
  beads: BeadSummary | null;
  lastError?: string;
}): WorkflowGuidance {
  if (input.lastError) {
    return {
      title: "Attention needed",
      detail: input.lastError,
    };
  }

  if (!input.run) {
    return {
      title: "Start a run first",
      detail: 'Run `flywheel new "<idea>"` to create a local run record, then reopen the dashboard.',
    };
  }

  if (!input.remoteProjectPath) {
    return {
      title: "Attach the remote project",
      detail: "The dashboard still cannot infer the remote project path needed for bead polling.",
    };
  }

  if (!input.connected) {
    return {
      title: "Restore the SSH link",
      detail: "Local run state is available, but live remote orchestration data is currently unavailable.",
    };
  }

  if (input.run.phase === "swarm" && input.agents.length === 0) {
    return {
      title: "Spawn or reconnect the swarm",
      detail: "The current run is in swarm phase, but no agent panes are visible for the active session.",
    };
  }

  if (input.beads?.topRecommendation) {
    return {
      title: `Top bead: ${input.beads.topRecommendation.id}`,
      detail: input.beads.topRecommendation.title,
    };
  }

  return {
    title: `Phase: ${input.run.phase}`,
    detail: "The dashboard is live. Use prompts, gate controls, and agent activity to steer the current run.",
  };
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function assertNever(value: never): never {
  throw new Error(`Unhandled dashboard action: ${JSON.stringify(value)}`);
}

function parseJsonOrThrow<T>(raw: string, source: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(
      `Failed to parse JSON output from ${source}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function resolveDashboardAssetPath(assetName: string): Promise<string> {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "dashboard", assetName),
    join(currentDir, "..", "dashboard", assetName),
  ];

  for (const candidate of candidates) {
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(`Dashboard asset not found: ${assetName}`);
}
