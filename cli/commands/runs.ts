import type { Command } from "commander";

export function registerRunsCommand(program: Command): void {
  program
    .command("runs")
    .description("List all past runs with phase, duration, cost")
    .action(async () => {
      console.log("TODO: runs list");
    });
}
