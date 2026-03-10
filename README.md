# Agent Flywheel Console

A local control plane (CLI + Vite dashboard) that orchestrates the full agentic coding flywheel on a remote ACFS VPS over SSH. The console never runs agents — it orchestrates NTM which runs agents.

## What It Does

Takes a raw idea and automates the full development lifecycle:

```
Plan → Beads → Swarm → Review → Deploy
```

- **Plan**: Multi-model Planning Wizard (parallel fan-out across Opus + GPT + Gemini, then synthesis)
- **Beads**: Issue tracking via `br`/`bv` with dependency graphs, PageRank scoring, and velocity ETA
- **Swarm**: Spawn N coding agents via NTM with auto-commit agent, stuck-agent nudging, budget caps
- **Review**: 8 named review passes (fresh-review, peer-review, UI/UX scrutiny, UBS scan, test coverage, ORM audit, TanStack optimize, DCG safety)
- **Deploy**: Final commit + GitHub flow + checksums + CM reflect (requires typing `DEPLOY <project-name>`)

## Architecture

```
flywheel CLI (laptop) ←→ SSH ←→ VPS (ntm, br, bv, agent-mail, agents)
flywheel server (localhost:4200) ←→ WebSocket ←→ dashboard (browser)
```

The console is a **cockpit**, not an engine. All agent execution happens on the VPS. The SSH layer is the only wire between the two.

## Core Principles

1. **Console never runs agents locally** — cockpit, not engine
2. **NTM is the execution layer** — orchestrate, never bypass
3. **Every prompt has model + effort metadata** — all in `prompts.yaml`
4. **Human gates between phases by default** — autopilot is opt-in
5. **No human code edits during swarm** — agents own the code
6. **Commit agent runs continuously** with strict safety constraints

## Project Structure

```
cli/
├── index.ts          # CLI entry point (commander.js)
├── ssh.ts            # SSH connection manager (node-ssh, single persistent connection)
├── ntm-bridge.ts     # NTM command wrapper (spawn, send, activity, pause, resume, list)
├── state.ts          # SQLite state machine (7 tables, better-sqlite3, synchronous)
└── server.ts         # Local HTTP + WebSocket server for dashboard
config/
├── prompts.yaml          # 25+ workflow prompts with model/effort/phase metadata
├── ssh.example.yaml      # SSH config template
└── providers.example.yaml # Model keys + CAAM slots template
docs/
└── pitch.md              # Full Shape Up pitch document (v10)
```

## Tech Stack

- **Runtime**: Node.js 20+ with TypeScript (strict mode)
- **CLI**: commander.js
- **Build**: esbuild (single-file bundle) + tsx (dev mode)
- **Database**: SQLite via better-sqlite3 (synchronous, no ORM, raw SQL with typed wrappers)
- **SSH**: node-ssh (single persistent connection, no auto-reconnect in v1)
- **Dashboard**: Vite + React + Tailwind (localhost:4200)
- **AI SDKs**: Anthropic, OpenAI, Google (for Planning Wizard fan-out)

## SQLite Schema (7 Tables)

| Table | Purpose |
|-------|---------|
| `wizard_runs` | Planning wizard sessions |
| `flywheel_runs` | Per-project phase tracking + checkpoint SHA |
| `ssh_connections` | Latency tracking + audit |
| `prompt_sends` | Prompt injection audit trail |
| `phase_events` | Append-only event log (source of truth for debugging/replay) |
| `bead_snapshots` | Periodic bead state for velocity calc + time-travel |
| `api_calls` | Per-API-call cost log for budget tracking |

## CLI Commands

```bash
# Setup
flywheel settings ssh          # Configure VPS SSH connection
flywheel ssh test              # Test connection + measure latency
flywheel preflight             # Verify remote tools on VPS
flywheel doctor                # Full diagnostic

# Workflow
flywheel new "my idea"         # Run Planning Wizard
flywheel beads generate        # Generate beads from plan
flywheel beads triage          # Triage + prioritize beads
flywheel swarm 6               # Spawn 6 agents (includes commit agent)
flywheel review                # Run 8 review passes
flywheel deploy                # Final deploy (requires confirmation)

# Monitoring
flywheel monitor               # Terminal-mode live view
flywheel serve                 # Start Vite dashboard at localhost:4200
flywheel runs                  # List past runs
flywheel replay <run-id>       # Render events as narrative
```

## Development

```bash
npm install
npm run dev -- --help          # Run CLI in dev mode
npm run build                  # Bundle to dist/cli.js
npm run typecheck              # Type check without emit
```

## Testing

No-mock default: tests use real SQLite, real process spawning, real HTTP/WebSocket. See `docs/testing-policy.md`.

```bash
npm test                       # Full suite (unit + contract + integration + local e2e)
npm run test:unit              # Unit tests only (fast, no I/O)
npm run test:integration       # Integration tests (real processes, temp dirs, no VPS)
npm run test:e2e:local         # Local e2e tests (real binary, no VPS)
npm run test:coverage          # Full suite with coverage report
FLYWHEEL_TEST_E2E=1 npm run test:e2e  # VPS e2e (requires ssh.yaml configured)
```

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs these stages on every push/PR:

| Stage | What | Trigger |
|-------|------|---------|
| Type-check & Build | `tsc --noEmit` + esbuild + vite | Always |
| Unit Tests | `test/unit/**` with coverage | Always |
| Contract Tests | `test/contract/**` (HTTP/WS shape) | Always |
| Integration Tests | `test/integration/**` (real processes) | Always |
| E2E Local | `test/e2e/local-commands.e2e.ts` | Always |
| E2E VPS | Full VPS orchestration | Push to `main` + `FLYWHEEL_VPS_HOST` set |
| Coverage Gate | Merged coverage thresholds (vitest.config.ts) | Always |

To enable VPS E2E in CI, set these in repository Settings → Variables/Secrets:
- `FLYWHEEL_VPS_HOST` — VPS IP or hostname
- `FLYWHEEL_VPS_USER` — SSH user (default: `ubuntu`)
- `FLYWHEEL_REMOTE_REPO_ROOT` — remote path prefix (default: `/home/ubuntu/projects`)
- `FLYWHEEL_SSH_KEY` — private key contents (secret)

## Source Location

The canonical source lives at: `/home/ubuntu/.openclaw/workspace/agent-flywheel-console/`

Beads are tracked in `.beads/` in that directory. Use `br` (beads_rust) for CLI bead management and `bv` (beads_viewer) for the TUI.

## License

MIT
