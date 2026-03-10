import type { Command } from "commander";

export function registerGateCommands(program: Command): void {
  const gate = program.command("gate").description("Gate management");

  gate
    .command("advance")
    .description("Pass current human gate, proceed to next phase")
    .action(async () => {
      console.log("TODO: gate advance");
    });

  gate
    .command("status")
    .description("Show current gate state")
    .action(async () => {
      console.log("TODO: gate status");
    });
}
