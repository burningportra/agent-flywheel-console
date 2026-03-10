import type { Command } from "commander";

export function registerNewCommand(program: Command): void {
  program
    .command("new <idea>")
    .description("Run Phase 1 Planning Wizard")
    .option("--models <models>", "Override competing models (comma-separated)")
    .option("--fast", "Skip fan-out; 1 synthesis pass + 1 ideas round")
    .option("--push-artifacts", "Copy plan.md + wizard-log.jsonl to VPS")
    .action(async (idea, opts) => {
      console.log(`TODO: planning wizard for "${idea}"`, opts);
    });
}
