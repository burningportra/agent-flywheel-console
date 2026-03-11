/**
 * test/e2e/dashboard/02-operator-actions.e2e.ts — bead: agent-flywheel-console-3qw.4.3
 *
 * Exercises the dashboard action surface end-to-end through the real browser:
 *  - Gate advance: purely local (no SSH/VPS required) — verifies the full
 *    POST /action → server-side advanceGate() → snapshot update → UI render cycle
 *  - Prompt send disabled state: verified when no agents active
 *  - Swarm controls disabled state: verified before/after agent activity
 *  - Action log: verifies log entries appear after each action
 *
 * Uses HTTP /action and WebSocket action_result to validate both channels.
 * Screenshots captured on every major transition. Logs saved in afterAll.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { type StateManager } from "../../../cli/state.js";
import {
  assertSuccess,
  cleanupTestProject,
  hasSshConfig,
  runFlywheelWithDiagnostics,
} from "../setup.js";
import {
  startDashboardHarness,
  type CapturedActionRequest,
  type DashboardHarness,
} from "./00-harness.js";

const HOOK_TIMEOUT_MS = 30_000;
const WAIT_TIMEOUT_MS = 12_000;
const REMOTE_HOOK_TIMEOUT_MS = 240_000;
const REMOTE_WAIT_TIMEOUT_MS = 60_000;
const runVpsE2e = process.env.FLYWHEEL_TEST_E2E === "1" && hasSshConfig();
const describeVps = runVpsE2e ? describe : describe.skip;
const sourceSshYaml = join(homedir(), ".flywheel", "ssh.yaml");
const sourceProvidersYaml = join(homedir(), ".flywheel", "providers.yaml");
const remoteProjectName = `fw-dashboard-${Date.now().toString(36)}`;

interface TempEnv {
  homeDir: string;
  env: Record<string, string>;
  cleanup: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function waitForLive(h: DashboardHarness): Promise<void> {
  await h.page.waitForFunction(
    () => document.getElementById("ws-status")?.textContent?.includes("Live"),
    { timeout: WAIT_TIMEOUT_MS }
  );
}

async function waitForSnapshot(h: DashboardHarness): Promise<void> {
  await h.page.waitForFunction(
    () => {
      const el = document.getElementById("guidance-title");
      return el !== null && !el.textContent?.includes("Loading");
    },
    { timeout: WAIT_TIMEOUT_MS }
  );
}

/** Wait for the action log to contain a line matching the given text. */
async function waitForActionLog(h: DashboardHarness, text: string): Promise<void> {
  await h.page.waitForFunction(
    (needle: string) => {
      const log = document.getElementById("action-log");
      if (!log) return false;
      return Array.from(log.querySelectorAll("article")).some((el) =>
        el.textContent?.includes(needle)
      );
    },
    text,
    { timeout: WAIT_TIMEOUT_MS }
  );
}

