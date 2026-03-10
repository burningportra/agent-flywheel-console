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

<!-- bv-agent-instructions-v1 -->

---

## Beads Workflow Integration

This project uses [beads_viewer](https://github.com/Dicklesworthstone/beads_viewer) for issue tracking. Issues are stored in `.beads/` and tracked in git.

### Essential Commands

```bash
# View issues (launches TUI - avoid in automated sessions)
bv

# CLI commands for agents (use these instead)
bd ready              # Show issues ready to work (no blockers)
bd list --status=open # All open issues
bd show <id>          # Full issue details with dependencies
bd create --title="..." --type=task --priority=2
bd update <id> --status=in_progress
bd close <id> --reason="Completed"
bd close <id1> <id2>  # Close multiple issues at once
bd sync               # Commit and push changes
```

### Workflow Pattern

1. **Start**: Run `bd ready` to find actionable work
2. **Claim**: Use `bd update <id> --status=in_progress`
3. **Work**: Implement the task
4. **Complete**: Use `bd close <id>`
5. **Sync**: Always run `bd sync` at session end

### Key Concepts

- **Dependencies**: Issues can block other issues. `bd ready` shows only unblocked work.
- **Priority**: P0=critical, P1=high, P2=medium, P3=low, P4=backlog (use numbers, not words)
- **Types**: task, bug, feature, epic, question, docs
- **Blocking**: `bd dep add <issue> <depends-on>` to add dependencies

### Session Protocol

**Before ending any session, run this checklist:**

```bash
git status              # Check what changed
git add <files>         # Stage code changes
bd sync                 # Commit beads changes
git commit -m "..."     # Commit code
bd sync                 # Commit any new beads changes
git push                # Push to remote
```

### Best Practices

- Check `bd ready` at session start to find available work
- Update status as you work (in_progress → closed)
- Create new issues with `bd create` when you discover tasks
- Use descriptive titles and set appropriate priority/type
- Always `bd sync` before ending session

<!-- end-bv-agent-instructions -->
