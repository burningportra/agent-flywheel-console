import type { Command } from "commander";

export function registerSshCommands(program: Command): void {
  const ssh = program.command("ssh").description("SSH connection management");

  ssh
    .command("test")
    .description("Test SSH connection + measure latency")
    .action(async () => {
      console.log("TODO: SSH test");
    });
}
