import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run in Node.js — no browser, no jsdom
    environment: "node",

    // Test file patterns:
    //   - Unit + integration: always run
    //   - Local E2E (no VPS): always run (local-commands.e2e.ts)
    //   - VPS E2E: opt-in via FLYWHEEL_TEST_E2E=1
    //   - Live provider tests: opt-in via FLYWHEEL_TEST_LIVE=1
    include: [
      "test/contract/**/*.test.ts",
      "test/unit/**/*.test.ts",
      "test/integration/**/*.test.ts",
      // Local E2E (no VPS needed) — always included
      "test/e2e/local-commands.e2e.ts",
      // Lifecycle + SSH connectivity E2E — always included.
      // VPS-dependent tests use describeVps = runVpsE2e ? describe : describe.skip
      // so they self-skip without FLYWHEEL_TEST_E2E=1. Non-VPS validation tests
      // (argument validation, confirmation rejection, etc.) always run.
      "test/e2e/lifecycle/**/*.e2e.ts",
      "test/e2e/remote/**/*.e2e.ts",
      "test/e2e/ssh-connectivity.e2e.ts",
      "test/e2e/error-matrix/**/*.e2e.ts",
      "test/e2e/concurrent/**/*.e2e.ts",
      "test/e2e/dashboard/**/*.e2e.ts",
      ...(process.env.FLYWHEEL_TEST_LIVE ? ["test/live/**/*.test.ts"] : []),
    ],

    exclude: [
      "node_modules",
      "dist",
      "test/e2e/setup.ts",    // helper, not a test file
    ],

    // Each test file gets a fresh module registry — prevents shared state
    isolate: true,

    // Timeout: 10s for unit tests, longer for integration
    testTimeout: 10_000,

    // Retry policy: integration and e2e tests may flake due to process startup
    // timing, port allocation, or temp-dir contention. Allow up to 1 retry
    // before marking a test as failed. Unit tests never retry (if they flake,
    // the test logic is wrong). Retry is controlled per-run via CLI --retry flag
    // so unit runs stay strict. This default is intentionally low — see
    // docs/flake-policy.md for the full quarantine workflow.
    retry: 0, // default off; CI overrides per stage via --retry flag

    // Print test names as they run for debugging
    reporter: ["verbose"],

    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "./coverage",

      // Coverage sources: CLI modules only. The browser dashboard is covered
      // by dedicated E2E tests, but this Node/V8 job does not instrument its
      // runtime code path.
      include: ["cli/**/*.ts"],
      // Exclude: CLI entry (just wiring, not logic), test files themselves
      exclude: [
        "cli/index.ts",
        "dashboard/dist/**",
        "**/*.test.ts",
        "**/*.e2e.ts",
        "test/**",
      ],

      // ── Global coverage thresholds ───────────────────────────────────────
      // These gate CI for the current no-mock Node suite. They should track
      // the measured baseline closely enough to catch regressions without
      // pretending the suite already covers unimplemented or VPS-only paths.
      // Ratchet them upward as more command surfaces gain deterministic tests.
      thresholds: {
        lines: 45,
        functions: 60,
        branches: 40,
        statements: 45,

        // Per-file minimums for safety-critical modules
        // (vitest supports per-file thresholds via glob patterns)
        perFile: false, // set to true to fail per-file instead of globally
      },
    },
  },
});
