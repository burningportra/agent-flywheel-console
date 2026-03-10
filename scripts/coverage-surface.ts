#!/usr/bin/env tsx
/**
 * scripts/coverage-surface.ts — bead: 3qw.3.2
 *
 * Command-surface gap detector.
 *
 * Scans every cli/*.ts module for exported identifiers (functions, classes,
 * constants, interfaces, types) then checks whether each identifier is
 * referenced in any test file. Outputs a gap report to stdout.
 *
 * Usage:
 *   npm run test:surface          — prints report, exits 0
 *   npm run test:surface --strict — exits 1 if any untested exports found
 *
 * Philosophy: this is not a replacement for line/branch coverage (use
 * `npm run test:coverage` for that). It is an explicit "did we forget to
 * write a test for this export?" guard that stays readable as the codebase
 * grows.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";

// ── Config ───────────────────────────────────────────────────────────────────

const ROOT = new URL("..", import.meta.url).pathname;
const CLI_DIR = join(ROOT, "cli");
const TEST_DIRS = [
  join(ROOT, "test", "unit"),
  join(ROOT, "test", "integration"),
  join(ROOT, "test", "e2e"),
];

/**
 * Exports that are intentionally untested at this level.
 * Typically: pure wiring, type aliases, re-exports.
 * Format: "filename:exportName" (filename without path or extension)
 */
const KNOWN_GAPS: Set<string> = new Set([
  // Phase types used in type annotations only
  "state:Phase",
  "state:RunStatus",
  "state:GateStatus",
  "state:WizardRun",
  "state:FlywheelRun",
  "state:PhaseEvent",
  "state:BeadSnapshot",
  "state:ApiCall",
  "state:SCHEMA",
  // Config type exports (tested via loadSshConfig etc., not directly)
  "config:SshConfig",
  "config:ProviderSlot",
  "config:ModelPricing",
  "config:ProvidersConfig",
  "config:Prompt",
  "config:PromptsConfig",
  // NTM bridge type exports
  "ntm-bridge:AgentStatus",
  "ntm-bridge:NtmSession",
  "ntm-bridge:NtmSpawnOptions",
  "ntm-bridge:NtmSpawnResult",
  "ntm-bridge:NtmSendResult",
  "ntm-bridge:NtmPauseResult",
  // Remote type exports
  "remote:RemoteCommandErrorCode",
  "remote:RunRemoteOptions",
  "remote:StreamRemoteOptions",
  "remote:RemoteCommandResult",
  // SSH type exports
  "ssh:SSHConfig",
  "ssh:ExecOptions",
  "ssh:ExecResult",
  "ssh:StreamOptions",
  "ssh:DEFAULT_SSH_PORT",
  "ssh:DEFAULT_SSH_TIMEOUT_MS",
  // Wizard type exports
  "wizard:WizardOptions",
  "wizard:WizardResult",
  "wizard:WizardRunner",
  // Review type exports
  "review:REVIEW_PASSES",
  "review:ReviewPass",
  "review:RunReviewOptions",
  "review:ReviewDispatch",
  "review:RunReviewResult",
  // Swarm type exports
  "swarm:StartSwarmOptions",
  "swarm:StartSwarmResult",
  "swarm:ResumeSwarmOptions",
  "swarm:SwarmStatusOptions",
  "swarm:SwarmStatus",
  // Deploy type exports
  "deploy:DeployOptions",
  "deploy:DeployResult",
  // Beads type exports
  "beads:BeadTriageOptions",
  "beads:BeadHistoryOptions",
  // Runs type exports
  "runs:ReplayOptions",
  // Gate type exports
  "gate:gateStatus",      // tested in gate-integration but as process output
  // Server type exports (complex class, tested indirectly via HTTP/WS tests)
  "server:FlywheelServer",
  // Init type exports
  "init:runInit",         // needs VPS; error path tested in local e2e
  "init:InitOptions",     // type-only
  // Monitor type exports
  "monitor:MonitorOptions",
  "monitor:runMonitor",   // tested via subprocess in local-commands.e2e.ts
  // Autopilot type exports
  "autopilot:AutopilotOptions",
  "autopilot:runAutopilot", // tested via subprocess in local-commands.e2e.ts
  // Settings type exports
  "settings:ConfigureSshSettingsResult",
  "settings:configureSshSettings", // tested via subprocess in integration tests
  // Prompts display exports — tested via subprocess in cli-prompts.test.ts
  "prompts:PromptModel",
  "prompts:PromptEffort",
  "prompts:PromptPhase",
  "prompts:PromptLibrary",
  "prompts:printPromptList",  // tested via subprocess: flywheel prompts list
  "prompts:printPrompt",      // tested via subprocess: flywheel prompts send
  "prompts:SendPromptResult",
  "prompts:sendPrompt",       // tested via subprocess
  // Beads commands — tested via subprocess in cli-beads-workspace.integration.test.ts
  "beads:runBeadTriage",
  "beads:runBeadHistory",
  "beads:runBeadGenerate",
  "beads:runBeadRefine",
  // Runs display — tested via subprocess in cli-runs-replay.test.ts
  "runs:listRuns",
  "runs:replayRun",
  // Deploy coordinator — tested in deploy-coordinator.test.ts
  "deploy:DeployCoordinator",
  // SSH helpers
  "ssh:getDefaultSSHConfigPath",
  // Config helpers — used by ssh.ts, state.ts, doctor.ts but not directly imported in tests
  "config:flywheelPath",
  "config:defaultStateDbPath",
  "config:formatPathForDisplay",
  // Rollback options type
  "rollback:RollbackOptions",
  // Wizard — tested via pure functions; runWizard needs real API keys
  "wizard:runWizard",
  // NTM error class — tested via RemoteCommandError which wraps it
  "ntm-bridge:NtmBridgeError",
]);

