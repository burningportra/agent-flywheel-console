// flywheel rollback [run-id]
// Reset VPS repo to pre-swarm checkpoint SHA stored in flywheel_runs.
// Destructive — requires explicit confirmation before proceeding.

import chalk from "chalk";
import { createInterface } from "readline";
import { initDb, StateManager, type FlywheelRun } from "./state.js";
import { SSHManager, SSHError } from "./ssh.js";
import { shellQuote, trimTrailingSlash } from "./utils.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function findRun(
  state: StateManager,
  runId?: string
): FlywheelRun | undefined {
  if (runId) {
    // Try exact match first, then prefix
    const exact = state.getFlywheelRun(runId);
    if (exact) return exact;
    const all = state.listFlywheelRuns();
    return all.find((r) => r.id.startsWith(runId));
  }
  // Latest run with a checkpoint SHA
  const all = state.listFlywheelRuns();
  return all.find((r) => r.checkpoint_sha !== null);
}

/** Validate that a string is a safe git SHA (hex only). Prevents shell injection. */
function assertSafeSha(sha: string): void {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) {
    throw new Error(
      `Invalid checkpoint SHA: "${sha}". Expected a hex string (7–64 characters).`
    );
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export interface RollbackOptions {
  /** Specific run ID to roll back to; defaults to most recent with checkpoint */
  runId?: string;
  /** Skip confirmation prompt (for scripting) */
  force?: boolean;
}

function requireRollbackRun(state: StateManager, runId?: string): FlywheelRun & { checkpoint_sha: string } {
  const run = findRun(state, runId);
  if (!run || !run.checkpoint_sha) {
    const message = !run
      ? runId
        ? `Run not found: ${runId}`
        : "No runs with checkpoint SHA found. Run flywheel swarm first."
      : `Run ${run.id} has no checkpoint SHA. Cannot roll back.`;
    console.error(chalk.red(message));
    process.exit(1);
  }

  return run as FlywheelRun & { checkpoint_sha: string };
}

export async function runRollback(opts: RollbackOptions = {}): Promise<void> {
  const db = initDb();
  const state = new StateManager(db);

  const run = requireRollbackRun(state, opts.runId);

  console.log(chalk.bgRed.white.bold("\n  ⚠  DESTRUCTIVE OPERATION — VPS Repository Rollback  "));
  console.log();
  console.log(`   Run:        ${chalk.dim(run.id.slice(0, 8))}…`);
  console.log(`   Project:    ${chalk.bold(run.project_name ?? "—")}`);
  console.log(`   Checkpoint: ${chalk.yellow(run.checkpoint_sha.slice(0, 12))}…`);
  console.log();
  console.log(chalk.red("   git reset --hard will run on the VPS repo."));
  console.log(chalk.red("   All commits made AFTER this checkpoint will be permanently lost."));
  console.log();

  if (!opts.force) {
    const answer = await prompt(
      chalk.red.bold('Type "ROLLBACK" to confirm, or Enter to cancel: ')
    );
    if (answer.trim() !== "ROLLBACK") {
      console.log(chalk.dim("\nRollback cancelled."));
      return;
    }
  }

  // Validate SHA before any shell usage
  assertSafeSha(run.checkpoint_sha);

  // Connect SSH and perform rollback
  const ssh = new SSHManager();
  let exitCode = 0;

  try {
    const config = await ssh.connect();
    const projectName = (run.project_name ?? "").trim();
    if (!projectName) {
      console.error(
        chalk.red(`\n✗ Run ${run.id} is missing project_name; cannot resolve remote repo path.`)
      );
      exitCode = 1;
    } else {
      const repoPath = `${trimTrailingSlash(config.remoteRepoRoot)}/${projectName}`;

      console.log(chalk.gray(`\nConnected to ${config.user}@${config.host}.`));
      console.log(
        chalk.gray(`Running: git -C ${repoPath} reset --hard ${run.checkpoint_sha}`)
      );

      const result = await ssh.exec(
        `git -C ${shellQuote(repoPath)} reset --hard ${run.checkpoint_sha}`,
        { timeoutMs: 30_000 }
      );

      if (result.code !== 0) {
        console.error(chalk.red(`\n✗ git reset failed (exit ${result.code}):`));
        console.error(result.stderr.trim() || result.stdout.trim());
        exitCode = 1;
      } else {
        console.log(chalk.green("\n✓ Rollback complete."));
        console.log(result.stdout.trim());

        // Log the rollback event
        state.logEvent(run.id, "rollback", {
          checkpoint_sha: run.checkpoint_sha,
        }, { actor: "human" });
      }
    }
  } catch (err) {
    if (err instanceof SSHError) {
      console.error(chalk.red(`\n✗ SSH error: ${err.message}`));
    } else {
      console.error(
        chalk.red(
          `\n✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`
        )
      );
    }
    exitCode = 1;
  } finally {
    ssh.disconnect();
  }

  if (exitCode !== 0) process.exit(exitCode);
}
