# Agent Flywheel Console

## What This Is

A local control plane (CLI + Vite dashboard) that orchestrates the full agentic coding flywheel on a remote ACFS VPS over SSH. The console never runs agents — it orchestrates NTM which runs agents.

## Architecture

```
flywheel CLI (laptop) ←→ SSH ←→ VPS (ntm, br, bv, agent-mail, agents)
flywheel server (localhost:4200) ←→ WebSocket ←→ dashboard (browser)
```

## Core Principles

1. Console never runs agents locally — cockpit, not engine
2. NTM is the execution layer — orchestrate, never bypass
3. Every prompt has model + effort metadata — all in prompts.yaml
4. Human gates between phases by default — autopilot is opt-in
5. No human code edits during swarm — agents own the code
6. Commit agent runs continuously with strict safety constraints

## Key Files

- `cli/index.ts` — CLI entry point (commander.js)
- `cli/ssh.ts` — SSH connection manager
- `cli/ntm-bridge.ts` — NTM command wrapper
- `cli/state.ts` — SQLite state machine (7 tables)
- `cli/server.ts` — Local HTTP + WebSocket server
- `config/prompts.yaml` — 25+ workflow prompts with metadata
- `config/ssh.example.yaml` — SSH config template
- `config/providers.example.yaml` — Model keys + CAAM slots template
- `docs/pitch.md` — Full Shape Up pitch document

## Agent Rules

- ONLY edit files relevant to your assigned issue
- NO new dependencies without explicit approval
- ANY change beyond the issue scope = REJECTED
- Always include `Closes #N` in PR body
- Run `flywheel preflight` before touching SSH-related code
- Test against the SQLite schema in `cli/state.ts`

## Tech Stack

- Node.js + TypeScript (strict) + commander.js
- SQLite (better-sqlite3, synchronous, no ORM)
- node-ssh for VPS connection
- Vite + React + Tailwind for dashboard
- Anthropic/OpenAI/Google SDKs for model calls