// ── Extract exports ───────────────────────────────────────────────────────────

interface Export {
  file: string;      // basename without .ts
  name: string;
  key: string;       // "file:name"
}

function extractExports(filePath: string): Export[] {
  const src = readFileSync(filePath, "utf8");
  const file = basename(filePath, ".ts");
  const exports: Export[] = [];

  // Match: export function/class/const/let/var/interface/type/enum <Name>
  const re = /^export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    exports.push({ file, name, key: `${file}:${name}` });
  }

  // Also match: export { foo, bar } re-exports and named exports
  const reExport = /^export\s*\{([^}]+)\}/gm;
  while ((m = reExport.exec(src)) !== null) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && /^\w+$/.test(name)) {
        exports.push({ file, name, key: `${file}:${name}` });
      }
    }
  }

  return exports;
}

// ── Load test content ─────────────────────────────────────────────────────────

function loadTestContent(): string {
  const parts: string[] = [];
  for (const dir of TEST_DIRS) {
    try {
      const files = readdirSync(dir, { recursive: true }) as string[];
      for (const f of files) {
        if (f.endsWith(".ts") || f.endsWith(".js")) {
          try {
            parts.push(readFileSync(join(dir, f), "utf8"));
          } catch {
            // skip unreadable
          }
        }
      }
    } catch {
      // dir may not exist
    }
  }
  return parts.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const strict = process.argv.includes("--strict");

  // Collect all CLI exports
  const cliFiles = readdirSync(CLI_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort();

  const allExports: Export[] = [];
  for (const f of cliFiles) {
    allExports.push(...extractExports(join(CLI_DIR, f)));
  }

  // Deduplicate (re-exports can appear twice)
  const seen = new Set<string>();
  const unique = allExports.filter((e) => {
    if (seen.has(e.key)) return false;
    seen.add(e.key);
    return true;
  });

  // Load all test content for lookup
  const testContent = loadTestContent();

  // Categorise
  const covered: Export[] = [];
  const knownGap: Export[] = [];
  const uncovered: Export[] = [];

  for (const exp of unique) {
    if (KNOWN_GAPS.has(exp.key)) {
      knownGap.push(exp);
    } else if (testContent.includes(exp.name)) {
      covered.push(exp);
    } else {
      uncovered.push(exp);
    }
  }

  // ── Report ──────────────────────────────────────────────────────────────────

  const total = unique.length;
  const coveredPct = total > 0 ? Math.round((covered.length / total) * 100) : 0;

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  CLI Export Surface Coverage Report                  ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log();
  console.log(`  Total exports:   ${total}`);
  console.log(`  Covered:         ${covered.length} (${coveredPct}%)`);
  console.log(`  Known gaps:      ${knownGap.length} (type aliases, wiring, VPS-only)`);
  console.log(`  Uncovered:       ${uncovered.length}`);
  console.log();

  if (uncovered.length > 0) {
    console.log("  ⚠  Uncovered exports (not referenced in any test file):");
    console.log("  ─────────────────────────────────────────────────────");
    const byFile: Record<string, string[]> = {};
    for (const e of uncovered) {
      (byFile[e.file] ??= []).push(e.name);
    }
    for (const [file, names] of Object.entries(byFile).sort()) {
      console.log(`  cli/${file}.ts`);
      for (const n of names) {
        console.log(`    - ${n}`);
      }
    }
    console.log();
  } else {
    console.log("  ✓ All non-gap exports are referenced in at least one test file.");
    console.log();
  }

  if (knownGap.length > 0) {
    console.log("  ℹ  Known gaps (type aliases, wiring, VPS-only — intentionally excluded):");
    const byFile: Record<string, string[]> = {};
    for (const e of knownGap) {
      (byFile[e.file] ??= []).push(e.name);
    }
    for (const [file, names] of Object.entries(byFile).sort()) {
      console.log(`     cli/${file}.ts: ${names.join(", ")}`);
    }
    console.log();
  }

  const exitCode = strict && uncovered.length > 0 ? 1 : 0;
  if (exitCode !== 0) {
    console.log(`  ✗ Strict mode: ${uncovered.length} uncovered export(s) found.`);
    console.log("    Add tests or add to KNOWN_GAPS in scripts/coverage-surface.ts");
    console.log();
  }

  process.exit(exitCode);
}

main();
