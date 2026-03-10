import type { Command } from "commander";

export function registerServeCommand(program: Command): void {
  program
    .command("serve")
    .description("Start Vite dashboard at localhost:4200")
    .action(async () => {
      console.log("TODO: serve dashboard");
    });
}
