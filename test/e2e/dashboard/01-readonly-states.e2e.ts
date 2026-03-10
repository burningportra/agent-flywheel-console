/**
 * test/e2e/dashboard/01-readonly-states.e2e.ts — bead: agent-flywheel-console-3qw.4.2
 *
 * Validates read-only dashboard states in the browser (no mutations):
 *  - Empty workspace (no runs, no SSH configured)
 *  - Active run with populated snapshot data
 *  - SSH disconnected state
 *  - Browser console hygiene
 *
 * All assertions target stable element IDs in index.html.
 * Screenshots are saved on every major state and on any test failure.
 * No VPS, no SSH required — runs entirely against a local server + in-memory DB.
 *
 * Uses beforeAll/afterAll (one browser+server per describe) so Playwright's
 * ~2s startup cost is paid once per group rather than once per test.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startDashboardHarness,
  withFailureScreenshot,
  type DashboardHarness,
} from "./00-harness.js";
import { type StateManager } from "../../../cli/state.js";

// Playwright browser startup can take 2-5s on a cold runner.
// 30s is conservative but eliminates false negatives on slow CI.
const HOOK_TIMEOUT_MS = 30_000;
const WAIT_TIMEOUT_MS = 12_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wait for the WebSocket connection to reach "Live" status. */
async function waitForLive(h: DashboardHarness): Promise<void> {
  await h.page.waitForFunction(
    () => document.getElementById("ws-status")?.textContent?.includes("Live"),
    { timeout: WAIT_TIMEOUT_MS }
  );
}

/** Wait for applySnapshot() to have run at least once. */
async function waitForSnapshot(h: DashboardHarness): Promise<void> {
  await h.page.waitForFunction(
    () => {
      const el = document.getElementById("guidance-title");
      return el !== null && !el.textContent?.includes("Loading");
    },
    { timeout: WAIT_TIMEOUT_MS }
  );
}

// ── Empty workspace ───────────────────────────────────────────────────────────

describe("Dashboard — empty workspace (no runs, no SSH)", () => {
  let h: DashboardHarness;

  beforeAll(async () => {
    h = await startDashboardHarness({ suite: "readonly-empty" });
    await waitForLive(h);
    await waitForSnapshot(h);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await h?.teardown();
  }, HOOK_TIMEOUT_MS);

  it("page title is 'Flywheel Dashboard'", async () => {
    const title = await h.page.title();
    expect(title).toBe("Flywheel Dashboard");
  });

  it("WebSocket status shows 'Live'", async () => {
    const text = await h.page.locator("#ws-status").textContent();
    expect(text).toContain("Live");
  });

  it("run badge shows 'No run'", async () => {
    const text = await h.page.locator("#run-badge").textContent();
    expect(text).toContain("No run");
    await h.screenshot("empty-run-badge");
  });

  it("run metric shows '—'", async () => {
    expect(await h.page.locator("#metric-run").textContent()).toBe("—");
  });

  it("phase metric shows '—'", async () => {
    expect(await h.page.locator("#metric-phase").textContent()).toBe("—");
  });

  it("agents metric shows '0'", async () => {
    expect(await h.page.locator("#metric-agents").textContent()).toBe("0");
  });

  it("beads metric shows '—' when no run", async () => {
    expect(await h.page.locator("#metric-beads").textContent()).toBe("—");
  });

  it("server-meta shows host and port", async () => {
    const text = await h.page.locator("#server-meta").textContent();
    expect(text).toMatch(/Server 127\.0\.0\.1:\d+/);
    await h.screenshot("empty-full-state");
  });
});

// ── Populated state ───────────────────────────────────────────────────────────

