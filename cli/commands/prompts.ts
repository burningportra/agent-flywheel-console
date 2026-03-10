import type { Command } from "commander";

export function registerPromptsCommands(program: Command): void {
  const prompts = program.command("prompts").description("Prompt library");

  prompts
    .command("list")
    .description("List all prompts with metadata")
    .action(async () => {
      console.log("TODO: prompts list");
    });

  prompts
    .command("send <name>")
    .description("Send a prompt to agent(s)")
    .option("--agent <id>", "Target agent pane")
    .option("--all", "Broadcast to all agents")
    .action(async (name, opts) => {
      console.log(`TODO: send prompt "${name}"`, opts);
    });
}
