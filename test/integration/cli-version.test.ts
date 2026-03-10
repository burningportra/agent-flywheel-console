import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const CLI = resolve("dist/cli.js");

describe("CLI integration: version contract", () => {
  it("prints semantic version and exits 0", () => {
    const result = spawnSync("node", [CLI, "--version"], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^0\.\d+\.\d+$/);
  });
});
