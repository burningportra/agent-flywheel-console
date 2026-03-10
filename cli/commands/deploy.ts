import type { Command } from "commander";

export function registerDeployCommand(program: Command): void {
  program
    .command("deploy")
    .description("Final commit + gh flow + checksums + CM reflect")
    .action(async () => {
      console.log("TODO: deploy (requires DEPLOY <project-name> confirmation)");
    });
}