async function waitForActionRequest(
  h: DashboardHarness,
  startIndex: number,
  actionType: string,
  timeoutMs = WAIT_TIMEOUT_MS
): Promise<CapturedActionRequest> {
  const startedAt = Date.now();

  for (;;) {
    const match = h.actionRequests
      .slice(startIndex)
      .find(
        (request) =>
          request.json &&
          typeof request.json === "object" &&
          (request.json as { type?: string }).type === actionType
      );

    if (match) {
      return match;
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for captured action request ${actionType}.`);
    }

    await h.page.waitForTimeout(50);
  }
}

async function waitForAgentCount(
  h: DashboardHarness,
  minimum: number,
  timeoutMs = REMOTE_WAIT_TIMEOUT_MS
): Promise<void> {
  await h.page.waitForFunction(
    (min: number) => {
      const raw = document.getElementById("metric-agents")?.textContent?.trim() ?? "0";
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) && parsed >= min;
    },
    minimum,
    { timeout: timeoutMs }
  );
}

async function waitForButtonEnabled(
  h: DashboardHarness,
  selector: string,
  timeoutMs = REMOTE_WAIT_TIMEOUT_MS
): Promise<void> {
  await h.page.waitForFunction(
    (targetSelector: string) => {
      const button = document.querySelector(targetSelector);
      return button instanceof HTMLButtonElement && button.disabled === false;
    },
    selector,
    { timeout: timeoutMs }
  );
}

function createTempEnv(copySshConfig: boolean): TempEnv {
  const homeDir = mkdtempSync(join(tmpdir(), "flywheel-dashboard-home-"));

  if (copySshConfig) {
    if (!existsSync(sourceSshYaml)) {
      throw new Error(`Missing SSH config at ${sourceSshYaml}`);
    }
    cpSync(sourceSshYaml, join(homeDir, "ssh.yaml"));
    if (existsSync(sourceProvidersYaml)) {
      cpSync(sourceProvidersYaml, join(homeDir, "providers.yaml"));
    }
  }

  return {
    homeDir,
    env: {
      FLYWHEEL_HOME: homeDir,
      FLYWHEEL_STATE_DB: join(homeDir, "state.db"),
    },
    cleanup: () => {
      rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

// ── Gate advance — local action, no SSH needed ────────────────────────────────

describe("Dashboard operator — gate.advance action (local, no SSH)", () => {
  let h: DashboardHarness;
  let runId: string;

  beforeAll(async () => {
    h = await startDashboardHarness({
      suite: "actions-gate",
      seedState: (sm: StateManager) => {
        runId = sm.createFlywheelRun("gate-test-project", "plan");
      },
    });
    await waitForLive(h);
    await waitForSnapshot(h);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    h?.saveLogs("gate-advance");
    await h?.teardown();
  }, HOOK_TIMEOUT_MS);

  it("gate-submit button is enabled when a run exists", async () => {
    const disabled = await h.page.locator("#gate-submit").isDisabled();
    expect(disabled).toBe(false);
    await h.screenshot("gate-enabled");
  });

  it("phase is initially 'plan'", async () => {
    const text = await h.page.locator("#metric-phase").textContent();
    expect(text).toBe("plan");
  });

  it("advancing gate to 'beads' updates the phase metric", async () => {
    // Select "beads" in the gate-phase dropdown (it's already the first option)
    await h.page.selectOption("#gate-phase", "beads");

    // Submit the gate form
    await h.page.locator("#gate-submit").click();

    // Wait for the action log to confirm success
    await waitForActionLog(h, "gate.advance succeeded");

    // After snapshot refresh, the phase metric should update
    await h.page.waitForFunction(
      () => document.getElementById("metric-phase")?.textContent === "beads",
      { timeout: WAIT_TIMEOUT_MS }
    );

    const phase = await h.page.locator("#metric-phase").textContent();
    expect(phase).toBe("beads");
    await h.screenshot("after-gate-advance");
  });

  it("advancing gate twice moves phase to 'swarm'", async () => {
    await h.page.selectOption("#gate-phase", "swarm");
    await h.page.locator("#gate-submit").click();

    await waitForActionLog(h, "gate.advance succeeded");

    await h.page.waitForFunction(
      () => document.getElementById("metric-phase")?.textContent === "swarm",
      { timeout: WAIT_TIMEOUT_MS }
    );
    expect(await h.page.locator("#metric-phase").textContent()).toBe("swarm");
  });

  it("action log shows INFO entries for each gate advance", async () => {
    const logEntries = await h.page
      .locator("#action-log article")
      .allTextContents();
    const advanceEntries = logEntries.filter((t) =>
      t.includes("gate.advance succeeded")
    );
    // We've done two gate advances in this describe block
    expect(advanceEntries.length).toBeGreaterThanOrEqual(2);
  });
});

// ── HTTP /action endpoint ─────────────────────────────────────────────────────

describe("Dashboard operator — /action HTTP endpoint verification", () => {
  let h: DashboardHarness;

  beforeAll(async () => {
    h = await startDashboardHarness({
      suite: "actions-http",
      seedState: (sm: StateManager) => {
        sm.createFlywheelRun("http-test-project", "plan");
      },
    });
    await waitForLive(h);
    await waitForSnapshot(h);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    h?.saveLogs("actions-http");
    await h?.teardown();
  }, HOOK_TIMEOUT_MS);

  it("POST /action gate.advance returns { ok: true } and correct nextPhase", async () => {
    // Use the Playwright page to execute fetch() against our local test server,
    // bypassing the UI to test the HTTP contract directly.
    const result = await h.page.evaluate(async (baseUrl: string) => {
      const response = await fetch(`${baseUrl}/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "gate.advance", nextPhase: "beads" }),
      });
      return response.json() as Promise<{ ok: boolean; action: string; payload: unknown }>;
    }, h.baseUrl);

    expect(result.ok).toBe(true);
    expect(result.action).toBe("gate.advance");
    expect((result.payload as { nextPhase: string }).nextPhase).toBe("beads");
  });

  it("POST /action with invalid JSON returns 400", async () => {
    const result = await h.page.evaluate(async (baseUrl: string) => {
      const response = await fetch(`${baseUrl}/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not valid json",
      });
      return { status: response.status, body: await response.json() as { ok: boolean } };
    }, h.baseUrl);

    expect(result.status).toBe(400);
    expect(result.body.ok).toBe(false);
  });

  it("POST /action with unknown action type returns error", async () => {
    const result = await h.page.evaluate(async (baseUrl: string) => {
      const response = await fetch(`${baseUrl}/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "unknown.action" }),
      });
      return { status: response.status, body: await response.json() as { ok: boolean } };
    }, h.baseUrl);

    // Server returns 200 with ok:false (handled action that fails) or
    // 400 if validation catches it before handleAction
    expect(result.body.ok).toBe(false);
  });
});

