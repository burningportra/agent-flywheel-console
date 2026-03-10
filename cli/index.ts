#!/usr/bin/env node

import { Command } from "commander";

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
    console.log("TODO: interactive SSH config prompt");
  });

program
  .command("ssh")
  .description("SSH connection management")
  .command("test")
  .description("Test SSH connection + measure latency")
  .action(async () => {
    console.log("TODO: SSH test");
  });

program
  .command("preflight")
  .description("Verify remote tools on VPS")
  .option("--force", "Warn but continue on missing tools")
  .action(async (opts) => {
    console.log("TODO: preflight check", opts);
  });

program
  .command("doctor")
  .description("Full diagnostic: SSH, tools, config, API keys, CAAM, SQLite")
  .action(async () => {
    console.log("TODO: doctor diagnostics");
  });

program
  .command("providers")
  .description("Show model slot usage + rotation state")
  .action(async () => {
    console.log("TODO: provider status");
  });

// Project init
program
  .command("init <project-name>")
  .description("Create project dir + config on VPS")
  .action(async (name) => {
    console.log(`TODO: init project ${name}`);
  });

// Phase 1: Plan
program
  .command("new <idea>")
  .description("Run Phase 1 Planning Wizard")
  .option("--models <models>", "Override competing models (comma-separated)")
  .option("--fast", "Skip fan-out; 1 synthesis pass + 1 ideas round")
  .option("--push-artifacts", "Copy plan.md + wizard-log.jsonl to VPS")
  .action(async (idea, opts) => {
    console.log(`TODO: planning wizard for "${idea}"`, opts);
  });

// Phase 2: Beads
const beads = program
  .command("beads")
  .description("Bead management (generate, refine, triage)");

beads
  .command("generate")
  .description("2A: Generate beads from plan")
  .action(async () => {
    console.log("TODO: beads generate");
  });

beads
  .command("refine")
  .description("2B: Review and refine beads")
  .action(async () => {
    console.log("TODO: beads refine");
  });

beads
  .command("triage")
  .description("2C: Run bv --robot-triage + br blocked + br ready")
  .action(async () => {
    console.log("TODO: beads triage");
  });

beads
  .command("history")
  .description("Show bead board state at a past timestamp")
  .option("--at <time>", "Timestamp to query")
  .action(async (opts) => {
    console.log("TODO: beads history", opts);
  });

// Phase 3: Swarm
program
  .command("swarm <count>")
  .description("Spawn N agents on VPS (includes commit agent)")
  .option("--no-commit", "Skip commit agent")
  .option("--budget <amount>", "Hard-stop if projected spend exceeds amount")
  .action(async (count, opts) => {
    console.log(`TODO: swarm ${count} agents`, opts);
  });

program
  .command("rollback [run-id]")
  .description("Reset VPS repo to pre-swarm checkpoint SHA")
  .action(async (runId) => {
    console.log(`TODO: rollback ${runId || "latest"}`);
  });

// Phase 4: Review
program
  .command("review")
  .description("Run review passes")
  .option("--passes <passes>", "Specific passes only (comma-separated)")
  .action(async (opts) => {
    console.log("TODO: review", opts);
  });

// Phase 5: Deploy
program
  .command("deploy")
  .description("Final commit + gh flow + checksums + CM reflect")
  .action(async () => {
    console.log("TODO: deploy (requires DEPLOY <project-name> confirmation)");
  });

// Autopilot
program
  .command("autopilot")
  .description("Run maintenance loop")
  .option("--tmux", "Detach into persistent tmux session")
  .option("--projects <scope>", "Run on all configured projects", "current")
  .action(async (opts) => {
    console.log("TODO: autopilot", opts);
  });

// Gates
const gate = program.command("gate").description("Gate management");

gate
  .command("advance")
  .description("Pass current human gate, proceed to next phase")
  .action(async () => {
    console.log("TODO: gate advance");
  });

gate
  .command("status")
  .description("Show current gate state")
  .action(async () => {
    console.log("TODO: gate status");
  });

// Prompt library
const prompts = program.command("prompts").description("Prompt library");

prompts
  .command("list")
  .description("List all prompts with metadata")
  .action(async () => {
    console.log("TODO: prompts list");
  });

prompts
  .command("send <name>")
  .description("Send a prompt to agent(s)")
  .option("--agent <id>", "Target agent pane")
  .option("--all", "Broadcast to all agents")
  .action(async (name, opts) => {
    console.log(`TODO: send prompt "${name}"`, opts);
  });

// Monitoring + History
program
  .command("monitor")
  .description("Terminal-mode live view (no browser)")
  .action(async () => {
    console.log("TODO: monitor");
  });

program
  .command("serve")
  .description("Start Vite dashboard at localhost:4200")
  .action(async () => {
    console.log("TODO: serve dashboard");
  });

program
  .command("runs")
  .description("List all past runs with phase, duration, cost")
  .action(async () => {
    console.log("TODO: runs list");
  });

program
  .command("replay <run-id>")
  .description("Render phase_events as human-readable narrative")
  .option("--format <format>", "Output format", "text")
  .option("--since <duration>", "Show only recent events")
  .action(async (runId, opts) => {
    console.log(`TODO: replay ${runId}`, opts);
  });

program.parse();
