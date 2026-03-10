import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tempDir } from "../helpers.js";

const SCRIPT = resolve("scripts/analyze-flakes.js");

type TempDir = ReturnType<typeof tempDir>;

interface VitestAssertionResult {
  fullName: string;
  status: "passed" | "failed" | "skipped";
  title?: string;
}

interface VitestFileResult {
  name: string;
  assertionResults: VitestAssertionResult[];
}

function writeVitestResult(
  dir: string,
  relativePath: string,
  testResults: VitestFileResult[]
): void {
  const filePath = join(dir, relativePath);
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(
    filePath,
    JSON.stringify(
      {
        numTotalTests: testResults.reduce(
          (count, file) => count + file.assertionResults.length,
          0
        ),
        testResults,
      },
      null,
      2
    ),
    "utf8"
  );
}

function runAnalyzeFlakes(cwd: string, resultsDir: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("node", [SCRIPT, resultsDir], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("scripts/analyze-flakes.js", () => {
  let dir: TempDir;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    dir.cleanup();
  });

  it("keeps identical assertion names from different files separate", () => {
    writeVitestResult(dir.path, "flake-results/run-1/a.json", [
      {
        name: "/repo/test/unit/alpha.test.ts",
        assertionResults: [{ fullName: "shared title", status: "passed" }],
      },
    ]);
    writeVitestResult(dir.path, "flake-results/run-1/b.json", [
      {
        name: "/repo/test/unit/beta.test.ts",
        assertionResults: [{ fullName: "shared title", status: "failed" }],
      },
    ]);

    const result = runAnalyzeFlakes(dir.path, "flake-results");
    expect(result.status).toBe(0);

    const report = JSON.parse(
      readFileSync(join(dir.path, "flake-report.json"), "utf8")
    ) as {
      flakyCount: number;
      alwaysPassingCount: number;
      alwaysFailingCount: number;
      flakyTests: Array<{ test: string }>;
      alwaysFailing: Array<{ test: string }>;
    };

    expect(report.flakyCount).toBe(0);
    expect(report.alwaysPassingCount).toBe(1);
    expect(report.alwaysFailingCount).toBe(1);
    expect(report.flakyTests).toEqual([]);
    expect(report.alwaysFailing[0]?.test).toContain(
      "/repo/test/unit/beta.test.ts"
    );
  });

  it("marks the same test as flaky when it passes and fails across runs", () => {
    writeVitestResult(dir.path, "flake-results/run-1/report.json", [
      {
        name: "/repo/test/integration/cli-version.test.ts",
        assertionResults: [
          {
            fullName:
              "CLI integration: version contract prints semantic version and exits 0",
            status: "passed",
          },
        ],
      },
    ]);
    writeVitestResult(dir.path, "flake-results/run-2/report.json", [
      {
        name: "/repo/test/integration/cli-version.test.ts",
        assertionResults: [
          {
            fullName:
              "CLI integration: version contract prints semantic version and exits 0",
            status: "failed",
          },
        ],
      },
    ]);

    const result = runAnalyzeFlakes(dir.path, "flake-results");
    expect(result.status).toBe(0);

    const report = JSON.parse(
      readFileSync(join(dir.path, "flake-report.json"), "utf8")
    ) as {
      flakyCount: number;
      flakyTests: Array<{
        test: string;
        passCount: number;
        failCount: number;
        totalRuns: number;
      }>;
    };

    expect(report.flakyCount).toBe(1);
    expect(report.flakyTests).toHaveLength(1);
    expect(report.flakyTests[0]?.test).toContain(
      "/repo/test/integration/cli-version.test.ts"
    );
    expect(report.flakyTests[0]?.passCount).toBe(1);
    expect(report.flakyTests[0]?.failCount).toBe(1);
    expect(report.flakyTests[0]?.totalRuns).toBe(2);
  });
});
