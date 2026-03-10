import type { Command } from "commander";

export function registerReplayCommand(program: Command): void {
  program
    .command("replay <run-id>")
    .description("Render phase_events as human-readable narrative")
    .option("--format <format>", "Output format", "text")
    .option("--since <duration>", "Show only recent events")
    .action(async (runId, opts) => {
      console.log(`TODO: replay ${runId}`, opts);
    });
}
