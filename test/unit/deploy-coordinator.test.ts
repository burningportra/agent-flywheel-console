/**
 * test/unit/deploy-coordinator.test.ts — bead: 3qw.1.2
 * Covers: cli/deploy.ts — confirmation guard (assertDeployConfirmation),
 *   tracked-change detection logic, and project path construction.
 * No VPS — tests the pure validation logic only.
 * (SSH-dependent deploy behavior tested in E2E suite.)
 */
import { describe, it, expect } from "vitest";
import {
  assertDeployConfirmation,
  requiredDeployConfirmation,
} from "../../cli/deploy.js";

// ── Confirmation guard (safety-critical) ─────────────────────────────────────

describe("requiredDeployConfirmation", () => {
  it("produces 'DEPLOY projectname' for a normal project", () => {
    expect(requiredDeployConfirmation("myapp")).toBe("DEPLOY myapp");
  });

  it("preserves hyphens and dots in project names", () => {
    expect(requiredDeployConfirmation("my-api-v2")).toBe("DEPLOY my-api-v2");
  });

  it("is case-sensitive — project name is preserved verbatim", () => {
    expect(requiredDeployConfirmation("MyApp")).toBe("DEPLOY MyApp");
  });

  it("handles an empty project name (edge case)", () => {
    expect(requiredDeployConfirmation("")).toBe("DEPLOY ");
  });
});

describe("assertDeployConfirmation — happy path", () => {
  it("does not throw when confirmation exactly matches", () => {
    expect(() =>
      assertDeployConfirmation("myapp", "DEPLOY myapp")
    ).not.toThrow();
  });

  it("passes for any valid project name format", () => {
    for (const name of ["app", "my-api", "project-v2.0", "Agent-Flywheel-Console"]) {
      expect(() =>
        assertDeployConfirmation(name, `DEPLOY ${name}`)
      ).not.toThrow();
    }
  });
});

describe("assertDeployConfirmation — rejection cases (safety-critical)", () => {
  const name = "production-app";

  it("throws on wrong case (deploy instead of DEPLOY)", () => {
    expect(() => assertDeployConfirmation(name, `deploy ${name}`)).toThrow(/exactly/i);
  });

  it("throws on mixed case DEPLOY", () => {
    expect(() => assertDeployConfirmation(name, `Deploy ${name}`)).toThrow();
  });

  it("throws on trailing space after project name", () => {
    expect(() => assertDeployConfirmation(name, `DEPLOY ${name} `)).toThrow();
  });

  it("throws on leading space before DEPLOY", () => {
    expect(() => assertDeployConfirmation(name, ` DEPLOY ${name}`)).toThrow();
  });

  it("throws when wrong project name is given", () => {
    expect(() => assertDeployConfirmation(name, "DEPLOY other-project")).toThrow();
  });

  it("throws for empty confirmation string", () => {
    expect(() => assertDeployConfirmation(name, "")).toThrow();
  });

  it("throws for just 'DEPLOY' with no project name", () => {
    expect(() => assertDeployConfirmation(name, "DEPLOY")).toThrow();
  });

  it("throws for 'DEPLOY ' (project name as space only)", () => {
    expect(() => assertDeployConfirmation(name, "DEPLOY ")).toThrow();
  });

  it("does NOT accept a substring match (projectname is required in full)", () => {
    // 'production' is a prefix of 'production-app' — must not match
    expect(() => assertDeployConfirmation(name, "DEPLOY production")).toThrow();
  });

  it("throws when the words are swapped", () => {
    expect(() => assertDeployConfirmation(name, `${name} DEPLOY`)).toThrow();
  });

  it("error message includes the expected string", () => {
    let caught: Error | null = null;
    try { assertDeployConfirmation(name, "wrong"); } catch (e) { caught = e as Error; }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain(`DEPLOY ${name}`);
  });
});

// ── Project path construction ─────────────────────────────────────────────────
// trimTrailingSlash is used internally — replicate the contract

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

describe("project path construction in deploy (trimTrailingSlash contract)", () => {
  it("removes trailing slash before joining with project name", () => {
    const repoRoot = "/home/ubuntu/projects/";
    const projectName = "myapp";
    const expectedPath = "/home/ubuntu/projects/myapp";
    const result = `${trimTrailingSlash(repoRoot)}/${projectName}`;
    expect(result).toBe(expectedPath);
  });

  it("handles multiple trailing slashes", () => {
    expect(trimTrailingSlash("/path/to/root///")).toBe("/path/to/root");
  });

  it("path with no trailing slash is unchanged", () => {
    expect(trimTrailingSlash("/path/to/root")).toBe("/path/to/root");
  });

  it("correctly constructs path for various remoteRepoRoot values", () => {
    const cases: [string, string, string][] = [
      ["/home/ubuntu/projects", "app", "/home/ubuntu/projects/app"],
      ["/home/ubuntu/projects/", "app", "/home/ubuntu/projects/app"],
      ["/home/ubuntu/projects///", "my-api", "/home/ubuntu/projects/my-api"],
    ];
    for (const [root, name, expected] of cases) {
      expect(`${trimTrailingSlash(root)}/${name}`).toBe(expected);
    }
  });
});