// ── Disabled action states ────────────────────────────────────────────────────

describe("Dashboard operator — disabled action states (no SSH, no agents)", () => {
  let h: DashboardHarness;

  beforeAll(async () => {
    // No SSH, no agents → swarm.pause and swarm.resume should be disabled
    h = await startDashboardHarness({ suite: "actions-disabled" });
    await waitForLive(h);
    await waitForSnapshot(h);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    h?.saveLogs("actions-disabled");
    await h?.teardown();
  }, HOOK_TIMEOUT_MS);

  it("pause button is disabled when no agents are active", async () => {
    const disabled = await h.page.locator("#pause-button").isDisabled();
    expect(disabled).toBe(true);
    await h.screenshot("pause-disabled");
  });

  it("gate-submit is disabled when no run exists", async () => {
    const disabled = await h.page.locator("#gate-submit").isDisabled();
    expect(disabled).toBe(true);
  });

  it("gate-note shows informational text when gate is unavailable", async () => {
    const text = await h.page.locator("#gate-note").textContent();
    // The gate note should mention "run" or similar guidance
    expect(text?.length).toBeGreaterThan(0);
    await h.screenshot("gate-disabled-state");
  });
});

// ── Prompt send failure path ──────────────────────────────────────────────────

describe("Dashboard operator — prompt send error path (no SSH)", () => {
  let h: DashboardHarness;

  beforeAll(async () => {
    h = await startDashboardHarness({ suite: "actions-prompt-errors" });
    await waitForLive(h);
    await waitForSnapshot(h);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    h?.saveLogs("prompt-send-errors");
    await h?.teardown();
  }, HOOK_TIMEOUT_MS);

  it("posts the prompt.send payload and surfaces an operator-facing SSH failure", async () => {
    await h.page.locator("#prompt-name").fill("agent-unstuck");
    await h.page.locator("#prompt-all").check();

    const beforeRequestCount = h.actionRequests.length;
    await h.page.locator("#prompt-submit").click();

    const request = await waitForActionRequest(h, beforeRequestCount, "prompt.send");
    expect(request.json).toMatchObject({
      type: "prompt.send",
      promptName: "agent-unstuck",
      all: true,
    });

    await waitForActionLog(h, "Action prompt.send failed");
    const actionLogText = await h.page.locator("#action-log").textContent();
    expect(actionLogText).toMatch(/ssh|connect|prompt\.send/i);
    await h.screenshot("prompt-send-no-ssh-failure");
  });
});

// ── Pause/resume control states ───────────────────────────────────────────────

describe("Dashboard operator — swarm control button visibility", () => {
  let h: DashboardHarness;

  beforeAll(async () => {
    h = await startDashboardHarness({
      suite: "actions-swarm-controls",
      seedState: (sm: StateManager) => {
        sm.createFlywheelRun("swarm-project", "swarm");
      },
    });
    await waitForLive(h);
    await waitForSnapshot(h);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    h?.saveLogs("swarm-controls");
    await h?.teardown();
  }, HOOK_TIMEOUT_MS);

  it("pause button exists and is visible in the DOM", async () => {
    const exists = await h.page.locator("#pause-button").count();
    expect(exists).toBe(1);
  });

  it("resume button exists and is visible in the DOM", async () => {
    const exists = await h.page.locator("#resume-button").count();
    expect(exists).toBe(1);
  });

  it("swarm-controls-note shows guidance text", async () => {
    const text = await h.page.locator("#swarm-controls-note").textContent();
    expect(typeof text).toBe("string");
    // Note should be non-empty context text
    expect(text?.trim().length).toBeGreaterThan(0);
    await h.screenshot("swarm-controls-view");
  });
});

