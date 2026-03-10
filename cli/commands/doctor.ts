import type { Command } from "commander";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Full diagnostic: SSH, tools, config, API keys, CAAM, SQLite")
    .action(async () => {
      console.log("TODO: doctor diagnostics");
    });
}
