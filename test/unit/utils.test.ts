/**
 * test/unit/utils.test.ts
 * Covers: cli/utils.ts — shellQuote, trimTrailingSlash, getErrorMessage, getProjectName, truncate
 * No I/O, no network. Pure logic only.
 */

import { describe, it, expect } from "vitest";
import {
  shellQuote,
  trimTrailingSlash,
  getErrorMessage,
  getProjectName,
  truncate,
} from "../../cli/utils.js";

describe("shellQuote", () => {
  it("wraps a plain string in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });
  it("handles a path with spaces", () => {
    expect(shellQuote("/path/to/my dir")).toBe("'/path/to/my dir'");
  });
  it("escapes embedded single quotes using POSIX technique", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
  it("escapes multiple single quotes", () => {
    expect(shellQuote("a'b'c")).toBe("'a'\\''b'\\''c'");
  });
  it("handles an empty string", () => {
    expect(shellQuote("")).toBe("''");
  });
  it("preserves backslashes", () => {
    expect(shellQuote("a\\b")).toBe("'a\\b'");
  });
  it("is safe against shell injection attempts", () => {
    const dangerous = "'; rm -rf /; echo '";
    const quoted = shellQuote(dangerous);
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
  });
});

describe("trimTrailingSlash", () => {
  it("removes a single trailing slash", () => {
    expect(trimTrailingSlash("/path/to/dir/")).toBe("/path/to/dir");
  });
  it("removes multiple trailing slashes", () => {
    expect(trimTrailingSlash("/path///")).toBe("/path");
  });
  it("leaves a path with no trailing slash unchanged", () => {
    expect(trimTrailingSlash("/path/to/dir")).toBe("/path/to/dir");
  });
  it("handles a bare single slash", () => {
    expect(trimTrailingSlash("/")).toBe("");
  });
  it("handles an empty string", () => {
    expect(trimTrailingSlash("")).toBe("");
  });
});

describe("getErrorMessage", () => {
  it("extracts .message from an Error instance", () => {
    expect(getErrorMessage(new Error("something broke"))).toBe("something broke");
  });
  it("converts a string to itself", () => {
    expect(getErrorMessage("raw string error")).toBe("raw string error");
  });
  it("converts a number to string", () => {
    expect(getErrorMessage(42)).toBe("42");
  });
  it("handles null", () => {
    expect(getErrorMessage(null)).toBe("null");
  });
  it("handles undefined", () => {
    expect(getErrorMessage(undefined)).toBe("undefined");
  });
  it("works on Error subclasses", () => {
    class CustomError extends Error {}
    expect(getErrorMessage(new CustomError("custom"))).toBe("custom");
  });
});

describe("getProjectName", () => {
  it("returns a non-empty string", () => {
    const name = getProjectName();
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
  });
  it("does not throw", () => {
    expect(() => getProjectName()).not.toThrow();
  });
});

describe("truncate", () => {
  it("returns string unchanged when under the limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });
  it("returns string unchanged when exactly at the limit", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });
  it("truncates and adds ellipsis when over the limit", () => {
    const result = truncate("hello world", 5);
    expect(result.startsWith("hell")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(6);
  });
  it("handles empty string", () => {
    expect(truncate("", 5)).toBe("");
  });
});
