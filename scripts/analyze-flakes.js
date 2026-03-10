#!/usr/bin/env node
/**
 * scripts/analyze-flakes.js
 *
 * Reads vitest --reporter=json output from multiple runs and identifies tests
 * that passed in some runs and failed in others (flaky tests).
 *
 * Usage:
 *   node scripts/analyze-flakes.js <results-dir>
 *
 * <results-dir> should contain subdirs with *.json vitest result files.
 *
 * Writes flake-report.json to the working directory.
 * Exits 0 always — the calling workflow decides whether to fail based on count.
 */

import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const resultsDir = process.argv[2];
if (!resultsDir) {
  console.error("Usage: analyze-flakes.js <results-dir>");
  process.exit(1);
}

/** @param {string} dir */
function findJsonFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...findJsonFiles(full));
    } else if (entry.endsWith(".json")) {
      files.push(full);
    }
  }
  return files;
}

const jsonFiles = findJsonFiles(resultsDir);
console.log(`Found ${jsonFiles.length} result file(s)`);

// Map: test name → { passed: number, failed: number, runs: string[] }
/** @type {Map<string, { passed: number; failed: number; runs: string[] }>} */
const testResults = new Map();

for (const file of jsonFiles) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    console.warn(`Skipping unparseable file: ${file}`);
    continue;
  }

  const runLabel = basename(file, ".json");

  // vitest JSON output structure:
  // { testResults: [{ testFilePath, assertionResults: [{ fullName, status }] }] }
  const testFiles = raw.testResults ?? [];
  for (const testFile of testFiles) {
    for (const assertion of testFile.assertionResults ?? []) {
      const key = `${testFile.testFilePath} > ${assertion.fullName}`;
      const entry = testResults.get(key) ?? { passed: 0, failed: 0, runs: [] };
      entry.runs.push(runLabel);
      if (assertion.status === "passed") {
        entry.passed++;
      } else if (assertion.status === "failed") {
        // Only count genuine failures. "pending"/"todo"/"skipped" tests are
        // not flaky — they're intentionally skipped and should not pollute
        // the "always failing" or "flaky" buckets.
        entry.failed++;
      }
      // else: "pending", "todo", "skipped" — ignored intentionally
      testResults.set(key, entry);
    }
  }
}

// A test is flaky if it both passed and failed across runs
const flakyTests = [];
const alwaysFailing = [];
const alwaysPassing = [];

for (const [name, stats] of testResults.entries()) {
  if (stats.passed > 0 && stats.failed > 0) {
    flakyTests.push({
      test: name,
      passCount: stats.passed,
      failCount: stats.failed,
      totalRuns: stats.runs.length,
      flakyRate: `${((stats.failed / stats.runs.length) * 100).toFixed(0)}%`,
    });
  } else if (stats.failed > 0 && stats.passed === 0) {
    // Only report as "always failing" if there were genuine failures.
    // Tests that were always skipped (passed=0, failed=0) are excluded.
    alwaysFailing.push({ test: name, failCount: stats.failed });
  } else if (stats.passed > 0) {
    alwaysPassing.push(name);
  }
  // else: test only appeared as skipped across all runs — not counted anywhere
}

// Sort by flaky rate descending
flakyTests.sort((a, b) => b.failCount - a.failCount);

const report = {
  generatedAt: new Date().toISOString(),
  resultsDir,
  filesAnalyzed: jsonFiles.length,
  totalTests: testResults.size,
  alwaysPassingCount: alwaysPassing.length,
  alwaysFailingCount: alwaysFailing.length,
  flakyCount: flakyTests.length,
  flakyTests,
  alwaysFailing,
};

writeFileSync("flake-report.json", JSON.stringify(report, null, 2));

console.log("\n── Flake Detection Report ─────────────────────────────");
console.log(`Total tests analyzed : ${testResults.size}`);
console.log(`Always passing       : ${alwaysPassing.length}`);
console.log(`Always failing       : ${alwaysFailing.length}`);
console.log(`Flaky (mixed)        : ${flakyTests.length}`);

if (flakyTests.length > 0) {
  console.log("\nFlaky tests:");
  for (const t of flakyTests) {
    console.log(`  [${t.flakyRate} fail] ${t.test}`);
  }
}

if (alwaysFailing.length > 0) {
  console.log("\nAlways failing (not flaky — consistently broken):");
  for (const t of alwaysFailing) {
    console.log(`  ${t.test}`);
  }
}

console.log("\nFull report → flake-report.json");
