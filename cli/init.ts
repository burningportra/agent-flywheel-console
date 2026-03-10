// flywheel init <project-name> — create and scaffold a project directory on the VPS
// Creates <remote_repo_root>/<project-name>, runs git init + br init, writes AGENTS.md stub.

import chalk from "chalk";

import { RemoteCommandRunner } from "./remote.js";
import { SSHManager } from "./ssh.js";
import { shellQuote } from "./utils.js";

// ─── Implementation ───────────────────────────────────────────────────────────

export interface InitOptions {
  /** Skip confirmation prompts (non-interactive mode) */
  yes?: boolean;
}

/**
 * `flywheel init <project-name>` — scaffold a project directory on the VPS.
 *
 * Steps:
 *  1. SSH to VPS
 *  2. Create <remote_repo_root>/<project-name>/
 *  3. git init
 *  4. br init (beads tracking)
 *  5. Write a starter AGENTS.md
 *  6. Print summary
 *
 * Exits 0 on success, 1 on failure.
 */
export async function runInit(projectName: string, _opts: InitOptions = {}): Promise<void> {
  if (!projectName || !/^[a-zA-Z0-9_-]+$/.test(projectName)) {
    console.error(
      chalk.red("✗") +
        ` Invalid project name: "${projectName}". Use letters, digits, hyphens, and underscores.`
    );
    process.exit(1);
  }

  const manager = new SSHManager();

  try {
    const config = await manager.connect();
    const remote = new RemoteCommandRunner(manager);
    const projectPath = `${config.remoteRepoRoot}/${projectName}`;

    console.log(chalk.bold(`\nInitialising project: ${projectName}\n`));
    console.log(chalk.gray(`  VPS:  ${config.user}@${config.host}:${config.port}`));
    console.log(chalk.gray(`  Path: ${projectPath}`));
    console.log();

    // ── Step 1: Create project directory (mkdir -p is idempotent — no pre-check needed) ─
    await runStep(remote, "Creating project directory", `mkdir -p ${shellQuote(projectPath)}`);

    // ── Step 2: git init (idempotent: re-running in an existing repo is a no-op) ─────────
    await runStep(
      remote,
      "Running git init",
      `cd ${shellQuote(projectPath)} && git init -b main 2>&1 | grep -v "^Reinitialized" || true`
    );

    // ── Step 3: br init ────────────────────────────────────────────────────────
    const brCheck = await manager.exec(
      `test -d ${shellQuote(projectPath + "/.beads")} && echo yes || echo no`,
      { timeoutMs: 10_000 }
    );
    if (brCheck.stdout.trim() === "yes") {
      console.log(chalk.gray("  ⟳  beads already initialized, skipping"));
    } else {
      // Check br is available
      const brAvail = await manager.exec("which br 2>/dev/null || echo missing", {
        timeoutMs: 5_000,
      });
      if (brAvail.stdout.trim().includes("missing")) {
        console.log(chalk.yellow("⚠") + " br not found on VPS — skipping beads init");
        console.log(chalk.gray("  Install br then run: cd " + projectPath + " && br init"));
      } else {
        await runStep(
          remote,
          "Initialising beads (br init)",
          `cd ${shellQuote(projectPath)} && br init`
        );
      }
    }

    // ── Step 4: Write starter AGENTS.md ───────────────────────────────────────
    const agentsMdPath = `${projectPath}/AGENTS.md`;
    const agentsMdCheck = await manager.exec(
      `test -f ${shellQuote(agentsMdPath)} && echo exists || echo missing`,
      { timeoutMs: 5_000 }
    );
    if (agentsMdCheck.stdout.trim() === "exists") {
      console.log(chalk.gray("  ⟳  AGENTS.md already exists, skipping"));
    } else {
      const agentsMdContent = makeAgentsMd(projectName, projectPath);
      // Write via heredoc — single-quoted to avoid shell expansion
      const escaped = agentsMdContent.replace(/'/g, "'\\''");
      await runStep(
        remote,
        "Writing AGENTS.md",
        `printf '%s' '${escaped}' > ${shellQuote(agentsMdPath)}`
      );
    }

    // ── Summary ────────────────────────────────────────────────────────────────
    console.log();
    console.log(chalk.green("✓") + ` Project "${projectName}" initialised at ${projectPath}`);
    console.log();
    console.log(chalk.bold("Next steps:"));
    console.log(chalk.gray("  flywheel new \"<your idea>\" --push-artifacts"));
    console.log(chalk.gray("  flywheel beads generate"));
    console.log(chalk.gray("  flywheel beads triage"));
    console.log(chalk.gray(`  flywheel swarm 6`));
    console.log();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(chalk.red("\n✗") + ` Init failed: ${message}`);
    process.exitCode = 1;
  } finally {
    manager.disconnect();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function runStep(
  remote: RemoteCommandRunner,
  label: string,
  command: string
): Promise<void> {
  process.stdout.write(chalk.gray(`  … ${label}…`));
  try {
    await remote.runRemote(command, { timeoutMs: 30_000 });
    process.stdout.write("\r" + chalk.green("  ✓") + ` ${label}\n`);
  } catch (err) {
    process.stdout.write("\r" + chalk.red("  ✗") + ` ${label}\n`);
    throw err;
  }
}

export function makeAgentsMd(projectName: string, projectPath: string): string {
  return `# ${projectName} — Agent Coordination Guide

## What This Is

A project managed by the Agent Flywheel Console.

## Agent Rules

1. **ONLY edit files relevant to your assigned bead** — no drive-by refactors
2. **NO new dependencies** without explicit approval
3. **Always update bead status** when starting (\`in_progress\`) and finishing (\`closed\`)
4. **Run builds after changes**: \`npm run build\` and \`npm run typecheck\` (or equivalent)
5. **Coordinate via MCP Agent Mail** — check inbox, respond to messages
6. **Use file reservations** for exclusive access to files being edited

## Bead Tools

\`\`\`bash
bv --export-md /tmp/beads.md    # Export beads to markdown
br list --all                   # List all beads
br show <id>                    # Show bead details
br comments add <id> <message>  # Add a comment
br close <id>                   # Close a bead
\`\`\`

## MCP Agent Mail

Register with: project key \`${projectPath}\`

Use \`macro_start_session\` to register and get your inbox.
`;
}

