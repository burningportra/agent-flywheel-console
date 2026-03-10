// Phase 1 Planning Wizard
// Workflow: PARALLEL FAN-OUT (Opus + GPT-4o + Gemini)
//   → Synthesis Pass 1 (Opus)
//   → Synthesis Pass 2 (Opus)
//   → Adversarial Challenge (Opus)
//   → Brilliant Ideas × 3 (Opus)
//   → GATE
//   → Output: plan.md + wizard-log.jsonl

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import chalk from "chalk";
import { StateManager, initDb } from "./state.js";
import { SSHManager } from "./ssh.js";
import { shellQuote, getErrorMessage } from "./utils.js";
import {
  loadProvidersConfig,
  computeCost,
  type ProviderSlot,
} from "./config.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WizardOptions {
  /** Override competing models (comma-separated model names) */
  models?: string[];
  /** Skip fan-out: 1 synthesis pass + 1 ideas round */
  fast?: boolean;
  /** Copy plan.md + wizard-log.jsonl to VPS after completion */
  pushArtifacts?: boolean;
  /** Directory to write outputs (default: ./wizard-output) */
  outputDir?: string;
}

export interface WizardResult {
  planPath: string;
  logPath: string;
  runId: string;
  totalCostUsd: number;
  remotePlanPath?: string;
  remoteLogPath?: string;
}

interface ModelResponse {
  model: string;
  content: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error?: string;
}

interface LogEntry {
  step: string;
  model: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  tokens?: { input: number; output: number };
  durationMs?: number;
  error?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/";

// System prompt for the planning fan-out
const FANOUT_SYSTEM =
  "You are a seasoned software architect and product designer. " +
  "Your job is to produce a comprehensive, structured project plan based on the user's idea. " +
  "Think deeply about architecture, user experience, data models, edge cases, and delivery sequence. " +
  "Format your plan in clear Markdown with sections for Overview, Goals, Architecture, Implementation Plan, and Risks.";

const SYNTHESIS_1_SYSTEM =
  "You are a master software architect synthesising competing project plans from multiple AI models. " +
  "Your task: read all submitted plans, extract the best ideas from each, resolve conflicts, " +
  "and produce ONE coherent master plan in Markdown. " +
  "Be opinionated. Choose the strongest option when plans disagree rather than hedging.";

const SYNTHESIS_2_SYSTEM =
  "You are refining a synthesised project plan for maximum clarity and actionability. " +
  "Sharpen the language, remove redundancy, strengthen the architecture section, " +
  "and ensure the Implementation Plan is sequenced correctly with explicit dependencies. " +
  "Keep the output in Markdown.";

const ADVERSARIAL_SYSTEM =
  "You are a skeptical senior engineer reviewing this plan before any code is written. " +
  "Identify: missing requirements, architectural decisions that will be hard to reverse, " +
  "scope that will expand unexpectedly, and assumptions unlikely to hold. " +
  "Output 3–7 named risks with brief explanations. Be direct. Do not suggest improvements — only surface problems.";

const IDEAS_SYSTEM =
  "You are a creative senior engineer brainstorming enhancements to this project plan. " +
  "Think of 100 possible improvements, then select the 10 most impactful, creative, and feasible. " +
  "For each idea, give a 1-sentence name and a 2-3 sentence explanation. Be bold.";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isClaudeModel(model: string): boolean {
  return model.startsWith("claude-");
}

function isGeminiModel(model: string): boolean {
  return model.startsWith("gemini-");
}

function renderLabel(model: string): string {
  if (isClaudeModel(model)) return chalk.blue(`[${model}]`);
  if (isGeminiModel(model)) return chalk.green(`[${model}]`);
  return chalk.yellow(`[${model}]`);
}

function ts(): string {
  return new Date().toISOString();
}


function makeAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}

function makeOpenAIClient(apiKey: string, baseURL?: string): OpenAI {
  return new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
}

// ─── Model callers ────────────────────────────────────────────────────────────

