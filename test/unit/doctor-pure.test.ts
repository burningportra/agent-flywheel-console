/**
 * test/unit/doctor-pure.test.ts — bead: agent-1879.2
 *
 * Tests the pure helpers in cli/doctor.ts without running the full diagnostic.
 *
 * Covers:
 *   - ok/warn/fail: correct status and field pass-through
 *   - render: icon selection, label column alignment, detail formatting
 *   - collectRecommendations: each recommendation branch fires correctly
 */
import { describe, it, expect, afterEach } from "vitest";
import { ok, warn, fail, render, collectRecommendations } from "../../cli/doctor.js";
import { captureConsole, stripAnsi } from "../helpers.js";

// ── ok / warn / fail constructors ─────────────────────────────────────────────

describe("Check constructors — ok, warn, fail", () => {
  it("ok() creates a Check with status='ok'", () => {
    const c = ok("ssh.yaml", "loaded");
    expect(c).toEqual({ label: "ssh.yaml", status: "ok", detail: "loaded" });
  });

  it("warn() creates a Check with status='warn'", () => {
    const c = warn("providers.yaml", "not found");
    expect(c.status).toBe("warn");
    expect(c.label).toBe("providers.yaml");
    expect(c.detail).toBe("not found");
  });

  it("fail() creates a Check with status='fail'", () => {
    const c = fail("SSH connectivity", "connection refused");
    expect(c.status).toBe("fail");
    expect(c.detail).toBe("connection refused");
  });
});

// ── render ────────────────────────────────────────────────────────────────────

describe("render — output format and column alignment", () => {
  let cap: ReturnType<typeof captureConsole>;

  afterEach(() => {
    cap?.restore();
  });

  it("ok check prints ✓ icon", () => {
    cap = captureConsole();
    render([ok("ssh.yaml", "loaded + key readable")]);
    cap.restore();
    const line = stripAnsi(cap.out);
    expect(line).toContain("✓");
    expect(line).toContain("ssh.yaml");
    expect(line).toContain("loaded + key readable");
  });

  it("warn check prints ⚠ icon", () => {
    cap = captureConsole();
    render([warn("providers.yaml", "not found")]);
    cap.restore();
    expect(stripAnsi(cap.out)).toContain("⚠");
  });

  it("fail check prints ✗ icon", () => {
    cap = captureConsole();
    render([fail("SSH connectivity", "refused")]);
    cap.restore();
    expect(stripAnsi(cap.out)).toContain("✗");
  });

  it("label column is right-padded so detail starts at consistent column", () => {
    cap = captureConsole();
    render([
      ok("short", "detail-a"),
      ok("a-much-longer-label-name", "detail-b"),
    ]);
    cap.restore();
    const lines = stripAnsi(cap.out).split("\n").filter(Boolean);
    // Both detail strings should start at the same column (after padded label)
    const col0 = lines[0].indexOf("detail-a");
    const col1 = lines[1].indexOf("detail-b");
    expect(col0).toBe(col1);
  });

  it("label column is at least 32 chars wide even for short labels", () => {
    cap = captureConsole();
    render([ok("x", "d")]);
    cap.restore();
    const line = stripAnsi(cap.out);
    // "  ✓ " (4) + 32-char padded label + " d"
    // detail 'd' should appear at position >= 4 + 32
    const detailPos = line.indexOf("d");
    expect(detailPos).toBeGreaterThanOrEqual(36);
  });

  it("multiple checks each get their own line", () => {
    cap = captureConsole();
    render([ok("a", "1"), warn("b", "2"), fail("c", "3")]);
    cap.restore();
    const lines = stripAnsi(cap.out).split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
  });
});

// ── collectRecommendations ────────────────────────────────────────────────────

describe("collectRecommendations — actionable suggestions for each failure type", () => {
  it("returns empty array when all checks pass", () => {
    const recs = collectRecommendations([
      ok("ssh.yaml", "ok"),
      ok("SSH connectivity", "10ms"),
      ok("providers.yaml", "3 slots"),
    ]);
    expect(recs).toHaveLength(0);
  });

  it("ssh.yaml fail → recommendation to run flywheel settings ssh", () => {
    const recs = collectRecommendations([fail("ssh.yaml", "not found")]);
    expect(recs.length).toBeGreaterThan(0);
    const rec = recs.find((r) => r.severity === "fail");
    expect(rec).toBeDefined();
    expect(rec!.text).toMatch(/flywheel settings ssh/);
  });

  it("SSH connectivity fail → recommendation to check VPS / run flywheel ssh test", () => {
    const recs = collectRecommendations([fail("SSH connectivity", "refused")]);
    const rec = recs.find((r) => r.severity === "fail");
    expect(rec).toBeDefined();
    expect(rec!.text).toMatch(/flywheel ssh test/i);
  });

  it("providers.yaml warn → recommendation mentioning the providers file", () => {
    const recs = collectRecommendations([warn("providers.yaml", "not found")]);
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0].text).toMatch(/providers/i);
  });

  it("providers.yaml fail → recommendation has severity='fail'", () => {
    const recs = collectRecommendations([fail("providers.yaml", "missing")]);
    const failRec = recs.find((r) => r.severity === "fail");
    expect(failRec).toBeDefined();
  });

  it("multiple failures → multiple independent recommendations", () => {
    const recs = collectRecommendations([
      fail("ssh.yaml", "not found"),
      fail("SSH connectivity", "refused"),
      warn("providers.yaml", "not found"),
    ]);
    expect(recs.length).toBeGreaterThanOrEqual(3);
  });
});
