// flywheel doctor — full local diagnostic: config files, SQLite, SSH connectivity
// Bead: 3dw #4 (flywheel doctor, 10-second diagnostics)

import { existsSync } from "node:fs";
import chalk from "chalk";
import { loadSSHConfig, SSHManager, getDefaultSSHConfigPath } from "./ssh.js";
import {
  defaultStateDbPath,
  flywheelDir,
  flywheelPath,
  formatPathForDisplay,
  loadProvidersConfig,
} from "./config.js";
import { loadPrompts } from "./prompts.js";
import { initDb, StateManager } from "./state.js";

export interface Check {
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export interface Recommendation {
  severity: "warn" | "fail";
  text: string;
}

export function ok(label: string, detail: string): Check {
  return { label, status: "ok", detail };
}
export function warn(label: string, detail: string): Check {
  return { label, status: "warn", detail };
}
export function fail(label: string, detail: string): Check {
  return { label, status: "fail", detail };
}

export function render(checks: Check[]): void {
  const labelWidth = Math.max(32, ...checks.map((check) => check.label.length));
  for (const c of checks) {
    let icon: string;
    if (c.status === "ok") {
      icon = chalk.green("✓");
    } else if (c.status === "warn") {
      icon = chalk.yellow("⚠");
    } else {
      icon = chalk.red("✗");
    }
    const label = c.label.padEnd(labelWidth);
    console.log(`  ${icon} ${label} ${chalk.dim(c.detail)}`);
  }
}

export function collectRecommendations(checks: Check[]): Recommendation[] {
  const recommendations: Recommendation[] = [];
  const has = (label: string, status?: Check["status"]) =>
    checks.some(
      (check) =>
        (check.label === label || check.label.startsWith(`${label} `)) &&
        (status ? check.status === status : true)
    );

  if (has("ssh.yaml", "fail")) {
    recommendations.push({
      severity: "fail",
      text: 'Run `flywheel settings ssh` and confirm the configured private key exists on this machine.',
    });
  }

  if (has("SSH connectivity", "fail")) {
    recommendations.push({
      severity: "fail",
      text: "Verify VPN/network access to the VPS, then run `flywheel ssh test` for a direct connection probe.",
    });
  }

  if (has("providers.yaml", "warn") || has("providers.yaml", "fail")) {
    const providersPath = formatPathForDisplay(flywheelPath("providers.yaml"));
    recommendations.push({
      severity: has("providers.yaml", "fail") ? "fail" : "warn",
      text: `Copy \`config/providers.example.yaml\` to \`${providersPath}\`, fill in keys, then \`chmod 600 ${providersPath}\`.`,
    });
  }

  if (has("prompts.yaml", "fail")) {
    recommendations.push({
      severity: "fail",
      text: "Ensure you are running a complete build or repository checkout so `config/prompts.yaml` is available.",
    });
  }

  if (has("SQLite", "fail")) {
    const flywheelHome = formatPathForDisplay(flywheelDir());
    const stateDbPath = formatPathForDisplay(defaultStateDbPath());
    recommendations.push({
      severity: "fail",
      text: `Check permissions on \`${flywheelHome}\` and \`${stateDbPath}\`; the CLI needs read/write access.`,
    });
  }

  return recommendations;
}

// ── Section: Config files ─────────────────────────────────────────────────────

function checkConfigs(): Check[] {
  const checks: Check[] = [];
  const sshConfigPath = getDefaultSSHConfigPath();
  const providersPath = flywheelPath("providers.yaml");

  // ssh.yaml
  try {
    loadSSHConfig();
    checks.push(ok("ssh.yaml", "loaded + key file readable"));
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    if (!existsSync(sshConfigPath)) {
      checks.push(fail("ssh.yaml", "not found — run: flywheel settings ssh"));
    } else {
      checks.push(fail("ssh.yaml", msg));
    }
  }

  // providers.yaml
  try {
    const providers = loadProvidersConfig();
    const slotCount = Object.values(providers.slots).reduce((count, slots) => {
      return count + (Array.isArray(slots) ? slots.length : 0);
    }, 0);
    checks.push(ok("providers.yaml", `${slotCount} model slot(s) configured`));
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    if (!existsSync(providersPath)) {
      checks.push(
        warn("providers.yaml", "not found — planning wizard will not work")
      );
    } else {
      checks.push(fail("providers.yaml", msg));
    }
  }

  // prompts.yaml
  try {
    const prompts = loadPrompts();
    const count = Object.keys(prompts).length;
    checks.push(ok("prompts.yaml", `${count} prompts loaded`));
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    checks.push(fail("prompts.yaml", msg));
  }

  return checks;
}

// ── Section: SQLite state ─────────────────────────────────────────────────────

function checkSqlite(): Check[] {
  const label = `SQLite (${formatPathForDisplay(defaultStateDbPath())})`;
  try {
    const db = initDb();
    const sm = new StateManager(db);
    const runs = sm.listFlywheelRuns();
    const wizardRuns = sm.listWizardRuns();
    return [ok(label, `${runs.length} flywheel run(s), ${wizardRuns.length} wizard run(s)`)];
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    return [fail(label, msg)];
  }
}

// ── Section: SSH connectivity ─────────────────────────────────────────────────

async function checkSsh(): Promise<Check[]> {
  // If ssh.yaml is missing, skip the connection attempt (already reported above)
  const sshYamlPath = getDefaultSSHConfigPath();
  if (!existsSync(sshYamlPath)) {
    return [warn("SSH connectivity", "skipped (no ssh.yaml)")];
  }

  const manager = new SSHManager();
  try {
    const config = await manager.connect();
    const latencyMs = await manager.getLatency();
    return [
      ok(
        "SSH connectivity",
        `${config.user}@${config.host}:${config.port} — ${latencyMs}ms`
      ),
    ];
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    return [fail("SSH connectivity", msg)];
  } finally {
    manager.disconnect();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function runDoctor(): Promise<void> {
  console.log(chalk.bold("\nFlywheel Doctor\n"));
  console.log(
    chalk.dim("Checks the local control plane only: config files, state DB, and laptop→VPS connectivity.\n")
  );

  const configChecks = checkConfigs();
  console.log(chalk.bold("Config files:"));
  render(configChecks);

  const sqliteChecks = checkSqlite();
  console.log(chalk.bold("\nState database:"));
  render(sqliteChecks);

  console.log(chalk.bold("\nSSH connectivity:"));
  const sshChecks = await checkSsh();
  render(sshChecks);

  const allChecks = [...configChecks, ...sqliteChecks, ...sshChecks];
  const failures = allChecks.filter((c) => c.status === "fail").length;
  const warnings = allChecks.filter((c) => c.status === "warn").length;
  const recommendations = collectRecommendations(allChecks);

  console.log();
  let exitCode = 0;
  if (failures > 0) {
    console.log(
      chalk.red(`✗ ${failures} failure(s)`) +
      (warnings > 0 ? chalk.yellow(`, ${warnings} warning(s)`) : "")
    );
    exitCode = 1;
  } else if (warnings > 0) {
    console.log(chalk.yellow(`⚠ ${warnings} warning(s) — flywheel is partially configured`));
  } else {
    console.log(chalk.green("✓ All checks passed — flywheel is ready"));
  }

  if (recommendations.length > 0) {
    console.log(chalk.bold("\nRecommended next steps:"));
    for (const recommendation of recommendations) {
      const icon = recommendation.severity === "fail" ? chalk.red("•") : chalk.yellow("•");
      console.log(`  ${icon} ${recommendation.text}`);
    }
  } else {
    console.log(chalk.dim('\nNext: flywheel new "<your idea>" to start the planning wizard.'));
  }
  console.log();

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