async function callClaude(
  client: Anthropic,
  model: string,
  systemPrompt: string,
  userMessage: string,
  onChunk?: (text: string) => void
): Promise<Omit<ModelResponse, "model">> {
  const t0 = Date.now();
  let content = "";
  let inputTokens = 0;
  let outputTokens = 0;

  const stream = client.messages.stream({
    model,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      content += event.delta.text;
      onChunk?.(event.delta.text);
    } else if (event.type === "message_start" && event.message.usage) {
      inputTokens = event.message.usage.input_tokens;
    } else if (event.type === "message_delta" && event.usage) {
      outputTokens = event.usage.output_tokens;
    }
  }

  return { content, inputTokens, outputTokens, durationMs: Date.now() - t0 };
}

async function callOpenAICompat(
  client: OpenAI,
  model: string,
  systemPrompt: string,
  userMessage: string,
  onChunk?: (text: string) => void
): Promise<Omit<ModelResponse, "model">> {
  const t0 = Date.now();
  let content = "";
  let inputTokens = 0;
  let outputTokens = 0;

  const stream = await client.chat.completions.create({
    model,
    max_tokens: 8192,
    stream: true,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      content += delta;
      onChunk?.(delta);
    }
    // usage arrives in the final chunk for both OpenAI and Gemini
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens;
      outputTokens = chunk.usage.completion_tokens;
    }
  }

  return { content, inputTokens, outputTokens, durationMs: Date.now() - t0 };
}

// ─── WizardRunner ─────────────────────────────────────────────────────────────

export class WizardRunner {
  private log: LogEntry[] = [];
  private state: StateManager;
  private runId: string;
  private projectName: string;
  private totalCostUsd = 0;

  constructor(projectName: string) {
    this.projectName = projectName;
    const db = initDb();
    this.state = new StateManager(db);
    this.runId = "";
  }

