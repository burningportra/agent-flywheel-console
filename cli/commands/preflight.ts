import type { Command } from "commander";

export function registerPreflightCommand(program: Command): void {
  program
    .command("preflight")
    .description("Verify remote tools on VPS")
    .option("--force", "Warn but continue on missing tools")
    .action(async (opts) => {
      console.log("TODO: preflight check", opts);
    });
}
