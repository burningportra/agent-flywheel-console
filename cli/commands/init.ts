import type { Command } from "commander";

export function registerInitCommand(program: Command): void {
  program
    .command("init <project-name>")
    .description("Create project dir + config on VPS")
    .action(async (name) => {
      console.log(`TODO: init project ${name}`);
    });
}