  /** Run the full wizard for the given idea. */
  async run(idea: string, opts: WizardOptions = {}): Promise<WizardResult> {
    // Create DB run record
    this.runId = this.state.createWizardRun(this.projectName, idea);
    const outputDir = opts.outputDir ?? join(process.cwd(), "wizard-output", this.runId);
    mkdirSync(outputDir, { recursive: true });

    let providers;
    try {
      providers = loadProvidersConfig();
    } catch (e) {
      console.error(chalk.red((e as Error).message));
      this.state.failWizardRun(this.runId);
      throw e;
    }

    const pricing = providers.pricing;

    // Resolve plan slots (competing models)
    const planSlots: ProviderSlot[] = providers.slots.plan ?? [];
    if (planSlots.length === 0) {
      throw new Error(
        "No plan slots configured in providers.yaml. Add at least one model under slots.plan."
      );
    }

    // Override models if --models flag was passed
    const effectiveSlots: ProviderSlot[] = opts.models
      ? opts.models.map((m) => {
          const match = planSlots.find((s) => s.model === m);
          if (!match)
            throw new Error(
              `Model ${m} not found in providers.yaml slots.plan`
            );
          return match;
        })
      : planSlots;

    // Synthesis slot (always Opus / first synthesis slot)
    const synthSlots = providers.slots.synthesis ?? planSlots;
    const synthSlot = synthSlots[0];
    if (!synthSlot || !isClaudeModel(synthSlot.model)) {
      throw new Error(
        "Synthesis slot must be a Claude model (claude-*). Check providers.yaml slots.synthesis."
      );
    }

    const anthropicSynth = makeAnthropicClient(synthSlot.key);

    console.log(chalk.bold("\n🧠 Phase 1 Planning Wizard\n"));
    console.log(chalk.gray(`Idea: ${idea}\n`));
    console.log(chalk.bold("Plan setup"));
    console.log(chalk.gray(`  Project: ${this.projectName}`));
    console.log(chalk.gray(`  Output:  ${outputDir}`));
    console.log(
      chalk.gray(
        `  Models:  ${opts.fast ? `${synthSlot.model} (--fast)` : effectiveSlots.map((slot) => slot.model).join(", ")}`
      )
    );
    console.log(
      chalk.gray(
        `  Upload:  ${opts.pushArtifacts ? "enabled (copy to VPS project dir after completion)" : "local only"}\n`
      )
    );

    try {
      // ── Step 1: Parallel fan-out ───────────────────────────────────────────

      let fanOutResponses: ModelResponse[] = [];

      if (opts.fast) {
        console.log(chalk.gray("(--fast mode: skipping fan-out)\n"));
      } else {
        console.log(chalk.bold("Step 1: Parallel fan-out across models\n"));
        fanOutResponses = await this.parallelFanOut(
          effectiveSlots,
          idea,
          pricing
        );

        // Fail loudly if all models failed (pitch requirement)
        const failed = fanOutResponses.filter((r) => r.error);
        if (failed.length > 0) {
          console.warn(
            chalk.yellow(
              `\n⚠ ${failed.length} model(s) failed: ${failed.map((r) => r.model).join(", ")}`
            )
          );
          if (failed.length >= effectiveSlots.length) {
            throw new Error("All models failed during fan-out. Cannot continue.");
          }
        }
      }

      // ── Step 2: Synthesis Pass 1 ─────────────────────────────────────────

      console.log(chalk.bold("\nStep 2: Synthesis Pass 1\n"));

      const synthInput1 = opts.fast
        ? `Project idea: ${idea}\n\nProduce a comprehensive plan.`
        : `Project idea: ${idea}\n\n---\n\n${fanOutResponses
            .filter((r) => !r.error)
            .map(
              (r, i) =>
                `## Plan from ${r.model} (${i + 1} of ${fanOutResponses.length})\n\n${r.content}`
            )
            .join("\n\n---\n\n")}`;

      const synth1 = await this.callSynthModel(
        anthropicSynth,
        synthSlot.model,
        SYNTHESIS_1_SYSTEM,
        synthInput1,
        "synthesis-1",
        pricing
      );

      // ── Step 3: Synthesis Pass 2 (skip in --fast mode) ────────────────────

      let finalPlan = synth1.content;

      if (!opts.fast) {
        console.log(chalk.bold("\nStep 3: Synthesis Pass 2\n"));

        const synth2 = await this.callSynthModel(
          anthropicSynth,
          synthSlot.model,
          SYNTHESIS_2_SYSTEM,
          `Here is the initial synthesis. Refine it:\n\n${synth1.content}`,
          "synthesis-2",
          pricing
        );

        finalPlan = synth2.content;
      }

      // ── Step 4: Adversarial Challenge ──────────────────────────────────────

      console.log(chalk.bold("\nStep 4: Adversarial Challenge\n"));

      const adversarial = await this.callSynthModel(
        anthropicSynth,
        synthSlot.model,
        ADVERSARIAL_SYSTEM,
        `Here is the plan to stress-test:\n\n${finalPlan}`,
        "adversarial",
        pricing
      );

      // ── Step 5: Brilliant Ideas (3 rounds; 1 in --fast mode) ──────────────

      const ideasRounds = opts.fast ? 1 : 3;
      const allIdeas: string[] = [];

      for (let i = 1; i <= ideasRounds; i++) {
        console.log(chalk.bold(`\nStep 5.${i}: Brilliant Ideas (round ${i})\n`));

        // Round 1: ask about the plan; subsequent rounds: avoid repeats
        const ideasPrompt =
          i === 1
            ? `Here is the plan:\n\n${finalPlan}`
            : `Here is the plan:\n\n${finalPlan}\n\nPrevious idea rounds:\n${allIdeas.join("\n---\n")}\n\nGenerate a fresh round of 10 more brilliant enhancement ideas — no repeats from prior rounds.`;

        const ideas = await this.callSynthModel(
          anthropicSynth,
          synthSlot.model,
          IDEAS_SYSTEM,
          ideasPrompt,
          `ideas-${i}`,
          pricing
        );

        allIdeas.push(ideas.content);
      }

      // ── Assemble plan.md ───────────────────────────────────────────────────

      const planMd = this.assemblePlan(idea, finalPlan, adversarial.content, allIdeas);

      const planPath = join(outputDir, "plan.md");
      const logPath = join(outputDir, "wizard-log.jsonl");

      writeFileSync(planPath, planMd, "utf8");
      writeFileSync(
        logPath,
        this.log.map((e) => JSON.stringify(e)).join("\n") + "\n",
        "utf8"
      );

      this.state.completeWizardRun(this.runId, planPath);

      let remoteArtifacts:
        | { projectPath: string; planPath: string; logPath: string }
        | undefined;

      if (opts.pushArtifacts) {
        console.log(chalk.bold("\nStep 6: Upload artifacts to VPS\n"));
        try {
          remoteArtifacts = await this.pushArtifactsToVps(
            planMd,
            this.log.map((e) => JSON.stringify(e)).join("\n") + "\n"
          );
          console.log(chalk.green("✓ Remote artifacts updated"));
          console.log(chalk.gray(`  Project: ${remoteArtifacts.projectPath}`));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(chalk.yellow(`⚠ Remote upload failed: ${message}`));
          console.warn(
            chalk.gray("  Local artifacts were still written successfully. You can retry later after fixing SSH.")
          );
        }
      }

      console.log(chalk.green(`\n✅ Wizard complete!`));
      console.log(`   Plan:     ${planPath}`);
      console.log(`   Log:      ${logPath}`);
      console.log(`   Cost:     $${this.totalCostUsd.toFixed(4)}`);
      if (remoteArtifacts) {
        console.log(`   VPS plan: ${remoteArtifacts.planPath}`);
        console.log(`   VPS log:  ${remoteArtifacts.logPath}`);
      }
      console.log(chalk.gray("\nNext steps"));
      const nextSteps = [
        "Review plan.md and make any human edits before proceeding.",
      ];
      if (!remoteArtifacts && opts.pushArtifacts) {
        nextSteps.push("Re-run with working SSH or manually copy the artifacts to the VPS.");
      } else if (!opts.pushArtifacts) {
        nextSteps.push("Re-run with --push-artifacts if you want Phase 2 to see the plan on the VPS.");
      }
      nextSteps.push("Run: flywheel beads generate");
      for (const [index, step] of nextSteps.entries()) {
        console.log(chalk.gray(`  ${index + 1}. ${step}`));
      }

      return {
        planPath,
        logPath,
        runId: this.runId,
        totalCostUsd: this.totalCostUsd,
        remotePlanPath: remoteArtifacts?.planPath,
        remoteLogPath: remoteArtifacts?.logPath,
      };
    } catch (err) {
      // Mark run failed so it doesn't stay "running" forever
      this.state.failWizardRun(this.runId);
      throw err;
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async parallelFanOut(
    slots: ProviderSlot[],
    idea: string,
    pricing: Record<string, { input_per_mtok: number; output_per_mtok: number }>
  ): Promise<ModelResponse[]> {
    const userMessage = `Project idea: ${idea}\n\nProduce a comprehensive project plan.`;

    // Track which model is currently printing to avoid interleaved gibberish.
    // We run them in parallel but prefix every chunk with the model label.
    const results = await Promise.allSettled(
      slots.map(async (slot): Promise<ModelResponse> => {
        const label = renderLabel(slot.model);
        process.stdout.write(`${label} starting...\n`);

        this.addLog({ step: "fanout", model: slot.model, role: "user", content: userMessage });

        try {
          let resp: Omit<ModelResponse, "model">;
          if (isClaudeModel(slot.model)) {
            const client = makeAnthropicClient(slot.key);
            resp = await callClaude(
              client,
              slot.model,
              FANOUT_SYSTEM,
              userMessage,
              (chunk) => process.stdout.write(`${label} ${chunk}`)
            );
          } else {
            const baseURL = isGeminiModel(slot.model)
              ? GEMINI_BASE_URL
              : undefined;
            const client = makeOpenAIClient(slot.key, baseURL);
            resp = await callOpenAICompat(
              client,
              slot.model,
              FANOUT_SYSTEM,
              userMessage,
              (chunk) => process.stdout.write(`${label} ${chunk}`)
            );
          }

          const costUsd = computeCost(slot.model, { input: resp.inputTokens, output: resp.outputTokens }, pricing);
          this.totalCostUsd += costUsd;
          this.state.logApiCall(this.runId, "plan", slot.model, { input: resp.inputTokens, output: resp.outputTokens }, costUsd);

          this.addLog({
            step: "fanout",
            model: slot.model,
            role: "assistant",
            content: resp.content,
            tokens: { input: resp.inputTokens, output: resp.outputTokens },
            durationMs: resp.durationMs,
          });

          process.stdout.write(`\n${label} ✓ (${Math.round(resp.durationMs / 1000)}s, $${costUsd.toFixed(4)})\n\n`);
          return { model: slot.model, ...resp };
        } catch (err) {
          const msg = getErrorMessage(err);
          process.stdout.write(`\n${label} ✗ ${msg}\n\n`);
          this.addLog({ step: "fanout", model: slot.model, role: "assistant", content: "", error: msg });
          return { model: slot.model, content: "", inputTokens: 0, outputTokens: 0, durationMs: 0, error: msg };
        }
      })
    );

    return results.map((r) => {
      if (r.status === "fulfilled") return r.value;
      const msg = getErrorMessage(r.reason);
      return { model: "unknown", content: "", inputTokens: 0, outputTokens: 0, durationMs: 0, error: msg };
    });
  }

  private async callSynthModel(
    client: Anthropic,
    model: string,
    system: string,
    userMessage: string,
    step: string,
    pricing: Record<string, { input_per_mtok: number; output_per_mtok: number }>
  ): Promise<ModelResponse> {
    const label = renderLabel(model);
    process.stdout.write(`${label} `);

    this.addLog({ step, model, role: "user", content: userMessage });

    const resp = await callClaude(client, model, system, userMessage, (chunk) =>
      process.stdout.write(chunk)
    );

    const costUsd = computeCost(model, { input: resp.inputTokens, output: resp.outputTokens }, pricing);
    this.totalCostUsd += costUsd;
    this.state.logApiCall(this.runId, "plan", model, { input: resp.inputTokens, output: resp.outputTokens }, costUsd);

    this.addLog({
      step,
      model,
      role: "assistant",
      content: resp.content,
      tokens: { input: resp.inputTokens, output: resp.outputTokens },
      durationMs: resp.durationMs,
    });

    process.stdout.write(`\n${label} ✓ (${Math.round(resp.durationMs / 1000)}s, $${costUsd.toFixed(4)})\n`);
    return { model, ...resp };
  }

  private addLog(entry: Omit<LogEntry, "timestamp">): void {
    this.log.push({ ...entry, timestamp: ts() });
  }

  private async pushArtifactsToVps(
    planContents: string,
    logContents: string
  ): Promise<{ projectPath: string; planPath: string; logPath: string }> {
    const ssh = new SSHManager();

    try {
      const config = await ssh.connect();
      const projectPath = `${config.remoteRepoRoot.replace(/\/+$/, "")}/${this.projectName}`;
      const remotePlanPath = `${projectPath}/plan.md`;
      const remoteLogPath = `${projectPath}/wizard-log.jsonl`;

      await ssh.exec(`mkdir -p ${shellQuote(projectPath)}`, { timeoutMs: 10_000 });
      await ssh.exec(`cat > ${shellQuote(remotePlanPath)}`, {
        stdin: planContents.endsWith("\n") ? planContents : `${planContents}\n`,
        noTrim: true,
        timeoutMs: 15_000,
      });
      await ssh.exec(`cat > ${shellQuote(remoteLogPath)}`, {
        stdin: logContents,
        noTrim: true,
        timeoutMs: 15_000,
      });

      return {
        projectPath,
        planPath: remotePlanPath,
        logPath: remoteLogPath,
      };
    } finally {
      ssh.disconnect();
    }
  }

  private assemblePlan(
    idea: string,
    plan: string,
    risks: string,
    ideas: string[]
  ): string {
    const header = [
      `# Plan: ${idea}`,
      ``,
      `_Generated by flywheel Planning Wizard — ${new Date().toISOString()}_`,
      ``,
    ].join("\n");

    const riskSection = [
      `## Adversarial Risk Assessment`,
      ``,
      risks,
      ``,
    ].join("\n");

    const ideasSection = [
      `## Brilliant Enhancement Ideas`,
      ``,
      ...ideas.flatMap((round, i) => [
        `### Round ${i + 1}`,
        ``,
        round,
        ``,
      ]),
    ].join("\n");

    return [header, plan, `---`, riskSection, `---`, ideasSection].join("\n");
  }
}

// ─── Convenience export ───────────────────────────────────────────────────────

/** Run the Planning Wizard. Top-level entry used by cli/index.ts. */
export async function runWizard(
  projectName: string,
  idea: string,
  opts: WizardOptions = {}
): Promise<WizardResult> {
  const runner = new WizardRunner(projectName);
  return runner.run(idea, opts);
}
