import type { Command } from "commander";

export function registerReviewCommand(program: Command): void {
  program
    .command("review")
    .description("Run review passes")
    .option("--passes <passes>", "Specific passes only (comma-separated)")
    .action(async (opts) => {
      console.log("TODO: review", opts);
    });
}
