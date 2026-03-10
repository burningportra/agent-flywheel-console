import { describe, it, expect } from "vitest";

import {
  assertFailure,
  assertSuccess,
  cleanupTestProject,
  getTestProject,
  hasSshConfig,
  runFlywheel,
  runFlywheelWithDiagnostics,
} from "../setup.js";
import { SSHManager, loadSSHConfig, type SSHConfig } from "../../../cli/ssh.js";

const runVpsE2e = process.env.FLYWHEEL_TEST_E2E === "1" && hasSshConfig();
const describeVps = runVpsE2e ? describe : describe.skip;

describe("flywheel init validation", () => {
  it("rejects invalid project names before connecting to the VPS", () => {
    const result = runFlywheel(["init", "bad name with spaces"]);
    assertFailure(result, "flywheel init invalid project name");
    expect(result.stderr).toMatch(/invalid project name/i);
  });
});

describeVps("flywheel init lifecycle", () => {
  it("scaffolds a remote project with git metadata and AGENTS instructions", async () => {
    const projectName = `${getTestProject()}-init`;

    try {
      const initResult = await runFlywheelWithDiagnostics(["init", projectName], {
        remoteDiagnostics: true,
        remoteProjectName: projectName,
      });
      assertSuccess(initResult, "flywheel init");

      await withRemoteProject(projectName, async (manager, projectPath) => {
        expect(initResult.stdout).toContain(projectName);
        expect(initResult.stdout).toContain(projectPath);
        expect(initResult.stdout).toContain("✓");

        await expectRemotePath(manager, projectPath, "directory");
        await expectRemotePath(manager, `${projectPath}/.git`, "directory");

        const brAvailable = await remoteCommand(
          manager,
          "check br availability",
          "command -v br >/dev/null 2>&1 && echo yes || echo no"
        );

        if (brAvailable.stdout.trim() === "yes") {
          await expectRemotePath(manager, `${projectPath}/.beads`, "directory");
        } else {
          expect(initResult.stdout).toMatch(/br not found/i);
        }

        const agentsMd = await remoteCommand(
          manager,
          "read AGENTS.md",
          `cat ${shellQuote(`${projectPath}/AGENTS.md`)}`
        );
        expect(agentsMd.stdout).toContain(projectName);
      });
    } finally {
      await cleanupTestProject(projectName);
    }
  });

  it("remains idempotent when run twice against the same project", async () => {
    const projectName = `${getTestProject()}-rerun`;

    try {
      const firstRun = await runFlywheelWithDiagnostics(["init", projectName], {
        remoteDiagnostics: true,
        remoteProjectName: projectName,
      });
      assertSuccess(firstRun, "flywheel init first run");

      const secondRun = await runFlywheelWithDiagnostics(["init", projectName], {
        remoteDiagnostics: true,
        remoteProjectName: projectName,
      });
      assertSuccess(secondRun, "flywheel init second run");
      expect(secondRun.stdout).toMatch(/already exists|already initialized/i);

      await withRemoteProject(projectName, async (manager, projectPath) => {
        await expectRemotePath(manager, `${projectPath}/.git`, "directory");

        const metadataCount = await remoteCommand(
          manager,
          "count init metadata entries",
          `find ${shellQuote(projectPath)} -maxdepth 1 \\( -name '.git' -o -name '.beads' -o -name 'AGENTS.md' \\) | wc -l`
        );
        expect(Number.parseInt(metadataCount.stdout.trim(), 10)).toBeGreaterThanOrEqual(2);
      });
    } finally {
      await cleanupTestProject(projectName);
    }
  });
});

async function withRemoteProject(
  projectName: string,
  fn: (manager: SSHManager, projectPath: string, config: SSHConfig) => Promise<void>
): Promise<void> {
  const manager = new SSHManager();
  const config = await manager.connect();
  const projectPath = `${config.remoteRepoRoot}/${projectName}`;

  try {
    await fn(manager, projectPath, config);
  } finally {
    manager.disconnect();
  }
}

async function expectRemotePath(
  manager: SSHManager,
  remotePath: string,
  kind: "directory" | "file"
): Promise<void> {
  const testFlag = kind === "directory" ? "-d" : "-f";
  const result = await remoteCommand(
    manager,
    `verify ${kind} exists`,
    `test ${testFlag} ${shellQuote(remotePath)} && echo yes || echo no`
  );
  expect(result.stdout.trim()).toBe("yes");
}

async function remoteCommand(
  manager: SSHManager,
  label: string,
  command: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  console.log(`\n[E2E] remote check: ${label}`);
  console.log(`[E2E] remote cmd:   ${command}`);

  const result = await manager.exec(command, { timeoutMs: 30_000, noTrim: true });

  console.log(`[E2E] remote exit:  ${result.code} in ${result.elapsed}ms`);
  if (result.stdout.trim()) {
    console.log(`[E2E] remote stdout:\n${result.stdout.trimEnd()}`);
  }
  if (result.stderr.trim()) {
    console.log(`[E2E] remote stderr:\n${result.stderr.trimEnd()}`);
  }

  return result;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
