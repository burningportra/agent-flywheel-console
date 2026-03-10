#!/usr/bin/env node

import { Command } from "commander";

import { registerAutopilotCommand } from "./commands/autopilot.js";
import { registerBeadsCommands } from "./commands/beads.js";
import { registerDeployCommand } from "./commands/deploy.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerGateCommands } from "./commands/gate.js";
import { registerInitCommand } from "./commands/init.js";
import { registerMonitorCommand } from "./commands/monitor.js";
import { registerNewCommand } from "./commands/new.js";
import { registerPreflightCommand } from "./commands/preflight.js";
import { registerPromptsCommands } from "./commands/prompts.js";
import { registerProvidersCommand } from "./commands/providers.js";
import { registerReplayCommand } from "./commands/replay.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerRunsCommand } from "./commands/runs.js";
import { registerServeCommand } from "./commands/serve.js";
import { registerSettingsCommands } from "./commands/settings.js";
import { registerSshCommands } from "./commands/ssh.js";
import { registerSwarmCommands } from "./commands/swarm.js";

const program = new Command();

program
  .name("flywheel")
  .description(
    "Local control plane for the agentic coding flywheel — orchestrate Plan → Beads → Swarm → Review → Deploy on a remote VPS over SSH."
  )
  .version("0.1.0");

registerSettingsCommands(program);
registerSshCommands(program);
registerPreflightCommand(program);
registerDoctorCommand(program);
registerProvidersCommand(program);
registerInitCommand(program);
registerNewCommand(program);
registerBeadsCommands(program);
registerSwarmCommands(program);
registerReviewCommand(program);
registerDeployCommand(program);
registerAutopilotCommand(program);
registerGateCommands(program);
registerPromptsCommands(program);
registerMonitorCommand(program);
registerServeCommand(program);
registerRunsCommand(program);
registerReplayCommand(program);

await program.parseAsync();