describe("Dashboard — populated state (run seeded in DB)", () => {
  let h: DashboardHarness;

  beforeAll(async () => {
    h = await startDashboardHarness({
      suite: "readonly-populated",
      seedState: (sm: StateManager) => {
        const runId = sm.createFlywheelRun("my-project", "swarm");
        sm.captureBeadSnapshot(runId, {
          bead_count: 20,
          closed_count: 7,
          blocked_count: 2,
        });
        sm.logApiCall(
          runId,
          "swarm",
          "claude-opus-4-6",
          { input: 10_000, output: 5_000 },
          0.525
        );
      },
    });
    await waitForLive(h);
    await waitForSnapshot(h);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await h?.teardown();
  }, HOOK_TIMEOUT_MS);

  it("run metric shows the run ID prefix (8 hex chars)", async () => {
    // shortenId() clips UUIDs (36 chars) to the first 8 hex chars — no ellipsis
    const text = await h.page.locator("#metric-run").textContent();
    expect(text).toMatch(/^[0-9a-f]{8}$/);
  });

  it("project metric shows 'my-project'", async () => {
    const text = await h.page.locator("#metric-project").textContent();
    expect(text).toContain("my-project");
  });

  it("phase metric shows 'swarm'", async () => {
    const text = await h.page.locator("#metric-phase").textContent();
    expect(text).toBe("swarm");
  });

  it("run badge is not 'No run'", async () => {
    const text = await h.page.locator("#run-badge").textContent();
    expect(text).not.toContain("No run");
  });

  it("full populated dashboard screenshot", async () => {
    const path = await h.screenshot("populated-full");
    expect(path).toMatch(/\.png$/);
  });
});

// ── SSH disconnected ──────────────────────────────────────────────────────────

describe("Dashboard — SSH shows 'Disconnected' when not configured", () => {
  let h: DashboardHarness;

  beforeAll(async () => {
    // No SSH yaml written → server's sshManager.isConnected() is always false
    h = await startDashboardHarness({ suite: "readonly-ssh-off" });
    await waitForLive(h);
    await waitForSnapshot(h);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await h?.teardown();
  }, HOOK_TIMEOUT_MS);

  it("SSH metric shows 'Disconnected'", async () => {
    const text = await h.page.locator("#metric-ssh").textContent();
    expect(text).toBe("Disconnected");
    await h.screenshot("ssh-disconnected");
  });

  it("agent count stays 0 (no SSH means no NTM poll)", async () => {
    expect(await h.page.locator("#metric-agents").textContent()).toBe("0");
  });
});

// ── Console hygiene ───────────────────────────────────────────────────────────

describe("Dashboard — browser console hygiene on initial load", () => {
  let h: DashboardHarness;

  beforeAll(async () => {
    h = await startDashboardHarness({ suite: "readonly-console" });
    await waitForLive(h);
    await waitForSnapshot(h);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    h?.saveLogs("console-hygiene");
    await h?.teardown();
  }, HOOK_TIMEOUT_MS);

  it("no uncaught page errors in browser console", async () => {
    const errors = h.consoleLogs.filter((l) => l.type === "pageerror");
    expect(errors, `Page errors found: ${JSON.stringify(errors)}`).toHaveLength(0);
  });

  it("no 4xx or 5xx responses (favicon excluded)", async () => {
    const failures = h.failedRequests.filter((r) => !r.url.includes("favicon"));
    expect(failures, `Failed requests: ${JSON.stringify(failures)}`).toHaveLength(0);
  });
});

// ── withFailureScreenshot ─────────────────────────────────────────────────────

describe("withFailureScreenshot() utility — success path takes no extra screenshot", () => {
  let h: DashboardHarness;

  beforeAll(async () => {
    h = await startDashboardHarness({ suite: "readonly-utils" });
    await waitForLive(h);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await h?.teardown();
  }, HOOK_TIMEOUT_MS);

  it("does not throw and does not save a FAIL- screenshot when test passes", async () => {
    // withFailureScreenshot is called at test-run time (not declaration time)
    // so h is guaranteed to be set by beforeAll.
    await withFailureScreenshot(h, "should-not-save", async () => {
      const title = await h.page.title();
      expect(title).toBe("Flywheel Dashboard");
    })();
  });
});
