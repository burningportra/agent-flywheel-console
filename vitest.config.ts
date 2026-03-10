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

      // Coverage sources: CLI modules instrumented by the Node-based Vitest run.
      // Browser-loaded dashboard assets are exercised by E2E, but they are not
      // yet collected by this v8 coverage pipeline, so including them here would
      // make the gate permanently red for code the job cannot measure.
      include: ["cli/**/*.ts"],
      // Exclude: CLI entry (just wiring, not logic), generated assets, and test files
      exclude: [
        "cli/index.ts",
        "dashboard/**",
        "**/*.test.ts",
        "**/*.e2e.ts",
        "test/**",
      ],

      // ── Ratcheted coverage thresholds ────────────────────────────────────
      // These gate CI. They are set from the current full-suite baseline and
      // should only move upward as more of the codebase becomes testable in CI.
      // A permanently red coverage gate is noise; a ratcheted gate catches real
      // regressions while the suite continues to expand.
      thresholds: {
        // Global minimums
        lines: 35,
        functions: 50,
        branches: 35,
        statements: 35,

        // Per-file minimums for safety-critical modules
        // (vitest supports per-file thresholds via glob patterns)
        perFile: false, // set to true to fail per-file instead of globally
      },
    },
  },
});
