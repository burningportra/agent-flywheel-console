import {
  RemoteCommandError,
  RemoteCommandRunner,
  type RemoteCommandResult,
} from "./remote.js";
import { shellQuote } from "./utils.js";

export type AgentRuntimeType = "claude" | "codex" | "gemini" | "user" | "unknown";

interface NtmListResponse {
  sessions?: Array<{
    name?: string;
    windows?: number;
    pane_count?: number;
    attached?: boolean;
    agents?: {
      claude?: number;
      codex?: number;
      gemini?: number;
      user?: number;
      total?: number;
    };
  }>;
}

interface NtmStatusResponse {
  generated_at?: string;
  session?: string;
  exists?: boolean;
  attached?: boolean;
  working_directory?: string;
  panes?: Array<{
    index?: number;
    title?: string;
    type?: AgentRuntimeType;
    active?: boolean;
    command?: string;
  }>;
  agent_counts?: {
    claude?: number;
    codex?: number;
    gemini?: number;
    user?: number;
    total?: number;
  };
}

export interface AgentStatus {
  pane: number;
  status: "active" | "idle" | "stuck";
  lastActivity: string;
  currentBead?: string;
  title?: string;
  command?: string;
  type?: AgentRuntimeType;
}

export interface NtmSession {
  name: string;
  windows: number;
  paneCount: number;
  attached: boolean;
  agentCounts: {
    claude: number;
    codex: number;
    gemini: number;
    user: number;
    total: number;
  };
}

export interface NtmSpawnOptions {
  cc?: number;
  cod?: number;
  gmi?: number;
  recipe?: string;
  prompt?: string;
  noUser?: boolean;
  autoRestart?: boolean;
}

export interface NtmSpawnResult {
  session: string;
  paneCount?: number;
  raw: unknown;
}

export interface NtmSendResult {
  success: boolean;
  session: string;
  delivered: number;
  targets: number[];
  raw: unknown;
}

export interface NtmPauseResult {
  session: string;
  raw: unknown;
}

interface IdleSnapshot {
  signature: string;
  unchangedCount: number;
  lastChangedAt: string;
}

export class NtmBridgeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NtmBridgeError";
  }
}

export class NtmBridge {
  private readonly idleSnapshots = new Map<string, IdleSnapshot>();

  constructor(private readonly remote: RemoteCommandRunner) {}

  supportsResume(): boolean {
    return false;
  }

  async list(): Promise<NtmSession[]> {
    const response = await this.runJsonCommand<NtmListResponse>("ntm list --json");
    const sessions = response.sessions ?? [];

    return sessions
      .filter((session): session is NonNullable<typeof session> => Boolean(session?.name))
      .map((session) => ({
        name: session.name ?? "",
        windows: session.windows ?? 0,
        paneCount: session.pane_count ?? 0,
        attached: session.attached ?? false,
        agentCounts: {
          claude: session.agents?.claude ?? 0,
          codex: session.agents?.codex ?? 0,
          gemini: session.agents?.gemini ?? 0,
          user: session.agents?.user ?? 0,
          total: session.agents?.total ?? 0,
        },
      }));
  }

  async spawn(session: string, count: number, options: NtmSpawnOptions = {}): Promise<NtmSpawnResult> {
    const command = [
      "ntm",
      "spawn",
      shellQuote(session),
      `--cc=${options.cc ?? count}`,
      ...(options.cod ? [`--cod=${options.cod}`] : []),
      ...(options.gmi ? [`--gmi=${options.gmi}`] : []),
      ...(options.recipe ? ["--recipe", shellQuote(options.recipe)] : []),
      ...(options.prompt ? ["--prompt", shellQuote(options.prompt)] : []),
      ...(options.noUser ? ["--no-user"] : []),
      ...(options.autoRestart ? ["--auto-restart"] : []),
      "--json",
    ].join(" ");

    const raw = await this.runJsonCommand<unknown>(command);

    return {
      session,
      paneCount: inferSpawnPaneCount(raw, count, options),
      raw,
    };
  }

  async send(session: string, pane: number, prompt: string): Promise<NtmSendResult> {
    const command = [
      "ntm",
      "send",
      shellQuote(session),
      `--pane=${pane}`,
      "--json",
      shellQuote(prompt),
    ].join(" ");

    const raw = await this.runJsonCommand<Record<string, unknown>>(command);
    const success = raw.success === true;

    if (!success) {
      throw new NtmBridgeError(
        typeof raw.error === "string" ? raw.error : `NTM send failed for session "${session}".`
      );
    }

    return {
      success,
      session: typeof raw.session === "string" ? raw.session : session,
      delivered: typeof raw.delivered === "number" ? raw.delivered : 0,
      targets: parseTargetList(raw.targets),
      raw,
    };
  }

