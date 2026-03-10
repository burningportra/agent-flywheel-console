// Local HTTP + WebSocket server for dashboard
// Topology: Browser ←→ WS ←→ this server ←→ SSH ←→ VPS
// Never expose beyond localhost

import { existsSync, readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import yaml from "js-yaml";
import { WebSocket, WebSocketServer } from "ws";

import {
  getCurrentPhaseSnapshot,
  listFlywheelRuns,
  type FlywheelRunRow,
} from "./state.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4200;
const BODY_LIMIT_BYTES = 1_000_000;
const PHASE_ORDER = ["plan", "beads", "swarm", "review", "deploy"];

const moduleDir = fileURLToPath(new URL(".", import.meta.url));
const defaultProjectRoot = resolve(moduleDir, "..");

export interface PhasePayload {
  runId: string | null;
  projectName: string | null;
  phase: string | null;
  gatePassedAt: string | null;
  updatedAt: string | null;
  isGatePhase: boolean;
}

export interface AgentPayload {
  id: string;
  type: string | null;
  status: string;
  currentBead: string | null;
  pendingMail: number;
  lastActivityAt: string | null;
  metadata?: Record<string, unknown>;
}

export interface BeadPayload {
  id: string;
  title: string;
  status: string;
  priority: number | null;
  issueType: string | null;
  labels: string[];
}

export interface BeadsPayload {
  items: BeadPayload[];
  stats: {
    total: number;
    ready: number;
    inProgress: number;
    blocked: number;
    closed: number;
  };
  updatedAt: string | null;
}

export interface PromptPayload {
  name: string;
  text: string;
  model: string;
  effort: string;
  phase: string;
}

export interface PromptsPayload {
  items: PromptPayload[];
  sourcePath: string | null;
  error: string | null;
}

export interface ProviderSlotPayload {
  model: string;
  keyPresent: boolean;
  maxConcurrent: number | null;
}

export interface ProvidersPayload {
  configured: boolean;
  sourcePath: string | null;
  rotation: string | null;
  slots: Record<string, ProviderSlotPayload[]>;
  pricing: Record<
    string,
    {
      inputPerMtok: number | null;
      outputPerMtok: number | null;
    }
  >;
  error: string | null;
}

export interface RunPayload {
  id: string;
  projectName: string | null;
  phase: string | null;
  startedAt: string | null;
  completedAt: string | null;
  gatePassedAt: string | null;
  checkpointSha: string | null;
  costUsd: number | null;
  notes: string | null;
}

export interface MemoryPayload {
  available: boolean;
  entries: Array<Record<string, unknown>>;
  updatedAt: string | null;
  message: string | null;
}

export interface BootstrapPayload {
  generatedAt: string;
  phase: PhasePayload;
  agents: AgentPayload[];
  beads: BeadsPayload;
  prompts: PromptsPayload;
  providers: ProvidersPayload;
  runs: RunPayload[];
  memory: MemoryPayload;
}

export interface PromptSendAction {
  name: string;
  target?: Record<string, unknown>;
  vars?: Record<string, string>;
}

export interface GateAdvanceAction {
  runId?: string | null;
}

export interface SwarmControlAction {
  session?: string | null;
}

export interface FlywheelServerEvent {
  type:
    | "server.connected"
    | "snapshot.updated"
    | "beads.updated"
    | "phase.updated"
    | "memory.updated";
  generatedAt: string;
}

export interface StdoutLineEvent {
  type: "stdout.line";
  session: string;
  pane: string;
  stream: "stdout" | "stderr";
  line: string;
  ts: number;
}

export interface ErrorEvent {
  type: "error";
  message: string;
  generatedAt: string;
}

export type DashboardEvent = FlywheelServerEvent | StdoutLineEvent | ErrorEvent;

export interface FlywheelServerActions {
  promptSend?: (payload: PromptSendAction) => Promise<unknown> | unknown;
  gateAdvance?: (payload: GateAdvanceAction) => Promise<unknown> | unknown;
  swarmPause?: (payload: SwarmControlAction) => Promise<unknown> | unknown;
  swarmResume?: (payload: SwarmControlAction) => Promise<unknown> | unknown;
}

export interface FlywheelServerState {
  phase: PhasePayload;
  agents: AgentPayload[];
  beads: BeadsPayload;
  prompts: PromptsPayload;
  providers: ProvidersPayload;
  runs: RunPayload[];
  memory: MemoryPayload;
}

export interface FlywheelServerOptions {
  actions?: FlywheelServerActions;
  db?: Database.Database;
  host?: string;
  initialState?: Partial<FlywheelServerState>;
  loopbackOnly?: boolean;
  onError?: (error: unknown) => void;
  port?: number;
  projectRoot?: string;
}

export interface StartResult {
  host: string;
  port: number;
}

class DashboardStateStore {
  private state: FlywheelServerState;

  constructor(initialState: FlywheelServerState) {
    this.state = initialState;
  }

  snapshot(): FlywheelServerState {
    return {
      phase: { ...this.state.phase },
      agents: this.state.agents.map((agent) => ({ ...agent })),
      beads: {
        ...this.state.beads,
        items: this.state.beads.items.map((bead) => ({ ...bead })),
        stats: { ...this.state.beads.stats },
      },
      prompts: {
        ...this.state.prompts,
        items: this.state.prompts.items.map((prompt) => ({ ...prompt })),
      },
      providers: {
        ...this.state.providers,
        slots: Object.fromEntries(
          Object.entries(this.state.providers.slots).map(([slot, entries]) => [
            slot,
            entries.map((entry) => ({ ...entry })),
          ]),
        ),
        pricing: Object.fromEntries(
          Object.entries(this.state.providers.pricing).map(([model, pricing]) => [
            model,
            { ...pricing },
          ]),
        ),
      },
      runs: this.state.runs.map((run) => ({ ...run })),
      memory: {
        ...this.state.memory,
        entries: this.state.memory.entries.map((entry) => ({ ...entry })),
      },
    };
  }

  merge(partial: Partial<FlywheelServerState>): void {
    this.state = {
      ...this.state,
      ...partial,
      phase: partial.phase ?? this.state.phase,
      agents: partial.agents ?? this.state.agents,
      beads: partial.beads ?? this.state.beads,
      prompts: partial.prompts ?? this.state.prompts,
      providers: partial.providers ?? this.state.providers,
      runs: partial.runs ?? this.state.runs,
      memory: partial.memory ?? this.state.memory,
    };
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackAddress(address?: string): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > BODY_LIMIT_BYTES) {
      throw new Error("Request body exceeds 1 MB limit.");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function loadYamlFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }

  const raw = readFileSync(filePath, "utf8");
  return yaml.load(raw) as T;
}

function loadPromptsPayload(projectRoot: string): PromptsPayload {
  const sourcePath = resolve(projectRoot, "config/prompts.yaml");

  try {
    const doc = loadYamlFile<{ prompts?: unknown }>(sourcePath);
    if (!doc) {
      return {
        items: [],
        sourcePath,
        error: "Prompt config was not found.",
      };
    }

    if (!isRecord(doc.prompts)) {
      return {
        items: [],
        sourcePath,
        error: "Prompt config must define a top-level 'prompts' object.",
      };
    }

    const entries = Object.entries(doc.prompts)
      .map(([name, prompt]) => ({
        name,
        text: isRecord(prompt) && typeof prompt.text === "string" ? prompt.text : "",
        model:
          isRecord(prompt) && typeof prompt.model === "string"
            ? prompt.model
            : "unknown",
        effort:
          isRecord(prompt) && typeof prompt.effort === "string"
            ? prompt.effort
            : "unknown",
        phase:
          isRecord(prompt) && typeof prompt.phase === "string"
            ? prompt.phase
            : "unknown",
      }))
      .sort((left, right) => {
        const leftPhase = PHASE_ORDER.indexOf(left.phase);
        const rightPhase = PHASE_ORDER.indexOf(right.phase);
        const leftRank = leftPhase === -1 ? Number.MAX_SAFE_INTEGER : leftPhase;
        const rightRank = rightPhase === -1 ? Number.MAX_SAFE_INTEGER : rightPhase;

        return leftRank === rightRank
          ? left.name.localeCompare(right.name)
          : leftRank - rightRank;
      });

    return {
      items: entries,
      sourcePath,
      error: null,
    };
  } catch (error) {
    return {
      items: [],
      sourcePath,
      error: error instanceof Error ? error.message : "Failed to parse prompts.",
    };
  }
}

function loadProvidersPayload(projectRoot: string): ProvidersPayload {
  const configuredPath = resolve(projectRoot, "config/providers.yaml");
  const examplePath = resolve(projectRoot, "config/providers.example.yaml");
  const sourcePath = existsSync(configuredPath) ? configuredPath : examplePath;

  try {
    const doc = loadYamlFile<{
      slots?: unknown;
      rotation?: unknown;
      pricing?: unknown;
    }>(sourcePath);
    if (!doc) {
      return {
        configured: false,
        sourcePath,
        rotation: null,
        slots: {},
        pricing: {},
        error: "Provider config was not found.",
      };
    }

    if (doc.slots !== undefined && !isRecord(doc.slots)) {
      return {
        configured: existsSync(configuredPath),
        sourcePath,
        rotation: null,
        slots: {},
        pricing: {},
        error: "Provider config must define 'slots' as an object.",
      };
    }

    if (doc.pricing !== undefined && !isRecord(doc.pricing)) {
      return {
        configured: existsSync(configuredPath),
        sourcePath,
        rotation: null,
        slots: {},
        pricing: {},
        error: "Provider config must define 'pricing' as an object.",
      };
    }

    const slotRecords = isRecord(doc.slots) ? doc.slots : {};
    const pricingRecords = isRecord(doc.pricing) ? doc.pricing : {};

    const slots = Object.fromEntries(
      Object.entries(slotRecords).map(([slotName, entries]) => [
        slotName,
        Array.isArray(entries)
          ? entries.map((entry) => ({
              model:
                isRecord(entry) && typeof entry.model === "string"
                  ? entry.model
                  : "unknown",
              keyPresent:
                isRecord(entry) &&
                typeof entry.key === "string" &&
                entry.key.trim().length > 0,
              maxConcurrent:
                isRecord(entry) && typeof entry.max_concurrent === "number"
                  ? entry.max_concurrent
                  : null,
            }))
          : [],
      ]),
    );

    const pricing = Object.fromEntries(
      Object.entries(pricingRecords).map(([model, value]) => [
        model,
        {
          inputPerMtok: isRecord(value) && typeof value.input_per_mtok === "number"
            ? value.input_per_mtok
            : null,
          outputPerMtok: isRecord(value) && typeof value.output_per_mtok === "number"
            ? value.output_per_mtok
            : null,
        },
      ]),
    );

    return {
      configured: existsSync(configuredPath),
      sourcePath,
      rotation: typeof doc?.rotation === "string" ? doc.rotation : null,
      slots,
      pricing,
      error: null,
    };
  } catch (error) {
    return {
      configured: existsSync(configuredPath),
      sourcePath,
      rotation: null,
      slots: {},
      pricing: {},
      error:
        error instanceof Error ? error.message : "Failed to parse providers config.",
    };
  }
}

function mapRunRow(row: FlywheelRunRow): RunPayload {
  return {
    id: row.id,
    projectName: row.project_name,
    phase: row.phase,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    gatePassedAt: row.gate_passed_at,
    checkpointSha: row.checkpoint_sha,
    costUsd: row.cost_usd,
    notes: row.notes,
  };
}

function buildInitialState(options: FlywheelServerOptions): FlywheelServerState {
  const projectRoot = options.projectRoot ?? defaultProjectRoot;
  const phaseFromDb = options.db ? getCurrentPhaseSnapshot(options.db) : null;
  const runsFromDb = options.db ? listFlywheelRuns(options.db).map(mapRunRow) : [];

  const defaultPhase: PhasePayload = phaseFromDb
    ? {
        runId: phaseFromDb.runId,
        projectName: phaseFromDb.projectName,
        phase: phaseFromDb.phase,
        gatePassedAt: phaseFromDb.gatePassedAt,
        updatedAt: phaseFromDb.updatedAt,
        isGatePhase: phaseFromDb.phase?.startsWith("GATE_") ?? false,
      }
    : {
        runId: null,
        projectName: null,
        phase: null,
        gatePassedAt: null,
        updatedAt: null,
        isGatePhase: false,
      };

  return {
    phase: options.initialState?.phase ?? defaultPhase,
    agents: options.initialState?.agents ?? [],
    beads:
      options.initialState?.beads ??
      {
        items: [],
        stats: {
          total: 0,
          ready: 0,
          inProgress: 0,
          blocked: 0,
          closed: 0,
        },
        updatedAt: null,
      },
    prompts: options.initialState?.prompts ?? loadPromptsPayload(projectRoot),
    providers:
      options.initialState?.providers ?? loadProvidersPayload(projectRoot),
    runs: options.initialState?.runs ?? runsFromDb,
    memory:
      options.initialState?.memory ??
      {
        available: false,
        entries: [],
        updatedAt: null,
        message: "Memory integrations are not wired yet.",
      },
  };
}

function validatePromptSendAction(payload: unknown): PromptSendAction {
  if (!payload || typeof payload !== "object") {
    throw new Error("prompt-send expects a JSON object payload.");
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.trim().length === 0) {
    throw new Error("prompt-send requires a non-empty 'name' field.");
  }

  let vars: Record<string, string> | undefined;
  if (record.vars !== undefined) {
    if (!record.vars || typeof record.vars !== "object" || Array.isArray(record.vars)) {
      throw new Error("prompt-send 'vars' must be an object of string values.");
    }

    vars = {};
    for (const [key, value] of Object.entries(record.vars)) {
      if (typeof value !== "string") {
        throw new Error("prompt-send 'vars' values must all be strings.");
      }
      vars[key] = value;
    }
  }

  return {
    name: record.name,
    target:
      record.target && typeof record.target === "object" && !Array.isArray(record.target)
        ? (record.target as Record<string, unknown>)
        : undefined,
    vars,
  };
}

function validateGateAdvanceAction(payload: unknown): GateAdvanceAction {
  if (payload === undefined || payload === null) {
    return {};
  }

  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("gate-advance expects a JSON object payload.");
  }

  const record = payload as Record<string, unknown>;
  if (
    record.runId !== undefined &&
    record.runId !== null &&
    typeof record.runId !== "string"
  ) {
    throw new Error("gate-advance 'runId' must be a string or null.");
  }

  return {
    runId:
      typeof record.runId === "string" || record.runId === null
        ? record.runId
        : undefined,
  };
}

