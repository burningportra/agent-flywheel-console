#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { printPromptList, printPrompt, parseVarArgs, sendPrompt } from "./prompts.js";
import { runWizard } from "./wizard.js";
import { listRuns, replayRun } from "./runs.js";
import { SSHManager, SSHError } from "./ssh.js";
import { StateManager, initDb } from "./state.js";
import { gateStatus, gateAdvance } from "./gate.js";
import { runDoctor } from "./doctor.js";
import { configureSshSettings } from "./settings.js";
import { printProviders } from "./providers.js";
import { SwarmCoordinator } from "./swarm.js";
import { runRollback } from "./rollback.js";
import { ReviewCoordinator } from "./review.js";
import { DeployCoordinator, requiredDeployConfirmation } from "./deploy.js";
import { createFlywheelServer } from "./server.js";
import { runBeadGenerate, runBeadRefine, runBeadTriage, runBeadHistory } from "./beads.js";
import { runInit } from "./init.js";
import { runMonitor } from "./monitor.js";
import { runAutopilot } from "./autopilot.js";
import { getProjectName } from "./utils.js";

/** Parse a positive integer CLI option; exits with error on invalid input. */
function parsePositiveInt(raw: string, flag: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(chalk.red(`✗ ${flag} must be a positive integer (got: ${JSON.stringify(raw)})`));
    process.exit(1);
  }
  return n;
}

/** Parse a positive dollar amount CLI option; exits with error on invalid input. */
function parsePositiveBudget(raw: string): number {
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(chalk.red(`✗ --budget must be a positive number in USD (got: ${JSON.stringify(raw)})`));
    process.exit(1);
  }
  return n;
}

function parseReplayFormat(raw: string): "text" | "json" {
  if (raw !== "text" && raw !== "json") {
    console.error(chalk.red(`✗ --format must be either "text" or "json" (got: ${JSON.stringify(raw)})`));
    process.exit(1);
  }
  return raw;
}

function parseServePort(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.error(chalk.red(`✗ --port must be an integer between 0 and 65535 (got: ${JSON.stringify(raw)})`));
    process.exit(1);
  }
  return n;
}

const program = new Command();

program
  .name("flywheel")
  .description(
    "Local control plane for the agentic coding flywheel — orchestrate Plan → Beads → Swarm → Review → Deploy on a remote VPS over SSH."
  )
  .version("0.1.0");

// Setup + Infra
program
  .command("settings")
  .description("Configure flywheel settings")
  .command("ssh")
  .description("Configure VPS SSH connection")
  .action(async () => {
    try {
      await configureSshSettings();
    } catch (err) {
      console.error(
        chalk.red(
          `✗ Failed to save SSH settings: ${err instanceof Error ? err.message : String(err)}`
        )
      );
      process.exit(1);
    }
  });