  async activity(session: string): Promise<AgentStatus[]> {
    const response = await this.runJsonCommand<NtmStatusResponse>(
      `ntm status ${shellQuote(session)} --json`
    );

    if (!response.exists || !response.panes) {
      this.clearSessionSnapshots(session);
      return [];
    }

    const generatedAt = response.generated_at ?? new Date().toISOString();
    const activeSnapshotKeys = new Set<string>();

    const statuses = response.panes.map((pane) => {
      const index = pane.index ?? 0;
      const signature = [pane.title ?? "", pane.command ?? "", pane.active ? "1" : "0"].join("|");
      const snapshotKey = `${session}:${index}`;
      activeSnapshotKeys.add(snapshotKey);
      const previous = this.idleSnapshots.get(snapshotKey);

      let unchangedCount = 1;
      let lastChangedAt = generatedAt;

      if (previous && previous.signature === signature) {
        unchangedCount = previous.unchangedCount + 1;
        lastChangedAt = previous.lastChangedAt;
      }

      this.idleSnapshots.set(snapshotKey, {
        signature,
        unchangedCount,
        lastChangedAt,
      });

      const status: AgentStatus["status"] = pane.active
        ? "active"
        : unchangedCount >= 3
          ? "stuck"
          : "idle";

      return {
        pane: index,
        status,
        lastActivity: pane.active ? generatedAt : lastChangedAt,
        currentBead: extractCurrentBead(pane.title),
        title: pane.title,
        command: pane.command,
        type: pane.type ?? "unknown",
      };
    });

    this.clearMissingPaneSnapshots(session, activeSnapshotKeys);
    return statuses;
  }

  async pause(session: string): Promise<NtmPauseResult> {
    const raw = await this.runJsonCommand<unknown>(`ntm interrupt ${shellQuote(session)} --json`);
    return { session, raw };
  }

  async resume(_session: string): Promise<never> {
    throw new NtmBridgeError(
      'The installed NTM build does not expose a dedicated "resume" command. Use send() to re-prime agents after pause/interrupt.'
    );
  }

  private async runJsonCommand<T>(command: string): Promise<T> {
    let result: RemoteCommandResult;

    try {
      result = await this.remote.runRemote(command, {
        timeoutMs: 30_000,
      });
    } catch (error) {
      if (error instanceof RemoteCommandError) {
        throw new NtmBridgeError(error.message, { cause: error });
      }

      throw error;
    }

    if (!result.stdout.trim()) {
      const stderrHint = result.stderr.trim()
        ? ` stderr: ${result.stderr.trim()}`
        : "";
      throw new NtmBridgeError(
        `NTM command returned no JSON output: ${command}${stderrHint}`
      );
    }

    try {
      return JSON.parse(result.stdout) as T;
    } catch (error) {
      const stderrHint = result.stderr.trim()
        ? ` stderr: ${result.stderr.trim()}`
        : "";
      throw new NtmBridgeError(
        `Failed to parse NTM JSON output for "${command}".${stderrHint}`,
        { cause: error instanceof Error ? error : undefined }
      );
    }
  }

  private clearSessionSnapshots(session: string): void {
    const prefix = `${session}:`;
    for (const key of Array.from(this.idleSnapshots.keys())) {
      if (key.startsWith(prefix)) {
        this.idleSnapshots.delete(key);
      }
    }
  }

  private clearMissingPaneSnapshots(session: string, activeSnapshotKeys: Set<string>): void {
    const prefix = `${session}:`;
    for (const key of Array.from(this.idleSnapshots.keys())) {
      if (key.startsWith(prefix) && !activeSnapshotKeys.has(key)) {
        this.idleSnapshots.delete(key);
      }
    }
  }
}

function inferSpawnPaneCount(raw: unknown, defaultCount: number, options: NtmSpawnOptions): number {
  if (raw && typeof raw === "object") {
    const candidate = (raw as Record<string, unknown>).pane_count;
    if (typeof candidate === "number") {
      return candidate;
    }
  }

  const requestedAgents = (options.cc ?? defaultCount) + (options.cod ?? 0) + (options.gmi ?? 0);
  return requestedAgents + (options.noUser ? 0 : 1);
}

function parseTargetList(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (typeof entry === "number") {
      return [entry];
    }

    if (entry && typeof entry === "object") {
      const candidate = (entry as Record<string, unknown>).pane;
      if (typeof candidate === "number") {
        return [candidate];
      }
    }

    return [];
  });
}

function extractCurrentBead(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }

  const match = title.match(/[A-Za-z0-9-]+-[A-Za-z0-9]+(?:\.[0-9]+)?/);
  return match?.[0];
}