function validateSwarmControlAction(payload: unknown): SwarmControlAction {
  if (payload === undefined || payload === null) {
    return {};
  }

  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("swarm control expects a JSON object payload.");
  }

  const record = payload as Record<string, unknown>;
  if (
    record.session !== undefined &&
    record.session !== null &&
    typeof record.session !== "string"
  ) {
    throw new Error("swarm control 'session' must be a string or null.");
  }

  return {
    session:
      typeof record.session === "string" || record.session === null
        ? record.session
        : undefined,
  };
}

export class FlywheelServer {
  private readonly actions: FlywheelServerActions;
  private readonly db?: Database.Database;
  private readonly host: string;
  private readonly loopbackOnly: boolean;
  private readonly onError?: (error: unknown) => void;
  private readonly port: number;
  private readonly projectRoot: string;
  private readonly state: DashboardStateStore;
  private readonly server = createServer((request, response) =>
    void this.handleHttpRequest(request, response),
  );
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor(options: FlywheelServerOptions = {}) {
    this.actions = options.actions ?? {};
    this.db = options.db;
    this.host = options.host ?? DEFAULT_HOST;
    this.loopbackOnly = options.loopbackOnly ?? true;
    this.onError = options.onError;
    this.port = options.port ?? DEFAULT_PORT;
    this.projectRoot = options.projectRoot ?? defaultProjectRoot;
    this.state = new DashboardStateStore(buildInitialState(options));

    this.server.on("upgrade", (request, socket, head) => {
      const remoteAddress = request.socket.remoteAddress;
      const pathname = new URL(
        request.url ?? "/",
        `http://${this.host}:${this.port}`,
      ).pathname;

      if (this.loopbackOnly && !isLoopbackAddress(remoteAddress)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      if (pathname !== "/ws") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit("connection", ws, request);
      });
    });

