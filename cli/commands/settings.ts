import type { Command } from "commander";

export function registerSettingsCommands(program: Command): void {
  const settings = program
    .command("settings")
    .description("Configure flywheel settings");

  settings
    .command("ssh")
    .description("Configure VPS SSH connection")
    .action(async () => {
      console.log("TODO: interactive SSH config prompt");
    });
}
