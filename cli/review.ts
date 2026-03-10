import { loadPrompts, type Prompt } from "./prompts.js";
import { initDb, StateManager } from "./state.js";
import { NtmBridge } from "./ntm-bridge.js";
import { RemoteCommandRunner } from "./remote.js";
import { SSHManager } from "./ssh.js";

export const REVIEW_PASSES = [
  "fresh-review",
  "peer-review",
  "ui-ux-scrutiny",
  "ubs-scan",
  "test-coverage",
  "orm-audit",
  "tanstack-optimize",
  "dcg-safety",
] as const;

export type ReviewPass = (typeof REVIEW_PASSES)[number];

export interface RunReviewOptions {
  passes?: string[];
  panes?: number[];
  runId?: string;
}

export interface ReviewDispatch {
  pass: ReviewPass;
  pane: number;
}

export interface RunReviewResult {
  runId: string;
  session: string;
  dispatched: ReviewDispatch[];
}

export class ReviewCoordinator {
  private readonly ssh: SSHManager;
  private readonly ntm: NtmBridge;
  private readonly state: StateManager;
  private readonly prompts = loadPrompts();

  constructor(deps?: { ssh?: SSHManager; ntm?: NtmBridge; state?: StateManager }) {
    this.ssh = deps?.ssh ?? new SSHManager();
    this.ntm = deps?.ntm ?? new NtmBridge(new RemoteCommandRunner(this.ssh));
    this.state = deps?.state ?? new StateManager(initDb());
  }

  async run(projectName: string, session: string, options: RunReviewOptions = {}): Promise<RunReviewResult> {
    await this.ssh.connect();

    try {
      const passes = resolveReviewPasses(options.passes);
      const panes = options.panes ?? (await this.inferPanes(session));
      const runId = options.runId ?? this.state.createFlywheelRun(projectName, "review");
      const dispatched: ReviewDispatch[] = [];

      this.state.logEvent(
        runId,
        "review_started",
        { session, passes, panes },
        { actor: "flywheel", phaseTo: "review" }
      );

      for (const pass of passes) {
        const prompt = getPromptForPass(this.prompts, pass);

        // Send to all panes in parallel within each pass (passes stay sequential
        // so agents finish each pass before moving to the next).
        await Promise.all(
          panes.map(async (pane) => {
            await this.ntm.send(session, pane, prompt.text.trim());
            this.state.logPromptSend(pass, `${session}:${pane}`, runId);
            this.state.logEvent(
              runId,
              "review_prompt_sent",
              { session, pane, pass, model: prompt.model, effort: prompt.effort },
              { actor: "flywheel", phaseTo: "review" }
            );
            dispatched.push({ pass, pane });
          })
        );
      }

      return { runId, session, dispatched };
    } finally {
      this.ssh.disconnect();
    }
  }

  private async inferPanes(session: string): Promise<number[]> {
    const agents = await this.ntm.activity(session);
    const panes = agents
      .filter((agent) => agent.type !== "user")
      .map((agent) => agent.pane);

    if (panes.length === 0) {
      throw new Error(
        `No non-user agent panes discovered for session "${session}". Pass explicit pane IDs to run review prompts.`
      );
    }

    return panes;
  }
}

function resolveReviewPasses(input?: string[]): ReviewPass[] {
  if (!input || input.length === 0) {
    return [...REVIEW_PASSES];
  }

  const normalized = [...new Set(input.map((entry) => entry.trim()).filter(Boolean))];
  const invalid = normalized.filter(
    (entry): entry is string => !REVIEW_PASSES.includes(entry as ReviewPass)
  );

  if (invalid.length > 0) {
    throw new Error(
      `Unknown review passes: ${invalid.join(", ")}. Valid passes: ${REVIEW_PASSES.join(", ")}`
    );
  }

  return normalized as ReviewPass[];
}

function getPromptForPass(prompts: Record<string, Prompt>, pass: ReviewPass): Prompt {
  const prompt = prompts[pass];
  if (!prompt) {
    throw new Error(`Prompt "${pass}" is missing from prompts.yaml.`);
  }
  return prompt;
}