    this.wss.on("connection", (ws) => {
      this.sendEvent(ws, {
        type: "server.connected",
        generatedAt: nowIso(),
      });
    });
  }

  async start(): Promise<StartResult> {
    await new Promise<void>((resolveStart, rejectStart) => {
      this.server.once("error", rejectStart);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", rejectStart);
        resolveStart();
      });
    });

    return { host: this.host, port: this.port };
  }

  async stop(): Promise<void> {
    for (const client of this.wss.clients) {
      client.close();
    }

    if (!this.server.listening) {
      return;
    }

    await new Promise<void>((resolveStop, rejectStop) => {
      this.server.close((error) => {
        if (error) {
          rejectStop(error);
          return;
        }
        resolveStop();
      });
    });
  }

  getBootstrap(): BootstrapPayload {
    const snapshot = this.getReadState();

    return {
      generatedAt: nowIso(),
      phase: snapshot.phase,
      agents: snapshot.agents,
      beads: snapshot.beads,
      prompts: snapshot.prompts,
      providers: snapshot.providers,
      runs: snapshot.runs,
      memory: snapshot.memory,
    };
  }

  private getReadState(): FlywheelServerState {
    const snapshot = this.state.snapshot();

    snapshot.prompts = loadPromptsPayload(this.projectRoot);
    snapshot.providers = loadProvidersPayload(this.projectRoot);

    if (this.db) {
      const phaseFromDb = getCurrentPhaseSnapshot(this.db);
      snapshot.phase = {
        runId: phaseFromDb.runId,
        projectName: phaseFromDb.projectName,
        phase: phaseFromDb.phase,
        gatePassedAt: phaseFromDb.gatePassedAt,
        updatedAt: phaseFromDb.updatedAt,
        isGatePhase: phaseFromDb.phase?.startsWith("GATE_") ?? false,
      };
      snapshot.runs = listFlywheelRuns(this.db).map(mapRunRow);
    }

    return snapshot;
  }

  setPhase(phase: PhasePayload): void {
    this.state.merge({ phase });
    this.publish({
      type: "phase.updated",
      generatedAt: nowIso(),
    });
  }

  setAgents(agents: AgentPayload[]): void {
    this.state.merge({ agents });
    this.publish({
      type: "snapshot.updated",
      generatedAt: nowIso(),
    });
  }

  setBeads(beads: BeadsPayload): void {
    this.state.merge({ beads });
    this.publish({
      type: "beads.updated",
      generatedAt: nowIso(),
    });
  }

  setRuns(runs: RunPayload[]): void {
    this.state.merge({ runs });
  }

  setMemory(memory: MemoryPayload): void {
    this.state.merge({ memory });
    this.publish({
      type: "memory.updated",
      generatedAt: nowIso(),
    });
  }

  publishStdoutLine(event: Omit<StdoutLineEvent, "type">): void {
    this.publish({
      type: "stdout.line",
      ...event,
    });
  }

  publishError(message: string): void {
    this.publish({
      type: "error",
      message,
      generatedAt: nowIso(),
    });
  }

  private async handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (
        this.loopbackOnly &&
        !isLoopbackAddress(request.socket.remoteAddress)
      ) {
        sendJson(response, 403, {
          ok: false,
          error: {
            code: "forbidden",
            message: "Loopback access only.",
          },
        });
        return;
      }

      const method = request.method ?? "GET";
      const pathname = new URL(
        request.url ?? "/",
        `http://${this.host}:${this.port}`,
      ).pathname;

      if (method === "GET" && pathname === "/health/readiness") {
        sendJson(response, 200, { status: "ready" });
        return;
      }

      if (method === "GET") {
        const bootstrap = this.getBootstrap();

        switch (pathname) {
          case "/api/bootstrap":
            sendJson(response, 200, bootstrap);
            return;
          case "/api/phase":
            sendJson(response, 200, bootstrap.phase);
            return;
          case "/api/agents":
            sendJson(response, 200, bootstrap.agents);
            return;
          case "/api/beads":
            sendJson(response, 200, bootstrap.beads);
            return;
          case "/api/prompts":
            sendJson(response, 200, bootstrap.prompts);
            return;
          case "/api/providers":
            sendJson(response, 200, bootstrap.providers);
            return;
          case "/api/runs":
            sendJson(response, 200, bootstrap.runs);
            return;
          case "/api/memory":
            sendJson(response, 200, bootstrap.memory);
            return;
          default:
            break;
        }
      }

      if (method === "POST") {
        switch (pathname) {
          case "/api/actions/prompt-send":
            await this.handleActionRequest(
              response,
              "prompt-send",
              this.actions.promptSend,
              request,
              validatePromptSendAction,
            );
            return;
          case "/api/actions/gate-advance":
            await this.handleActionRequest(
              response,
              "gate-advance",
              this.actions.gateAdvance,
              request,
              validateGateAdvanceAction,
            );
            return;
          case "/api/actions/swarm-pause":
            await this.handleActionRequest(
              response,
              "swarm-pause",
              this.actions.swarmPause,
              request,
              validateSwarmControlAction,
            );
            return;
          case "/api/actions/swarm-resume":
            await this.handleActionRequest(
              response,
              "swarm-resume",
              this.actions.swarmResume,
              request,
              validateSwarmControlAction,
            );
            return;
          default:
            break;
        }
      }

      sendJson(response, 404, {
        ok: false,
        error: {
          code: "not_found",
          message: `No route for ${method} ${pathname}.`,
        },
      });
    } catch (error) {
      this.onError?.(error);
      sendJson(response, 500, {
        ok: false,
        error: {
          code: "internal_error",
          message:
            error instanceof Error ? error.message : "Unexpected server error.",
        },
      });
    }
  }

  private async handleActionRequest<T>(
    response: ServerResponse,
    action: string,
    handler: ((payload: T) => Promise<unknown> | unknown) | undefined,
    request: IncomingMessage,
    validate: (payload: unknown) => T,
  ): Promise<void> {
    let payload: T;
    try {
      const rawPayload = await readJsonBody(request);
      payload = validate(rawPayload);
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: {
          code: "invalid_request",
          message:
            error instanceof Error
              ? error.message
              : `Invalid payload for ${action}.`,
        },
      });
      return;
    }

    if (!handler) {
      sendJson(response, 501, {
        ok: false,
        error: {
          code: "not_implemented",
          message: `${action} is not wired yet.`,
        },
      });
      return;
    }

    const result = await handler(payload);
    sendJson(response, 200, {
      ok: true,
      action,
      data: result ?? null,
    });
  }

  private publish(event: DashboardEvent): void {
    const payload = JSON.stringify(event);

    for (const client of this.wss.clients) {
      this.sendRaw(client, payload);
    }
  }

  private sendEvent(client: WebSocket, event: DashboardEvent): void {
    this.sendRaw(client, JSON.stringify(event));
  }

  private sendRaw(client: WebSocket, payload: string): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}
