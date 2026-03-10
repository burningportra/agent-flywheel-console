// flywheel providers — show model slot usage + rotation state
// Reads providers.yaml and displays configured models without exposing API keys.

import chalk from "chalk";
import { loadProvidersConfig, type ProviderSlot } from "./config.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function modelColor(model: string): string {
  if (model.startsWith("claude-")) return chalk.blue(model);
  if (model.startsWith("gemini-")) return chalk.green(model);
  if (model.startsWith("gpt-")) return chalk.yellow(model);
  return chalk.white(model);
}

function renderSlots(slots: ProviderSlot[], label: string): void {
  console.log(chalk.bold(`\n${label}`));
  if (slots.length === 0) {
    console.log(chalk.gray("  (none configured)"));
    return;
  }
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const concurrency =
      s.max_concurrent !== undefined
        ? chalk.dim(` max_concurrent=${s.max_concurrent}`)
        : "";
    const credentialState = s.key.trim().length > 0 ? "configured" : "missing";
    console.log(
      `  [${i}] ${modelColor(s.model)}  credential:${chalk.dim(credentialState)}${concurrency}`
    );
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function printProviders(): void {
  let config;
  try {
    config = loadProvidersConfig();
  } catch (e) {
    console.error(chalk.red(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }

  console.log(chalk.bold("Provider slots"));

  const slotOrder = ["plan", "synthesis", "swarm", "commit_slot"];
  const slotLabels: Record<string, string> = {
    plan: "Plan (fan-out)",
    synthesis: "Synthesis",
    swarm: "Swarm agents",
    commit_slot: "Commit agent",
  };

  for (const key of slotOrder) {
    const slots = config.slots[key] ?? [];
    renderSlots(slots, slotLabels[key] ?? key);
  }

  // Any extra slots not in the canonical order
  for (const [key, slots] of Object.entries(config.slots)) {
    if (!slotOrder.includes(key)) {
      renderSlots(slots ?? [], key);
    }
  }

  console.log(chalk.bold("\nRotation policy:"), config.rotation);

  console.log(chalk.bold("\nPricing (per million units):"));
  const pricingEntries = Object.entries(config.pricing);
  if (pricingEntries.length === 0) {
    console.log(chalk.gray("  (none configured)"));
  } else {
    for (const [model, p] of pricingEntries) {
      console.log(
        `  ${modelColor(model.padEnd(38))} in: $${p.input_per_mtok.toFixed(2)} / out: $${p.output_per_mtok.toFixed(2)}`
      );
    }
  }

  console.log();
}
