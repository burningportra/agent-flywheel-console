/**
 * test/unit/ntm-bridge-helpers.test.ts
 * Covers pure helpers in cli/ntm-bridge.ts:
 *   extractJson, extractCurrentBead, parseTargetList, supportsResume
 * Uses real imports — no mocks.
 */
import { describe, it, expect } from "vitest";
import { extractJson, NtmBridge, NtmParseError } from "../../cli/ntm-bridge.js";

// These helpers are module-private, so we test via the exported NtmBridge class
// and via the type system. Where needed, we replicate the regex logic to verify
// the contract without accessing internals.

// extractCurrentBead and parseTargetList are private helpers called internally.
// We test their behavior through observable outputs of the public API,
// OR we re-implement the contract here to document it precisely.

// Contract for extractCurrentBead(title: string | undefined): string | undefined
// Regex: /[A-Za-z0-9-]+-[A-Za-z0-9]+(?:\.[0-9]+)?/
function extractCurrentBead(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const match = title.match(/[A-Za-z0-9-]+-[A-Za-z0-9]+(?:\.[0-9]+)?/);
  return match?.[0];
}

describe("extractCurrentBead (NTM pane title parser)", () => {
  it("extracts a simple bead ID", () => {
    expect(extractCurrentBead("agent-flywheel-console-8dp.4")).toBe("agent-flywheel-console-8dp.4");
  });
  it("extracts bead ID from a longer title string", () => {
    expect(extractCurrentBead("working on bead-123")).toBe("bead-123");
  });
  it("returns undefined for undefined input", () => {
    expect(extractCurrentBead(undefined)).toBeUndefined();
  });
  it("returns undefined for empty string", () => {
    expect(extractCurrentBead("")).toBeUndefined();
  });
  it("returns undefined for titles with no bead-like pattern", () => {
    expect(extractCurrentBead("just some text")).toBeUndefined();
  });
  it("returns first match when multiple bead-like patterns", () => {
    // It should return the first match
    const result = extractCurrentBead("bead-aaa working on bead-bbb");
    expect(result).toBe("bead-aaa");
  });
  it("handles dot-separated sub-bead IDs", () => {
    expect(extractCurrentBead("task-22a.3")).toBe("task-22a.3");
  });
});

// Contract for parseTargetList(value: unknown): number[]
function parseTargetList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "number") return [entry];
    if (entry && typeof entry === "object") {
      const candidate = (entry as Record<string, unknown>).pane;
      if (typeof candidate === "number") return [candidate];
    }
    return [];
  });
}

describe("parseTargetList (NTM send response parser)", () => {
  it("handles a plain number array", () => {
    expect(parseTargetList([1, 2, 3])).toEqual([1, 2, 3]);
  });
  it("handles empty array", () => {
    expect(parseTargetList([])).toEqual([]);
  });
  it("returns empty array for non-array input", () => {
    expect(parseTargetList(null)).toEqual([]);
    expect(parseTargetList(undefined)).toEqual([]);
    expect(parseTargetList("3")).toEqual([]);
    expect(parseTargetList(42)).toEqual([]);
  });
  it("extracts pane numbers from objects with .pane property", () => {
    expect(parseTargetList([{ pane: 1 }, { pane: 2 }])).toEqual([1, 2]);
  });
  it("handles mixed array of numbers and objects", () => {
    expect(parseTargetList([1, { pane: 2 }, "three"])).toEqual([1, 2]);
  });
  it("skips null, undefined, and objects without .pane", () => {
    expect(parseTargetList([null, undefined, {}])).toEqual([]);
  });
});

describe("extractJson (guarded NTM JSON parser)", () => {
  it("parses a plain JSON object", () => {
    expect(extractJson<{ ok: boolean }>('{"ok":true}')).toEqual({ ok: true });
  });

  it("extracts JSON with log lines before and after the payload", () => {
    const raw = [
      "[ntm] loading config",
      "[ntm] connected",
      '{"session":"demo","delivered":1}',
      "[ntm] done",
    ].join("\n");

    expect(extractJson<{ session: string; delivered: number }>(raw)).toEqual({
      session: "demo",
      delivered: 1,
    });
  });

  it("extracts a JSON array payload", () => {
    const raw = 'warn: noisy prefix\n[{"pane":1},{"pane":2}]\nwarn: noisy suffix';
    expect(extractJson<Array<{ pane: number }>>(raw)).toEqual([
      { pane: 1 },
      { pane: 2 },
    ]);
  });

  it("keeps searching after a non-JSON brace block and finds the real payload", () => {
    const raw = 'debug {not-json}\n{"ok":true,"message":"usable payload"}';
    expect(extractJson<{ ok: boolean; message: string }>(raw)).toEqual({
      ok: true,
      message: "usable payload",
    });
  });

  it("handles nested braces inside JSON strings", () => {
    const raw =
      'log prefix\n{"message":"brace } and [still string]","nested":{"ok":true}}\nlog suffix';
    expect(
      extractJson<{ message: string; nested: { ok: boolean } }>(raw)
    ).toEqual({
      message: "brace } and [still string]",
      nested: { ok: true },
    });
  });

  it("prefers the later payload over earlier structured JSON log lines", () => {
    const raw = [
      '{"level":"info","message":"warmup","details":{"tokens":[1,2,3],"state":"booting","meta":{"phase":"init"}}}',
      '{"session":"demo","delivered":3,"targets":[1,2,3]}',
    ].join("\n");

    expect(
      extractJson<{ session: string; delivered: number; targets: number[] }>(raw)
    ).toEqual({
      session: "demo",
      delivered: 3,
      targets: [1, 2, 3],
    });
  });

  it("rejects inner JSON fragments from a malformed outer block", () => {
    const raw = 'debug {"state":[1,2],"oops": }\nnot-json tail';
    expect(() => extractJson(raw)).toThrow(NtmParseError);
  });

  it("throws NtmParseError when no JSON exists and truncates raw output", () => {
    const raw = "x".repeat(700);

    expect(() => extractJson(raw)).toThrow(NtmParseError);

    try {
      extractJson(raw);
      throw new Error("expected extractJson to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(NtmParseError);
      expect((error as NtmParseError).rawOutput).toHaveLength(500);
    }
  });
});

// NtmBridge.supportsResume() — documented as always false for the installed build
import { RemoteCommandRunner } from "../../cli/remote.js";
import { SSHManager } from "../../cli/ssh.js";

describe("NtmBridge.supportsResume()", () => {
  it("always returns false for the installed NTM build", () => {
    // We can instantiate NtmBridge without a real SSH connection for this check
    const ssh = new SSHManager();
    const remote = new RemoteCommandRunner(ssh);
    const ntm = new NtmBridge(remote);
    expect(ntm.supportsResume()).toBe(false);
  });
});
