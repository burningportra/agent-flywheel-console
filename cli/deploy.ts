import { initDb, StateManager } from "./state.js";
import { RemoteCommandRunner } from "./remote.js";
import { SSHManager } from "./ssh.js";
import { shellQuote, trimTrailingSlash } from "./utils.js";

export interface DeployOptions {
  remoteProjectPath?: string;
  commitMessage?: string;
  runId?: string;
}

export interface DeployResult {
  runId: string;
  remoteProjectPath: string;
  beforeSha: string;
  afterSha: string;
  trackedChangesPresent: boolean;
}

export class DeployCoordinator {
  private readonly ssh: SSHManager;
  private readonly remote: RemoteCommandRunner;
  private readonly state: StateManager;

  constructor(deps?: { ssh?: SSHManager; remote?: RemoteCommandRunner; state?: StateManager }) {
    this.ssh = deps?.ssh ?? new SSHManager();
    this.remote = deps?.remote ?? new RemoteCommandRunner(this.ssh);
    this.state = deps?.state ?? new StateManager(initDb());
  }

  async deploy(projectName: string, confirmation: string, options: DeployOptions = {}): Promise<DeployResult> {
    assertDeployConfirmation(projectName, confirmation);

    const sshConfig = await this.ssh.connect();
    try {
      const remoteProjectPath =
        options.remoteProjectPath ?? `${trimTrailingSlash(sshConfig.remoteRepoRoot)}/${projectName}`;
      const runId = options.runId ?? this.state.createFlywheelRun(projectName, "deploy");

      const [beforeSha, dirtyCheck] = await Promise.all([
        readHeadSha(this.remote, remoteProjectPath),
        this.remote.runRemote("git status --porcelain --untracked-files=no", {
          cwd: remoteProjectPath,
          timeoutMs: 15_000,
        }),
      ]);
      const trackedChangesPresent = dirtyCheck.stdout.trim().length > 0;

      this.state.logEvent(
        runId,
        "deploy_started",
        { remoteProjectPath, beforeSha, trackedChangesPresent },
        { actor: "flywheel", phaseTo: "deploy" }
      );

      if (trackedChangesPresent) {
        await this.remote.runRemote("git add -u", {
          cwd: remoteProjectPath,
          timeoutMs: 15_000,
        });

        const commitMessage =
          options.commitMessage ?? `flywheel deploy ${new Date().toISOString()}`;
        await this.remote.runRemote(`git commit -m ${shellQuote(commitMessage)}`, {
          cwd: remoteProjectPath,
          timeoutMs: 30_000,
        });
      }

      await this.remote.runRemote("git push", {
        cwd: remoteProjectPath,
        timeoutMs: 60_000,
      });

      const afterSha = await readHeadSha(this.remote, remoteProjectPath);

      this.state.logEvent(
        runId,
        "deploy_completed",
        { remoteProjectPath, beforeSha, afterSha, trackedChangesPresent },
        { actor: "flywheel", phaseTo: "deploy" }
      );

      return {
        runId,
        remoteProjectPath,
        beforeSha,
        afterSha,
        trackedChangesPresent,
      };
    } finally {
      this.ssh.disconnect();
    }
  }
}

export function requiredDeployConfirmation(projectName: string): string {
  return `DEPLOY ${projectName}`;
}

export function assertDeployConfirmation(projectName: string, confirmation: string): void {
  const expected = requiredDeployConfirmation(projectName);
  if (confirmation !== expected) {
    throw new Error(`Deploy confirmation mismatch. Expected exactly "${expected}".`);
  }
}

async function readHeadSha(remote: RemoteCommandRunner, cwd: string): Promise<string> {
  const head = await remote.runRemote("git rev-parse HEAD", {
    cwd,
    timeoutMs: 15_000,
  });
  return head.stdout.trim();
}

