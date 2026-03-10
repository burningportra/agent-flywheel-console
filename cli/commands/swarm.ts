import type { Command } from "commander";

export function registerSwarmCommands(program: Command): void {
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
}
