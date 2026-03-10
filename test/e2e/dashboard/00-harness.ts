/**
 * test/e2e/dashboard/00-harness.ts — bead: agent-flywheel-console-3qw.4.1
 *
 * Browser E2E harness for the Flywheel dashboard.
 *
 * Provides deterministic startup/teardown, local-server bootstrapping,
 * Playwright page factories, and rich artifact capture so dashboard E2E
 * tests can focus entirely on operator workflows instead of infrastructure.
 *
 * Features:
 *  - startDashboardHarness() — starts FlywheelServer on port 0 + launches
 *    a headless Chromium browser page, connected and ready for assertions.
 *  - Screenshot capture on demand and automatically on any uncaught error.
 *  - Browser console + failed network request capture written to the test
 *    artifact directory so CI failures are diagnosable without a re-run.
 *  - Graceful teardown (close page → close browser → stop server → cleanup).
 *
 * Usage:
 *   import { startDashboardHarness } from './00-harness.js';
 *
 *   let h: DashboardHarness;
 *   beforeEach(async () => { h = await startDashboardHarness(); });
 *   afterEach(async () => { await h.teardown(); });
 *
 *   it('shows no-run banner', async () => {
 *     await h.page.waitForSelector('[data-testid="no-runs-banner"]');
 *     await h.screenshot('no-runs-state');
 *   });
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Request, type Response } from "@playwright/test";
import { initDb, StateManager } from "../../../cli/state.js";
import { createFlywheelServer, type FlywheelServer } from "../../../cli/server.js";

// ─── Artifact directory ────────────────────────────────────────────────────────

const ARTIFACTS_ROOT = resolve("test-artifacts");

function artifactsDir(suite: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const dir = join(ARTIFACTS_ROOT, date, "dashboard", suite);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Console + network log capture ────────────────────────────────────────────

export interface CapturedConsoleMessage {
  type: string;
  text: string;
  timestamp: string;
}

export interface CapturedFailedRequest {
  url: string;
  method: string;
  status: number | null;
  timestamp: string;
}

// ─── Harness interface ────────────────────────────────────────────────────────

export interface DashboardHarness {
  /** The Playwright page ready to drive the dashboard */
  page: Page;
  /** Base URL of the running FlywheelServer */
  baseUrl: string;
  /** WebSocket URL of the running FlywheelServer */
  wsUrl: string;
  /** All browser console messages captured since startup */
  consoleLogs: CapturedConsoleMessage[];
  /** All failed (non-2xx) network requests captured since startup */
  failedRequests: CapturedFailedRequest[];
  /**
   * Save a screenshot to the test-artifacts directory.
   * @param name  Short label, e.g. "no-runs-state" — becomes filename prefix.
   * @returns     Absolute path to the saved file.
   */
  screenshot(name: string): Promise<string>;
  /**
   * Save a snapshot of captured console messages and failed requests to disk.
   * Call this in afterEach so CI always has a log, even on passing tests.
   */
  saveLogs(testTitle: string): void;
  /** Stop the browser and server and delete temp resources */
  teardown(): Promise<void>;
}

// ─── Options ──────────────────────────────────────────────────────────────────