program
  .command("ssh")
  .description("SSH connection management")
  .command("test")
  .description("Test SSH connection + measure latency")
  .action(async () => {
    const manager = new SSHManager();
    const db = initDb();
    const state = new StateManager(db);
    let connId: number | undefined;
    let exitCode = 0;
    try {
      const config = await manager.connect();
      connId = state.recordSshConnect(config.host);
      const latencyMs = await manager.getLatency();
      state.recordSshDisconnect(connId, latencyMs);
      console.log(
        chalk.green(`✓ Connected to ${config.user}@${config.host}:${config.port} — ${latencyMs}ms`)
      );
    } catch (err) {
      if (connId !== undefined) {
        state.recordSshDisconnect(connId);
      }
      if (err instanceof SSHError) {
        console.error(chalk.red(`✗ ${err.message}`));
      } else {
        console.error(
          chalk.red(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`)
        );
      }
      exitCode = 1;
    } finally {
      manager.disconnect();
    }
    process.exit(exitCode);
  });

program
  .command("preflight")
  .description("Verify remote tools on VPS")
  .option("--force", "Warn but continue on missing tools")
  .action(async (opts: { force?: boolean }) => {
    const REQUIRED_TOOLS = ["ntm", "br", "bv", "gh", "git"];
    const RECOMMENDED_TOOLS = ["agent-mail", "ubs", "dcg", "cass", "cm"];

    const manager = new SSHManager();
    try {
      await manager.connect();
    } catch (err) {
      console.error(chalk.red(`✗ SSH connection failed: ${err instanceof Error ? err.message : String(err)}`));
      console.error(chalk.dim("  Run: flywheel doctor — for full diagnostics"));
      process.exit(1);
    }

    const checkTool = async (tool: string): Promise<{ found: boolean; version?: string }> => {
      try {
        const which = await manager.exec(`which ${tool}`);
        if (which.code !== 0 || !which.stdout.trim()) return { found: false };
        const ver = await manager.exec(`${tool} --version 2>&1 | head -1`);
        const version = ver.code === 0 && ver.stdout.trim() ? ver.stdout.trim() : undefined;
        return { found: true, version };
      } catch {
        return { found: false };
      }
    };

    // Check all tools in parallel — avoids 20 sequential SSH round-trips.
    const [requiredResults, recommendedResults] = await Promise.all([
      Promise.all(REQUIRED_TOOLS.map((t) => checkTool(t))),
      Promise.all(RECOMMENDED_TOOLS.map((t) => checkTool(t))),
    ]);

    let requiredMissing = false;
    console.log(chalk.bold("Required tools:"));
    for (let i = 0; i < REQUIRED_TOOLS.length; i++) {
      const tool = REQUIRED_TOOLS[i];
      const { found, version } = requiredResults[i];
      if (found) {
        const vInfo = version ? chalk.dim(` (${version})`) : "";
        console.log(chalk.green(`  ✓ ${tool}`) + vInfo);
      } else if (opts.force) {
        console.log(chalk.yellow(`  ⚠ ${tool} — not found`));
        requiredMissing = true;
      } else {
        console.log(chalk.red(`  ✗ ${tool} — not found`));
        requiredMissing = true;
      }
    }

    console.log(chalk.bold("\nRecommended tools:"));
    for (let i = 0; i < RECOMMENDED_TOOLS.length; i++) {
      const tool = RECOMMENDED_TOOLS[i];
      const { found, version } = recommendedResults[i];
      if (found) {
        const vInfo = version ? chalk.dim(` (${version})`) : "";
        console.log(chalk.green(`  ✓ ${tool}`) + vInfo);
      } else {
        console.log(chalk.yellow(`  ⚠ ${tool} — not found`));
      }
    }

    manager.disconnect();

    if (requiredMissing && !opts.force) {
      console.error(
        chalk.red("\nPreflight failed: required tools missing. Use --force to continue.")
      );
      process.exit(3);
    }
    if (requiredMissing && opts.force) {
      console.log(chalk.yellow("\nPreflight: required tools missing — continuing with --force."));
      process.exit(2);
    }
    console.log(chalk.green("\nAll required checks passed ✓"));
    process.exit(0);
  });

program
  .command("doctor")
  .description("Full diagnostic: SSH, tools, config, API keys, CAAM, SQLite")
  .action(async () => {
    await runDoctor();
  });

program
  .command("providers")
  .description("Show model slot usage + rotation state")
  .action(() => {
    printProviders();
  });

// Project init
program
  .command("init <project-name>")
  .description("Create project dir + config on VPS")
  .action(async (name: string) => {
    await runInit(name);
  });

// Phase 1: Plan
program
  .command("new <idea>")
  .description("Run Phase 1 Planning Wizard")
  .option("--models <models>", "Override competing models (comma-separated)")
  .option("--fast", "Skip fan-out; 1 synthesis pass + 1 ideas round")
  .option("--push-artifacts", "Copy plan.md + wizard-log.jsonl to VPS")
  .action(async (idea, opts) => {
    const models = opts.models?.split(",").map((m: string) => m.trim());
    await runWizard(getProjectName(), idea, {
      models,
      fast: opts.fast,
      pushArtifacts: opts.pushArtifacts,
    });
  });

// Phase 2: Beads
const beads = program
  .command("beads")
  .description("Bead management (generate, refine, triage)");

beads
  .command("generate")
  .description("2A: Generate beads from plan")
  .action(async () => {
    await runBeadGenerate();
  });

beads
  .command("refine")
  .description("2B: Review and refine beads")
  .action(async () => {
    await runBeadRefine();
  });

beads
  .command("triage")
  .description("2C: Run bv --robot-triage + br blocked + br ready")
  .option("--top <n>", "Number of top picks to show", "5")
  .action(async (opts: { top: string }) => {
    await runBeadTriage({ top: parsePositiveInt(opts.top, "--top") });
  });

beads
  .command("history")
  .description("Show bead board state at a past timestamp")
  .option("--at <time>", "Timestamp to query (ISO or shorthand: 1h, 30m)")
  .action((opts: { at?: string }) => {
    runBeadHistory({ at: opts.at });
  });

// Phase 3: Swarm
program
  .command("swarm <count>")
  .description("Spawn N agents on VPS (includes commit agent)")
  .option("--no-commit", "Skip commit agent")
  .option("--budget <amount>", "Hard-stop if projected spend exceeds amount")
  .action(async (count: string, opts: { commit?: boolean; budget?: string }) => {
    const projectName = getProjectName();
    const coordinator = new SwarmCoordinator();
    const parsedCount = parsePositiveInt(count, "<count>");
    try {
      const result = await coordinator.start(projectName, parsedCount, {
        includeCommitAgent: opts.commit !== false,
        budgetUsd: opts.budget !== undefined ? parsePositiveBudget(opts.budget) : undefined,
      });
      console.log(
        chalk.green(
          `✓ Swarm started — session "${result.session}", ${result.paneCount ?? parsedCount} agent pane(s)`
        )
      );
      console.log(
        chalk.dim(`  Run: ${result.runId.slice(0, 8)} | Checkpoint: ${result.checkpointSha.slice(0, 12)}`)
      );
      if (result.budgetUsd !== undefined) {
        console.log(chalk.dim(`  Budget cap: $${result.budgetUsd.toFixed(2)}`));
      }
      console.log();
      console.log(chalk.dim("  Watch agents: ") + chalk.bold("flywheel monitor"));
      console.log(chalk.dim("  When done:    ") + chalk.bold("flywheel review"));
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

program
  .command("rollback [run-id]")
  .description("Reset VPS repo to pre-swarm checkpoint SHA")
  .action(async (runId?: string) => {
    await runRollback({ runId });
  });

// Phase 4: Review
program
  .command("review")
  .description("Run Phase 4 review passes (8 named passes)")
  .option(
    "--passes <passes>",
    "Passes to run, comma-separated (default: all). Valid: fresh-review, peer-review, ui-ux-scrutiny, ubs-scan, test-coverage, orm-audit, tanstack-optimize, dcg-safety"
  )
  .option("--session <name>", "NTM session name from the swarm step (default: sanitized project name)")
  .action(async (opts: { passes?: string; session?: string }) => {
    const projectName = getProjectName();
    // Must match the session name that `flywheel swarm` creates (lowercased + sanitized).
    const session =
      opts.session ??
      projectName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const passes = opts.passes?.split(",").map((p: string) => p.trim());
    const coordinator = new ReviewCoordinator();
    try {
      const result = await coordinator.run(projectName, session, { passes });
      console.log(chalk.green(`✓ Review dispatched — ${result.dispatched.length} prompt(s) sent`));
      for (const d of result.dispatched) {
        console.log(chalk.dim(`  ${d.pass} → pane ${d.pane}`));
      }
      console.log();
      console.log(chalk.dim("  When agents finish: ") + chalk.bold("flywheel gate advance"));
      console.log(chalk.dim("  Then deploy:        ") + chalk.bold("flywheel deploy"));
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

// Phase 5: Deploy
program
  .command("deploy")
  .description("Final commit + push — requires typing DEPLOY <project-name> to confirm")
  .action(async () => {
    const projectName = getProjectName();
    const expected = requiredDeployConfirmation(projectName);
    console.log(chalk.yellow("⚠  This will commit all tracked changes and push to origin."));
    console.log();
    const { createInterface } = await import("readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const confirmation = await new Promise<string>((resolve) => {
      rl.question(chalk.bold(`Type "${expected}" to confirm: `), (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
    const coordinator = new DeployCoordinator();
    try {
      const result = await coordinator.deploy(projectName, confirmation);
      console.log();
      console.log(chalk.green("✓ Deploy complete"));
      console.log(chalk.dim(`  ${result.beforeSha.slice(0, 12)} → ${result.afterSha.slice(0, 12)}`));
      if (!result.trackedChangesPresent) {
        console.log(chalk.dim("  Workspace was clean — no commit needed, just pushed."));
      }
      console.log();
      console.log(chalk.bold("  Flywheel complete! ") + chalk.dim(`Project: ${projectName}`));
      process.exit(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n✗ ${msg}`));
      if (msg.toLowerCase().includes("confirmation")) {
        console.error(chalk.dim(`  Run "flywheel deploy" again and type exactly: ${expected}`));
      }
      process.exit(1);
    }
  });

// Autopilot
program
  .command("autopilot")
  .description("Run maintenance loop")
  .option("--tmux", "Detach into persistent tmux session")
  .option("--projects <scope>", "Run on all configured projects", "current")
  .option("--interval <seconds>", "Poll interval in seconds", "300")
  .action(async (opts: { tmux?: boolean; projects?: string; interval: string }) => {
    await runAutopilot({
      tmux: opts.tmux,
      projects: opts.projects,
      intervalSeconds: parsePositiveInt(opts.interval, "--interval"),
    });
  });

// Gates
const gate = program.command("gate").description("Gate management");

gate
  .command("advance")
  .description("Pass current human gate, proceed to next phase")
  .option("--run <id>", "Run ID to advance (default: most recent)")
  .option("--sha <sha>", "Git checkpoint SHA to record")
  .action((opts: { run?: string; sha?: string }) => {
    gateAdvance({ runId: opts.run, sha: opts.sha });
  });

gate
  .command("status")
  .description("Show current gate state")
  .action(() => {
    gateStatus();
  });

// Prompt library
const prompts = program.command("prompts").description("Prompt library");

prompts
  .command("list")
  .description("List all prompts with metadata")
  .action(() => {
    printPromptList();
  });

prompts
  .command("send <name>")
  .description("Preview or send a named prompt to agent(s)")
  .option("--agent <id>", "Target agent pane ID")
  .option("--all", "Broadcast to all agent panes")
  .option("--session <name>", "NTM session name (default: sanitized current directory)")
  .option(
    "--var <key=value>",
    "Set a variable for substitution (repeatable)",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .action(async (name: string, opts: { agent?: string; all?: boolean; session?: string; var: string[] }) => {
    if (opts.agent && opts.all) {
      console.error(chalk.red('✗ Use either "--agent <id>" or "--all", not both.'));
      process.exit(1);
    }

    const vars = parseVarArgs(opts.var);
    if (!opts.agent && !opts.all) {
      const ok = printPrompt(name, vars, { agent: opts.agent, all: opts.all });
      if (ok) {
        console.log(chalk.dim("\nPreview only. Add --agent <pane> or --all to deliver it."));
      } else {
        process.exit(1);
      }
      return;
    }

    const parsedPane =
      opts.agent !== undefined
        ? Number.parseInt(opts.agent, 10)
        : undefined;

    if (parsedPane !== undefined && (!Number.isInteger(parsedPane) || parsedPane <= 0)) {
      console.error(chalk.red(`Invalid --agent value: ${opts.agent}`));
      process.exit(1);
    }

    const promptTarget =
      parsedPane !== undefined
        ? { pane: parsedPane, all: opts.all, sessionName: opts.session }
        : { all: opts.all, sessionName: opts.session };

    try {
      const result = await sendPrompt(name, vars, promptTarget);

      console.log(
        chalk.green(
          `✓ Sent "${name}" to ${result.panes.length} pane(s) in session "${result.sessionName}"`
        )
      );
      for (const targetPane of result.panes) {
        console.log(chalk.dim(`  pane ${targetPane}`));
      }
    } catch (error) {
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

// Monitoring + History
program
  .command("monitor")
  .description("Terminal-mode live view (no browser)")
  .option("--interval <seconds>", "Poll interval in seconds", "15")
  .option("--session <name>", "NTM session to monitor")
  .action(async (opts: { interval: string; session?: string }) => {
    await runMonitor({
      interval: parsePositiveInt(opts.interval, "--interval"),
      session: opts.session,
    });
  });

program
  .command("serve")
  .description("Start local dashboard server")
  .option("--port <port>", "Port to bind (use 0 for an OS-assigned free port)", "4200")
  .action(async (opts: { port: string }) => {
    const server = createFlywheelServer({
      port: parseServePort(opts.port),
    });
    await server.start();
    const boundPort = server.getSnapshot().server.port;
    console.log(chalk.green(`✓ Flywheel server running at http://127.0.0.1:${boundPort}`));
    console.log(chalk.dim(`  WebSocket: ws://127.0.0.1:${boundPort}/ws`));
    console.log(chalk.dim(`  Snapshot:  http://127.0.0.1:${boundPort}/snapshot`));
    console.log(chalk.dim("  Press Ctrl+C to stop."));
    process.on("SIGINT", async () => {
      await server.stop();
      process.exit(0);
    });
  });

program
  .command("runs")
  .description("List all past runs with phase, duration, cost")
  .action(() => {
    listRuns();
  });

program
  .command("replay <run-id>")
  .description("Render phase_events as human-readable narrative")
  .option("--format <format>", "Output format (text|json)", "text")
  .option("--since <duration>", "Show only recent events (e.g. 1h, 30m)")
  .action((runId: string, opts: { format?: string; since?: string }) => {
    replayRun(runId, { format: parseReplayFormat(opts.format ?? "text"), since: opts.since });
  });

program.parse();
