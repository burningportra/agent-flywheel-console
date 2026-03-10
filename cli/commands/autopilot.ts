import type { Command } from "commander";

export function registerAutopilotCommand(program: Command): void {
  program
    .command("autopilot")
    .description("Run maintenance loop")
    .option("--tmux", "Detach into persistent tmux session")
    .option("--projects <scope>", "Run on all configured projects", "current")
    .action(async (opts) => {
      console.log("TODO: autopilot", opts);
    });
}
