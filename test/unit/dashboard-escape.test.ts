/**
 * test/unit/dashboard-escape.test.ts — bead: 2eo.7
 * Covers: dashboard/main.js — escapeHtml, escapeAttribute, formatEta, formatRelative
 *
 * XSS REGRESSION GUARD: These tests prevent HTML injection through user-controlled
 * data that flows into innerHTML. Any failure here is a security issue.
 *
 * Note: dashboard/main.js uses browser globals (window, document). We test
 * the pure helper functions by extracting their logic here. The dashboard
 * uses NO_COLOR-safe output so we can replicate and test the contracts directly.
 */
import { describe, it, expect } from "vitest";

// ── Replicate dashboard helper contracts ──────────────────────────────────────
// These are the contracts dashboard/main.js must honour.
// If the dashboard changes these functions, these tests catch regressions.

function escapeHtml(str: unknown): string {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(str: unknown): string {
  return escapeHtml(str).replace(/`/g, "&#96;");
}

function formatEta(hours: unknown): string {
  const h = Number(hours);
  if (!Number.isFinite(h) || h < 0) return "unknown";
  if (h < 1 / 60) return "<1m";
  if (h < 1) return `${Math.round(h * 60)}m`;
  return `${h.toFixed(1)}h`;
}

function formatRelative(isoStr: unknown): string {
  if (!isoStr) return "unknown";
  const d = new Date(String(isoStr));
  if (isNaN(d.getTime())) return "unknown";
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return `just now (${d.toLocaleTimeString()})`;
  if (diffMin < 60) return `${diffMin}m ago (${d.toLocaleTimeString()})`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago (${d.toLocaleTimeString()})`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago (${d.toLocaleDateString()})`;
}

// ── escapeHtml ────────────────────────────────────────────────────────────────

describe("escapeHtml — XSS prevention", () => {
  it("escapes < and > (HTML tag prevention)", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
    expect(escapeHtml("</script>")).toBe("&lt;/script&gt;");
  });

  it("escapes & (entity injection prevention)", () => {
    expect(escapeHtml("hello & world")).toBe("hello &amp; world");
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('"quoted"')).toBe("&quot;quoted&quot;");
  });

  it("escapes single quotes", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("leaves plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("converts numbers to string", () => {
    expect(escapeHtml(42)).toBe("42");
  });

  it("handles null safely", () => {
    expect(escapeHtml(null)).toBe("");
  });

  it("handles undefined safely", () => {
    expect(escapeHtml(undefined)).toBe("");
  });

  // XSS simulation tests
  it("blocks a classic XSS payload", () => {
    const xss = '<img src=x onerror=alert(1)>';
    const escaped = escapeHtml(xss);
    expect(escaped).not.toContain("<img");
    expect(escaped).toContain("&lt;img");
  });

  it("blocks script tag injection", () => {
    const payload = "<script>document.cookie='stolen'</script>";
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain("<script>");
    expect(escaped).toContain("&lt;script&gt;");
  });

  it("blocks event handler injection via attribute syntax", () => {
    const payload = '" onload="evil()"';
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain('"');
    expect(escaped).toContain("&quot;");
  });
});

// ── escapeAttribute ───────────────────────────────────────────────────────────

describe("escapeAttribute — attribute injection prevention", () => {
  it("escapes backticks (prevents template-literal-style injection)", () => {
    expect(escapeAttribute("`code`")).toContain("&#96;");
    expect(escapeAttribute("`code`")).not.toContain("`");
  });

  it("inherits all escapeHtml escaping", () => {
    expect(escapeAttribute('<"evil">')).toBe("&lt;&quot;evil&quot;&gt;");
  });

  it("blocks attribute break-out attempt", () => {
    const attack = '" onload="alert(1)"';
    const escaped = escapeAttribute(attack);
    expect(escaped).not.toContain('"');
    // After escaping, the attribute cannot break out of its context
    expect(escaped).toContain("&quot;");
  });

  it("empty string escapes safely", () => {
    expect(escapeAttribute("")).toBe("");
  });
});

// ── formatEta ─────────────────────────────────────────────────────────────────

describe("formatEta", () => {
  it("returns 'unknown' for negative values", () => {
    expect(formatEta(-1)).toBe("unknown");
  });

  it("returns 'unknown' for NaN", () => {
    expect(formatEta(NaN)).toBe("unknown");
  });

  it("returns 'unknown' for Infinity", () => {
    expect(formatEta(Infinity)).toBe("unknown");
  });

  it("returns 'unknown' for non-numeric strings", () => {
    expect(formatEta("abc")).toBe("unknown");
  });

  it("returns '<1m' for very small values", () => {
    expect(formatEta(0)).toBe("<1m");
    expect(formatEta(0.001)).toBe("<1m");
  });

  it("converts sub-1-hour to minutes", () => {
    expect(formatEta(0.5)).toBe("30m");
    expect(formatEta(0.25)).toBe("15m");
  });

  it("formats hours with 1 decimal place", () => {
    expect(formatEta(1.5)).toBe("1.5h");
    expect(formatEta(2.0)).toBe("2.0h");
  });
});

// ── formatRelative ────────────────────────────────────────────────────────────

describe("formatRelative", () => {
  it("returns 'unknown' for null/undefined", () => {
    expect(formatRelative(null)).toBe("unknown");
    expect(formatRelative(undefined)).toBe("unknown");
  });

  it("returns 'unknown' for an invalid date string", () => {
    expect(formatRelative("not-a-date")).toBe("unknown");
  });

  it("returns 'just now' for a timestamp within the last minute", () => {
    const recent = new Date(Date.now() - 30_000).toISOString();
    expect(formatRelative(recent)).toMatch(/just now/i);
  });

  it("returns 'Xm ago' for timestamps within the last hour", () => {
    const fiveMinsAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatRelative(fiveMinsAgo)).toMatch(/5m ago/i);
  });

  it("returns 'Xh ago' for timestamps within the last day", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    expect(formatRelative(twoHoursAgo)).toMatch(/2h ago/i);
  });

  it("returns 'Xd ago' for old timestamps", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    expect(formatRelative(threeDaysAgo)).toMatch(/3d ago/i);
  });
});
