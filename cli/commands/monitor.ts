import type { Command } from "commander";

export function registerMonitorCommand(program: Command): void {
  program
    .command("monitor")
    .description("Terminal-mode live view (no browser)")
    .action(async () => {
      console.log("TODO: monitor");
    });
}
