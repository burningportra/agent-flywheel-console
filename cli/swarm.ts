import { loadPrompts, type Prompt } from "./prompts.js";
import { initDb, StateManager, type Phase } from "./state.js";
import { NtmBridge, type AgentStatus, type NtmSpawnOptions } from "./ntm-bridge.js";
import { RemoteCommandRunner } from "./remote.js";
import { SSHManager } from "./ssh.js";
import { trimTrailingSlash } from "./utils.js";

export interface StartSwarmOptions {
  sessionName?: string;
  remoteProjectPath?: string;
  spawn?: NtmSpawnOptions;
  includeCommitAgent?: boolean;
  budgetUsd?: number;
  runId?: string;
  commitPane?: number;
  commitPromptName?: string;
}

export interface StartSwarmResult {
  runId: string;
  session: string;
  remoteProjectPath: string;
  checkpointSha: string;
  paneCount?: number;
  commitAgentRequested: boolean;
  budgetUsd?: number;
  raw: unknown;
}

export interface ResumeSwarmOptions {
  runId?: string;
  panes?: number[];
  promptName?: string;
}

export interface SwarmStatusOptions {
  runId?: string;
  autoNudgeStuck?: boolean;
  stuckPromptName?: string;
  budgetUsd?: number;
}

export interface SwarmStatus {
  session: string;
  agents: AgentStatus[];
  stuckPanes: number[];
  nudgedPanes: number[];
  totalCostUsd?: number;
  budgetUsd?: number;
  overBudget: boolean;
}

export class SwarmCoordinator {
  private readonly ssh: SSHManager;
  private readonly remote: RemoteCommandRunner;
  private readonly ntm: NtmBridge;
  private readonly state: StateManager;
  private readonly prompts = loadPrompts();

  constructor(deps?: {
    ssh?: SSHManager;
    remote?: RemoteCommandRunner;
    ntm?: NtmBridge;
    state?: StateManager;
  }) {
    this.ssh = deps?.ssh ?? new SSHManager();
    this.remote = deps?.remote ?? new RemoteCommandRunner(this.ssh);
    this.ntm = deps?.ntm ?? new NtmBridge(this.remote);
    this.state = deps?.state ?? new StateManager(initDb());
  }

  async start(
    projectName: string,
    count: number,
    options: StartSwarmOptions = {}
  ): Promise<StartSwarmResult> {
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(`Swarm count must be a positive integer. Received: ${count}`);
    }

    if (options.runId) {
      // Existing runs may already have accumulated spend, so fail before any SSH/NTM work.
      this.assertBudget(options.runId, options.budgetUsd);
    }

    const sshConfig = await this.ssh.connect();
    const remoteProjectPath =
      options.remoteProjectPath ?? `${trimTrailingSlash(sshConfig.remoteRepoRoot)}/${projectName}`;
    const session = options.sessionName ?? defaultSessionName(projectName);

    // Create/resolve runId now so budget check has a valid ID.
    // For new runs the cost is always 0, so a pre-flight budget check is only
    // meaningful when an existing runId is passed (resume scenario).
    const runId = options.runId ?? this.state.createFlywheelRun(projectName, "swarm");

    // Fresh runs still use the shared guard, but always start at $0 spend.
    if (!options.runId) {
      this.assertBudget(runId, options.budgetUsd);
    }