export interface DashboardHarnessOptions {
  /**
   * Suite name used to scope artifact subdirectory.
   * Defaults to "default".
   */
  suite?: string;
  /**
   * Seed the state DB before starting the server.
   * Useful for testing "populated" vs "empty" states.
   */
  seedState?: (sm: StateManager) => void;
  /**
   * Additional CLI env vars to pass when creating the server.
   * Merged over the FLYWHEEL_HOME isolation env.
   */
  serverEnv?: Record<string, string>;
  /**
   * Playwright browser launch options override.
   */
  headless?: boolean;
  /**
   * Page navigation timeout in ms (default: 10 000).
   */
  navigationTimeoutMs?: number;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Start a FlywheelServer on an OS-assigned port, launch a headless Chromium
 * browser, navigate to the dashboard, and return the harness handle.
 *
 * Call `h.teardown()` in afterEach — it is idempotent and always safe.
 */
export async function startDashboardHarness(
  opts: DashboardHarnessOptions = {}
): Promise<DashboardHarness> {
  const suite = opts.suite ?? "default";
  const headless = opts.headless !== false; // default true
  const navTimeout = opts.navigationTimeoutMs ?? 10_000;
  const dir = artifactsDir(suite);

  // ── Start FlywheelServer with an isolated in-memory DB ─────────────────────

  const db = initDb(":memory:");
  const sm = new StateManager(db);
  if (opts.seedState) {
    opts.seedState(sm);
  }

  const server: FlywheelServer = createFlywheelServer({
    port: 0, // OS-assigned — avoids port conflicts in parallel test runs
    stateManager: sm,
  });
  await server.start();

  // Retrieve the actual bound port from the server's internal HTTP server.
  // FlywheelServer exposes this via getSnapshot().server.port after start().
  const boundPort = server.getSnapshot().server.port;
  const baseUrl = `http://127.0.0.1:${boundPort}`;
  const wsUrl = `ws://127.0.0.1:${boundPort}/ws`;

  // ── Launch Chromium browser ─────────────────────────────────────────────────

  const browser: Browser = await chromium.launch({ headless });
  const context: BrowserContext = await browser.newContext({
    baseURL: baseUrl,
    viewport: { width: 1280, height: 900 },
  });

  // ── Set up capture ──────────────────────────────────────────────────────────

  const consoleLogs: CapturedConsoleMessage[] = [];
  const failedRequests: CapturedFailedRequest[] = [];

  const page: Page = await context.newPage();
  page.setDefaultNavigationTimeout(navTimeout);
  page.setDefaultTimeout(navTimeout);

  // Capture all browser console output
  page.on("console", (msg) => {
    consoleLogs.push({
      type: msg.type(),
      text: msg.text(),
      timestamp: new Date().toISOString(),
    });
  });

  // Capture page-level errors (uncaught exceptions)
  page.on("pageerror", (error) => {
    consoleLogs.push({
      type: "pageerror",
      text: error.message,
      timestamp: new Date().toISOString(),
    });
  });

  // Capture failed network requests (non-2xx or network errors)
  page.on("requestfailed", (request: Request) => {
    failedRequests.push({
      url: request.url(),
      method: request.method(),
      status: null, // request failed at network level, no status
      timestamp: new Date().toISOString(),
    });
  });

  page.on("response", (response: Response) => {
    if (response.status() >= 400) {
      failedRequests.push({
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ── Inject the correct server URL before the page loads ────────────────────
  // The dashboard's index.html defaults the #server-url input to
  // "http://127.0.0.1:4200". The JavaScript reads this value (or localStorage)
  // when bootstrapping the WebSocket connection. If we navigate without
  // setting the correct URL first, the WebSocket will try to connect to port
  // 4200 instead of our OS-assigned test port and will never reach "Live".
  //
  // addInitScript() runs before any page scripts execute, so setting
  // localStorage here overrides the default before hydrateServerUrl() reads it.
  await page.addInitScript(
    ({ key, url }: { key: string; url: string }) => {
      localStorage.setItem(key, url);
    },
    { key: "flywheel.dashboard.server-url", url: baseUrl }
  );

  // ── Navigate to dashboard ───────────────────────────────────────────────────

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

  // ── Build teardown function ─────────────────────────────────────────────────

  let torn = false;

  const teardown = async (): Promise<void> => {
    if (torn) return;
    torn = true;
    try {
      await page.close();
    } catch { /* best-effort */ }
    try {
      await context.close();
    } catch { /* best-effort */ }
    try {
      await browser.close();
    } catch { /* best-effort */ }
    try {
      await server.stop();
    } catch { /* best-effort */ }
  };

  // ── Build screenshot helper ─────────────────────────────────────────────────

  let screenshotIndex = 0;

  const screenshot = async (name: string): Promise<string> => {
    screenshotIndex++;
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const fileName = `${String(screenshotIndex).padStart(2, "0")}-${ts}-${name}.png`;
    const filePath = join(dir, fileName);
    let lastError: unknown;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await page.screenshot({
          path: filePath,
          fullPage: true,
          animations: "disabled",
          caret: "hide",
        });
        return filePath;
      } catch (error) {
        lastError = error;
        if (attempt === 2 || page.isClosed()) {
          break;
        }
        await page.waitForTimeout(250);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };

  // ── Build log saver ─────────────────────────────────────────────────────────

  const saveLogs = (testTitle: string): void => {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const slug = testTitle.replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
    const logPath = join(dir, `${ts}-${slug}-log.txt`);

    const lines: string[] = [
      `=== Dashboard E2E Log: ${testTitle} ===`,
      `Timestamp: ${new Date().toISOString()}`,
      `Server:    ${baseUrl}`,
      "",
      "── Console Messages ──────────────────────────────────────",
    ];

    if (consoleLogs.length === 0) {
      lines.push("  (none)");
    } else {
      for (const entry of consoleLogs) {
        lines.push(`  [${entry.timestamp}] [${entry.type.toUpperCase()}] ${entry.text}`);
      }
    }

    lines.push("", "── Failed Requests ───────────────────────────────────────");
    if (failedRequests.length === 0) {
      lines.push("  (none)");
    } else {
      for (const req of failedRequests) {
        const status = req.status !== null ? String(req.status) : "NET_ERR";
        lines.push(`  [${req.timestamp}] ${req.method} ${req.url} → ${status}`);
      }
    }

    lines.push("");

    try {
      appendFileSync(logPath, lines.join("\n"), "utf8");
    } catch {
      // best-effort — never fail a test because of artifact writing
    }
  };

  return {
    page,
    baseUrl,
    wsUrl,
    consoleLogs,
    failedRequests,
    screenshot,
    saveLogs,
    teardown,
  };
}

// ─── Test-level screenshot-on-failure ────────────────────────────────────────

/**
 * Wrap a Playwright test body so that any uncaught error triggers an automatic
 * "on-failure" screenshot before the error propagates.
 *
 * Usage (in an `it()` block):
 *   it('shows gate button', withFailureScreenshot(h, 'gate-btn', async () => {
 *     await h.page.waitForSelector('[data-testid="gate-advance"]');
 *   }));
 */
export function withFailureScreenshot(
  harness: DashboardHarness,
  screenshotName: string,
  fn: () => Promise<void>
): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (err) {
      try {
        await harness.screenshot(`FAIL-${screenshotName}`);
      } catch {
        // Never suppress the original error because screenshot failed
      }
      throw err;
    }
  };
}
