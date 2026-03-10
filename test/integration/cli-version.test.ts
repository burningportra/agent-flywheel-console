import { describe, expect, it } from "vitest";

import { runProcess } from "../helpers/process.js";

describe("CLI integration: version contract", () => {
  it("prints semantic version and exits 0", async () => {
    const result = await runProcess("npx", ["tsx", "cli/index.ts", "--version"], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 20_000,
    });

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^0\.\d+\.\d+$/);
  });
});
