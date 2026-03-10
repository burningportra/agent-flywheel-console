import type { Command } from "commander";

export function registerProvidersCommand(program: Command): void {
  program
    .command("providers")
    .description("Show model slot usage + rotation state")
    .action(async () => {
      console.log("TODO: provider status");
    });
}
