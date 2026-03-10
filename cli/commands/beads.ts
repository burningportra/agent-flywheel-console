import type { Command } from "commander";

export function registerBeadsCommands(program: Command): void {
  const beads = program
    .command("beads")
    .description("Bead management (generate, refine, triage)");

  beads
    .command("generate")
    .description("2A: Generate beads from plan")
    .action(async () => {
      console.log("TODO: beads generate");
    });

  beads
    .command("refine")
    .description("2B: Review and refine beads")
    .action(async () => {
      console.log("TODO: beads refine");
    });

  beads
    .command("triage")
    .description("2C: Run bv --robot-triage + br blocked + br ready")
    .action(async () => {
      console.log("TODO: beads triage");
    });

  beads
    .command("history")
    .description("Show bead board state at a past timestamp")
    .option("--at <time>", "Timestamp to query")
    .action(async (opts) => {
      console.log("TODO: beads history", opts);
    });
}