    try {
      const checkpoint = await this.remote.runRemote("git rev-parse HEAD", {
        cwd: remoteProjectPath,
        timeoutMs: 15_000,
      });
      const checkpointSha = checkpoint.stdout.trim();
      this.state.setCheckpointSha(runId, checkpointSha);

      this.logEvent(runId, "swarm_checkpoint_created", {
        session,
        checkpointSha,
        remoteProjectPath,
        requestedAgents: count,
        budgetUsd: options.budgetUsd ?? null,
      });

      const spawnResult = await this.ntm.spawn(session, count, options.spawn);
      const commitAgentRequested = options.includeCommitAgent !== false;

      this.logEvent(runId, "swarm_spawned", {
        session,
        remoteProjectPath,
        paneCount: spawnResult.paneCount ?? null,
        commitAgentRequested,
        budgetUsd: options.budgetUsd ?? null,
      });

      if (commitAgentRequested && options.commitPane !== undefined) {
        await this.sendNamedPrompt(
          runId,
          session,
          [options.commitPane],
          options.commitPromptName ?? "commit-work",
          "swarm_commit_prompt_sent"
        );
      } else if (commitAgentRequested) {
        this.logEvent(runId, "swarm_commit_agent_requested", {
          session,
          note:
            "Commit agent policy recorded. Prompt injection is deferred until a commit pane is identified by the CLI layer.",
        });
      }

      return {
        runId,
        session,
        remoteProjectPath,
        checkpointSha,
        paneCount: spawnResult.paneCount,
        commitAgentRequested,
        budgetUsd: options.budgetUsd,
        raw: spawnResult.raw,
      };
    } finally {
      this.ssh.disconnect();
    }
  }

  async pause(projectName: string, session: string, runId?: string): Promise<void> {
    if (!runId) {
      // Look up the most recent run for this project rather than creating a phantom run
      const runs = this.state.listFlywheelRuns();
      const existing = runs.find((r) => r.project_name === projectName);
      if (!existing) {
        throw new Error(`No flywheel run found for project "${projectName}". Start one with flywheel swarm.`);
      }
      runId = existing.id;
    }
    await this.ssh.connect();
    await this.ntm.pause(session);
    this.logEvent(runId, "swarm_paused", { session });
  }

  async resume(
    projectName: string,
    session: string,
    options: ResumeSwarmOptions = {}
  ): Promise<number[]> {
    let runId = options.runId;
    if (!runId) {
      const runs = this.state.listFlywheelRuns();
      const existing = runs.find((r) => r.project_name === projectName);
      if (!existing) {
        throw new Error(`No flywheel run found for project "${projectName}". Start one with flywheel swarm.`);
      }
      runId = existing.id;
    }
    await this.ssh.connect();

    const panes = options.panes ?? (await this.inferAgentPanes(session));
    const promptName = options.promptName;
    if (!promptName) {
      throw new Error(
        'Swarm resume requires an explicit promptName. The built-in "agent-unstuck" prompt is reserved for stalled agents, not normal pause/resume.'
      );
    }
    await this.sendNamedPrompt(runId, session, panes, promptName, "swarm_resumed");

    return panes;
  }

  async status(session: string, options: SwarmStatusOptions = {}): Promise<SwarmStatus> {
    await this.ssh.connect();
    if (options.autoNudgeStuck && !options.runId) {
      throw new Error("autoNudgeStuck requires a runId so prompt sends can be logged correctly.");
    }
    const agents = await this.ntm.activity(session);
    const stuckPanes = agents
      .filter((agent) => agent.status === "stuck" && agent.type !== "user")
      .map((agent) => agent.pane);

    const totalCostUsd =
      options.runId !== undefined ? this.state.getTotalCost(options.runId) : undefined;
    const overBudget =
      options.budgetUsd !== undefined &&
      totalCostUsd !== undefined &&
      totalCostUsd >= options.budgetUsd;

    const nudgedPanes =
      options.autoNudgeStuck && options.runId && stuckPanes.length > 0
        ? await this.sendNamedPrompt(
            options.runId,
            session,
            stuckPanes,
            options.stuckPromptName ?? "agent-unstuck",
            "swarm_stuck_agents_nudged"
          )
        : [];

    if (options.runId && overBudget) {
      this.logEvent(options.runId, "swarm_budget_exceeded", {
        session,
        budgetUsd: options.budgetUsd,
        totalCostUsd,
      });
    }

    return {
      session,
      agents,
      stuckPanes,
      nudgedPanes,
      totalCostUsd,
      budgetUsd: options.budgetUsd,
      overBudget,
    };
  }

  private async inferAgentPanes(session: string): Promise<number[]> {
    const agents = await this.ntm.activity(session);
    const panes = agents
      .filter((agent) => agent.type !== "user")
      .map((agent) => agent.pane);

    if (panes.length === 0) {
      throw new Error(`No non-user agent panes discovered for session "${session}".`);
    }

    return panes;
  }

  private assertBudget(runId: string, budgetUsd?: number): void {
    if (budgetUsd === undefined) {
      return;
    }

    const totalCostUsd = this.state.getTotalCost(runId);
    if (totalCostUsd >= budgetUsd) {
      throw new Error(
        `Budget cap exceeded before swarm start: $${totalCostUsd.toFixed(4)} >= $${budgetUsd.toFixed(4)}`
      );
    }
  }

  private async sendNamedPrompt(
    runId: string,
    session: string,
    panes: number[],
    promptName: string,
    eventType: string
  ): Promise<number[]> {
    const prompt = getPrompt(this.prompts, promptName);
    const dispatched: number[] = [];

    for (const pane of panes) {
      await this.ntm.send(session, pane, prompt.text.trim());
      this.state.logPromptSend(promptName, `${session}:${pane}`, runId);
      dispatched.push(pane);
    }

    this.logEvent(runId, eventType, {
      session,
      panes: dispatched,
      promptName,
      model: prompt.model,
      effort: prompt.effort,
    });

    return dispatched;
  }

  private logEvent(runId: string, eventType: string, payload: unknown, phase: Phase = "swarm"): void {
    this.state.logEvent(runId, eventType, payload, {
      actor: "flywheel",
      phaseTo: phase,
    });
  }
}

function getPrompt(prompts: Record<string, Prompt>, promptName: string): Prompt {
  const prompt = prompts[promptName];
  if (!prompt) {
    throw new Error(`Prompt "${promptName}" is missing from prompts.yaml.`);
  }
  return prompt;
}

export function defaultSessionName(projectName: string): string {
  const sanitized = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!sanitized) {
    throw new Error(
      `Cannot derive a valid NTM session name from project name "${projectName}". ` +
        `Use --session to specify one explicitly.`
    );
  }
  return sanitized;
}