// ── Remote operator actions ───────────────────────────────────────────────────

describeVps("Dashboard operator — remote prompt dispatch and swarm pause", () => {
  let h: DashboardHarness;
  let remoteEnv: TempEnv | null = null;
  let remoteWorkspaceDir = "";

  beforeAll(async () => {
    remoteEnv = createTempEnv(true);
    remoteWorkspaceDir = mkdtempSync(join(tmpdir(), "flywheel-dashboard-ws-"));
    const remoteProjectDir = join(remoteWorkspaceDir, remoteProjectName);
    mkdirSync(remoteProjectDir, { recursive: true });

    const initResult = await runFlywheelWithDiagnostics(["init", remoteProjectName], {
      cwd: remoteProjectDir,
      env: remoteEnv.env,
      timeout: 120_000,
      remoteDiagnostics: true,
      remoteProjectName,
    });
    assertSuccess(initResult, "dashboard remote init");

    const swarmResult = await runFlywheelWithDiagnostics(["swarm", "2", "--no-commit"], {
      cwd: remoteProjectDir,
      env: remoteEnv.env,
      timeout: 180_000,
      remoteDiagnostics: true,
      remoteProjectName,
    });
    assertSuccess(swarmResult, "dashboard remote swarm bootstrap");

    h = await startDashboardHarness({
      suite: "actions-remote",
      seedState: (sm: StateManager) => {
        sm.createFlywheelRun(remoteProjectName, "swarm");
      },
    });
    await waitForLive(h);
    await waitForSnapshot(h);
    await waitForAgentCount(h, 1);
    await waitForButtonEnabled(h, "#pause-button");
    await waitForButtonEnabled(h, "#prompt-submit");
  }, REMOTE_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    try {
      h?.saveLogs("actions-remote");
      await h?.teardown();
    } finally {
      await cleanupTestProject(remoteProjectName);
      if (remoteWorkspaceDir) {
        rmSync(remoteWorkspaceDir, { recursive: true, force: true });
      }
      remoteEnv?.cleanup();
      remoteEnv = null;
      remoteWorkspaceDir = "";
    }
  }, REMOTE_HOOK_TIMEOUT_MS);

  it("keeps pause enabled while surfacing resume guidance for the installed NTM build", async () => {
    expect(await h.page.locator("#pause-button").isDisabled()).toBe(false);
    expect(await h.page.locator("#resume-button").isDisabled()).toBe(true);

    const swarmNote = await h.page.locator("#swarm-controls-note").textContent();
    expect(swarmNote).toMatch(/resume|pause\/interrupt|re-sending prompts/i);
  }, 60_000);

  it("dispatches a prompt from the browser and records the POST /action payload", async () => {
    await h.page.locator('[data-prompt-name="agent-unstuck"]').click();
    await h.page.locator("#prompt-all").check();

    const beforeRequestCount = h.actionRequests.length;
    await h.page.locator("#prompt-submit").click();

    const request = await waitForActionRequest(
      h,
      beforeRequestCount,
      "prompt.send",
      REMOTE_WAIT_TIMEOUT_MS
    );
    expect(request.json).toMatchObject({
      type: "prompt.send",
      promptName: "agent-unstuck",
      all: true,
    });

    await waitForActionLog(h, "Action prompt.send succeeded");
    await h.screenshot("remote-prompt-send-success");
  }, 90_000);

  it("pauses the live swarm from the browser and records the POST /action payload", async () => {
    const beforeRequestCount = h.actionRequests.length;
    await h.page.locator("#pause-button").click();

    const request = await waitForActionRequest(
      h,
      beforeRequestCount,
      "swarm.pause",
      REMOTE_WAIT_TIMEOUT_MS
    );
    expect(request.json).toMatchObject({
      type: "swarm.pause",
    });

    await waitForActionLog(h, "Action swarm.pause succeeded");
    await h.screenshot("remote-swarm-pause-success");
  }, 90_000);
});
