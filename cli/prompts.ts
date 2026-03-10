// Prompt Engine — load, route, and inject prompts from prompts.yaml
// Bead: agent-flywheel-console-2jf

import { basename } from 'node:path';
import chalk from 'chalk';
import { loadPromptsConfig } from './config.js';
import { NtmBridge } from './ntm-bridge.js';
import { RemoteCommandRunner } from './remote.js';
import { SSHManager } from './ssh.js';

export type PromptModel = 'opus' | 'sonnet' | 'haiku' | 'any';
export type PromptEffort = 'low' | 'high' | 'max';
export type PromptPhase = 'plan' | 'beads' | 'swarm' | 'review';

export interface Prompt {
  text: string;
  model: PromptModel;
  effort: PromptEffort;
  phase: PromptPhase;
}

export type PromptLibrary = Record<string, Prompt>;

let _cache: PromptLibrary | null = null;

export function loadPrompts(): PromptLibrary {
  if (_cache) return _cache;
  _cache = loadPromptsConfig().prompts as PromptLibrary;
  return _cache;
}

export function getPrompt(name: string): Prompt | undefined {
  return loadPrompts()[name];
}

/** Replace {variable} placeholders. Unresolved vars are left as-is. */
export function substituteVariables(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (_match, key) => vars[key] ?? `{${key}}`);
}

/** Parse "key=value" strings into a Record. */
export function parseVarArgs(varArgs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of varArgs) {
    const eq = arg.indexOf('=');
    if (eq === -1) {
      console.warn(chalk.yellow(`Warning: --var "${arg}" has no "=" — skipping`));
      continue;
    }
    out[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  return out;
}

// ── Display helpers ──────────────────────────────────────────────────────────

const EFFORT_BADGE: Record<string, string> = {
  low: chalk.green('low'),
  high: chalk.yellow('high'),
  max: chalk.red('max'),
};

const PHASE_HEADER: Record<string, string> = {
  plan: chalk.blue.bold('Plan'),
  beads: chalk.cyan.bold('Beads'),
  swarm: chalk.magenta.bold('Swarm'),
  review: chalk.yellow.bold('Review'),
};

const PHASE_ORDER = ['plan', 'beads', 'swarm', 'review'] as const;

export function printPromptList(): void {
  const prompts = loadPrompts();

  // Group by phase
  const byPhase = new Map<string, [string, Prompt][]>();
  for (const phase of PHASE_ORDER) byPhase.set(phase, []);

  for (const [name, prompt] of Object.entries(prompts)) {
    const group = byPhase.get(prompt.phase) ?? [];
    group.push([name, prompt]);
    byPhase.set(prompt.phase, group);
  }

  let total = 0;
  for (const phase of PHASE_ORDER) {
    const group = byPhase.get(phase)!;
    if (group.length === 0) continue;
    total += group.length;

    console.log(`\n${PHASE_HEADER[phase]} ${chalk.dim(`(${group.length})`)}`);
    for (const [name, prompt] of group) {
      const effort = EFFORT_BADGE[prompt.effort] ?? prompt.effort;
      const model = chalk.dim(prompt.model);
      const firstLine = prompt.text.trim().split('\n')[0];
      const preview = firstLine.length > 72 ? firstLine.slice(0, 72) + '…' : firstLine;
      console.log(`  ${chalk.bold(name.padEnd(30))} [${effort}] [${model}]`);
      console.log(`    ${chalk.dim(preview)}`);
    }
  }

  console.log(chalk.dim(`\n${total} prompts total · send with: flywheel prompts send <name>`));
}

export function printPrompt(
  name: string,
  vars: Record<string, string> = {},
  opts: { agent?: string; all?: boolean } = {},
): boolean {
  const prompt = getPrompt(name);
  if (!prompt) {
    console.error(chalk.red(`Error: prompt "${name}" not found.`));
    console.error(chalk.dim('Run `flywheel prompts list` to see available prompts.'));
    return false;
  }

  const resolved = substituteVariables(prompt.text, vars);
  const unresolvedVars = [...resolved.matchAll(/\{(\w+)\}/g)].map(m => m[1]);

  console.log(`\n${chalk.bold('Prompt:')} ${name}`);
  console.log(chalk.dim(`Phase: ${prompt.phase} | Model: ${prompt.model} | Effort: ${prompt.effort}`));

  if (unresolvedVars.length > 0) {
    console.log(chalk.yellow(`\nUnresolved variables: ${unresolvedVars.map(v => `{${v}}`).join(', ')}`));
    console.log(chalk.dim('Supply them with --var key=value'));
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(resolved.trimEnd());
  console.log('─'.repeat(60));

  if (opts.agent) {
    console.log(chalk.dim(`\nTarget: pane ${opts.agent} (delivery via SSH → NTM)`));
  } else if (opts.all) {
    console.log(chalk.dim("\nTarget: all non-user panes (delivery via SSH → NTM)"));
  } else {
    console.log(chalk.dim('\nTip: add --agent <pane-id> or --all to inject via SSH'));
  }

  return true;
}

export interface SendPromptResult {
  sessionName: string;
  panes: number[];
  prompt: Prompt;
}

export async function sendPrompt(
  name: string,
  vars: Record<string, string> = {},
  opts: { pane?: number; all?: boolean; sessionName?: string } = {},
): Promise<SendPromptResult> {
  const prompt = getPrompt(name);
  if (!prompt) {
    throw new Error(`Prompt "${name}" not found.`);
  }

  if (opts.all && typeof opts.pane === 'number') {
    throw new Error('Use either --agent or --all, not both.');
  }

  const resolved = substituteVariables(prompt.text, vars);
  const unresolvedVars = [...resolved.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  if (unresolvedVars.length > 0) {
    throw new Error(
      `Prompt "${name}" still has unresolved variables: ${unresolvedVars.map((v) => `{${v}}`).join(', ')}`
    );
  }

  const sessionName = opts.sessionName ?? defaultSessionName();
  const manager = new SSHManager();
  const remote = new RemoteCommandRunner(manager);
  const ntm = new NtmBridge(remote);

  try {
    await manager.connect();

    const panes = opts.all
      ? await discoverAgentPanes(ntm, sessionName)
      : [opts.pane ?? failMissingTarget()];

    for (const pane of panes) {
      await ntm.send(sessionName, pane, resolved.trim());
    }

    return { sessionName, panes, prompt };
  } finally {
    manager.disconnect();
  }
}

async function discoverAgentPanes(ntm: NtmBridge, sessionName: string): Promise<number[]> {
  const agents = await ntm.activity(sessionName);
  const panes = [...new Set(
    agents
      .filter((agent) => agent.type !== 'user')
      .map((agent) => agent.pane)
  )];

  if (panes.length === 0) {
    throw new Error(`No non-user panes found in session "${sessionName}".`);
  }

  return panes;
}

function defaultSessionName(): string {
  return basename(process.cwd())
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function failMissingTarget(): never {
  throw new Error('No target provided. Use --agent <pane> or --all to send a prompt.');
}
