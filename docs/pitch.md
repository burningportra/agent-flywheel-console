# Agent Flywheel Console — Shaped Pitch (v10 — Final)

**Format:** Shape Up pitch (Basecamp methodology)
**Date:** March 2026
**Appetite:** 6 weeks (solo developer + flywheel swarm against this repo)
**Status:** Ready to bet
**Distribution:** Published to npm as `agent-flywheel-console`

---

## TL;DR

Build a local control plane — a CLI + Vite dashboard — that lets you orchestrate and monitor the full agentic coding flywheel (Plan → Beads → Swarm → Review → Deploy) on a single remote ACFS VPS over SSH, from your laptop, in one place. The console never runs agents — it orchestrates NTM which runs agents. The highest-leverage new piece is the **Phase 1 Planning Wizard**: a parallel multi-model idea-to-plan automation with synthesis. The SSH layer is the foundation. The dashboard is the monitoring glass. The prompt library is the playbook. These four things together are the product.

---

## The Problem

Running the flywheel right now requires:

- Manually SSHing into the VPS and running `ntm`, `br`, `bv`, `agent-mail` commands by hand
- Keeping a mental model of which phase you're in, which beads are blocked, and what each agent is doing
- Doing Phase 1 (planning) as an entirely separate, manual multi-tab conversation ritual
- No persistent local record of runs, phases, or decisions
- No safety net when you disconnect from SSH mid-swarm
- No central prompt library — the 25+ workflow prompts live in docs, not tooling
- Subscription slot management (CAAM rotation across multiple Claude accounts) is manual

The ACFS VPS setup script makes the *environment* turnkey. What doesn't exist yet is a **control plane** that makes the *workflow* turnkey. Right now you are the orchestrator. You shouldn't have to be.

---

## Appetite

**6 weeks.** This is a firm time box, not an estimate. If it doesn't fit in 6 weeks, we cut scope — we don't extend the deadline. The flywheel itself can be used to accelerate implementation once the SSH layer and Phase 1 wizard are working.

Constraint: a solo developer running the flywheel swarm against this repo. Realistically 8–12 agents at peak across 2–3 Claude subscriptions, all on one VPS.

---

## The Core Bet

> "If we give the flywheel a proper cockpit, the compounding value of each agent-hour goes up dramatically because the human overhead between phases drops to near zero."

The current friction points aren't in the VPS tools themselves — `ntm`, `br`, `bv` are already excellent. The friction is in **transitions**: deciding when a phase is done, initiating the next one, and monitoring without babysitting. The console eliminates that friction.

---

## Core Principles

These are architectural invariants. Every design decision should be checked against them.

1. **The console never runs agents locally.** All agent execution happens on the VPS via SSH. The console is a cockpit, not an engine.

2. **NTM is the execution layer; we orchestrate NTM, not replace it.** `ntm spawn`, `ntm send`, `ntm activity` are the substrate. We wrap them, never bypass them.

3. **Every prompt has model + effort metadata.** No prompt is hardcoded. All 25+ prompts live in `prompts.yaml` with `model`, `effort`, and `phase` tags. This makes the prompt library editable, versionable, and diffable.

4. **Human gates between phases by default; autopilot is an opt-in flag.** `GATE` = the console pauses and waits for `flywheel gate advance`. Autopilot mode (`--autopilot`) skips gates and runs end-to-end unattended.

5. **No human code edits once agents are running.** Once `flywheel swarm` starts, the human's job is observation and gate decisions, not code. Agents own the code.

6. **Commit agents run continuously.** A dedicated commit agent fires every 15–20 minutes during swarm phase. This is not optional plumbing — it's a first-class agent role provisioned automatically by `flywheel swarm`. Safety constraints on the commit agent are non-negotiable: it may only `git add` already-tracked files and `git commit` + `git push` — it must never `rebase`, `merge`, `reset --hard`, run deploy steps, or touch untracked files. These constraints are injected into the commit agent's init prompt and are not configurable. **CAAM slot policy: the commit agent uses the dedicated `commit_slot` from `providers.yaml` by default; falls back to the swarm pool only if no `commit_slot` is configured.**

---

## The Shaped Solution

Four separable components that ship in dependency order:

```
[1] SSH Layer → [2] Phase 1 Wizard → [3] Prompt Engine → [4] Dashboard
 (connect & run) (plan automation) (library + routing) (monitor + act)
```

Each is independently useful. Shipping [1] without [2], [3], or [4] is still a win. But the full loop is the product.

### Repository Structure

```
flywheel/
├── cli/
│ ├── commands/ # One file per command (new.ts, swarm.ts, etc.)
│ ├── ssh.ts # SSH connection (single VPS, persistent)
│ ├── ntm-bridge.ts # NTM over SSH wrapper
│ ├── state.ts # SQLite state machine
│ └── server.ts # Local HTTP + WebSocket server for dashboard
├── config/
│ ├── ssh.yaml # VPS connection settings
│ ├── providers.yaml # Model keys + CAAM subscription slots
│ └── prompts.yaml # 25+ prompts with model/effort/phase metadata
├── dashboard/
│ └── src/
│ ├── PipelineView.tsx # Phase pipeline + gate controls
│ ├── BeadBoard.tsx # Kanban with PageRank scores + critical path
│ ├── AgentPanel.tsx # Per-agent status, mail traffic, file locks
│ ├── PromptLibrary.tsx # Browse + send prompts to agents
│ ├── ProviderSettings.tsx
│ ├── LogStream.tsx
│ └── MemoryPanel.tsx # cass/cm session memory browser
└── package.json
```

---

### Component 1 — SSH Layer (the foundation)

**What it does:** Authenticates to the VPS, verifies the environment, and runs remote commands with output piped back locally. Maintains one persistent SSH connection, reused across all commands.

**Key behaviors:**

- `flywheel settings ssh` → interactive prompt to set host, user, port, key path (stored in `~/.flywheel/ssh.yaml`)
- `flywheel ssh test` → connect, echo latency, return pass/fail
- `flywheel preflight` → verify `ntm`, `br`, `bv`, `gh`, `git`, `agent-mail`, `ubs`, `dcg` exist on the VPS — **hard-fails by default**; pass `--force` to warn and continue. Exit code contract:
  - `0` — all required checks passed
  - `2` — warnings present, continued with `--force`
  - `3` — required check failed, hard stop
- Remote command runner: wraps every remote call in timeout + exit-code capture + stderr/stdout split
- Log streaming: `tail -f` remote log files over SSH, piped to local stdout

**What it does NOT do:**

- It does not manage tmux sessions directly (that's `ntm`'s job)
- It does not recover broken SSH tunnels automatically (v1 fails loudly and tells you to reconnect)
- It does not implement a persistent SSH daemon or custom protocol — it's a thin wrapper around `node-ssh`

**Rabbit hole to avoid:** Do not build SSH session recovery in v1. The VPS keeps running autonomously whether or not your SSH session is alive. Fail loudly with a red indicator; the user reconnects manually with `flywheel ssh test`. This is fine.

---

### Component 2 — Phase 1 Planning Wizard (the highest-leverage piece)

**What it does:** Takes a raw idea and produces a final, synthesis-grade planning packet through a structured, automated multi-model conversation.

**The workflow:**

```
User types idea
 ↓
┌────────────────────────────────────────────────────────────┐
│ PARALLEL FAN-OUT (Promise.all — all three simultaneous)    │
│ Model A: Claude Opus │ Model B: GPT-4o │ Model C: Gemini  │
└────────────────────────────────────────────────────────────┘
 ↓ (wait for all three, stream each as it completes)
Synthesis pass 1 → Opus combines all three (diff-style revisions)
 ↓
Synthesis pass 2 → refinement of synthesis (catch oversights)
 ↓
Adversarial Challenge → stress-test the plan (risks & open questions)
 ↓
Brilliant ideas rounds × 3 ("100 ideas, show me 10 best")
 ↓
GATE → human reviews plan.md before proceeding to beads
 ↓
Final packet → plan.md + wizard-log.jsonl saved to project dir
```

**Model routing for Phase 1:**
- Competing plans: models assigned in `providers.yaml` under `[slots.plan]`
- Synthesis: always routed to the highest-tier model (Opus by default)
- Brilliant ideas: routed to synthesis model at `/effort max`

**Inputs:**
- Project name
- Freeform idea description (multi-line, no length limit)
- Model provider config (keys in `providers.yaml`, never in the plan packet or logs)

**Output:**
- `plan.md` — the final synthesis document
- `wizard-log.jsonl` — timestamped record of all model turns for debugging/auditability; **stored locally only by default**; pass `--push-artifacts` to also copy both files to the VPS project directory after wizard completion

**CLI interface:**

```bash
flywheel new "Build a habit tracker app with streak tracking and heatmap calendar"
flywheel new "idea" --models opus,gemini # override competing models
flywheel new "idea" --fast             # skip fan-out; still runs 1 synthesis pass + 1 ideas round
```

**`--fast` mode is still structured.** It skips the parallel fan-out (no competing models) but keeps one synthesis pass and one ideas round. Output is still `plan.md` + `wizard-log.jsonl`. It is not a raw single-shot prompt — the synthesis and ideas passes are what make the plan document useful, and they're cheap to run on a single model.

---

### Component 3 — Prompt Engine (the playbook)

**What it does:** Maintains the full 25+ prompt library as versioned YAML config, routes prompts to the right model/effort tier, and enables injection from CLI or dashboard to specific agents.

**prompts.yaml structure:**

```yaml
prompts:
  fresh-review:
    text: "Great, now I want you to carefully read over all of the new code..."
    model: any
    effort: high
    phase: review

  peer-review:
    text: "Ok can you now turn your attention to reviewing the code written..."
    model: opus
    effort: max
    phase: review

  generate-ideas:
    text: "OK so now I want you to come up with your top 10 most brilliant..."
    model: opus
    effort: max
    phase: plan

  commit-work:
    text: "Now, based on your knowledge of the project, commit all changed files..."
    model: any
    effort: high
    phase: swarm

  beads-generate-from-plan:
    text: |
      Read the plan at {plan_path} super carefully in full. Then create a comprehensive
      and granular set of beads for all of it with tasks, subtasks, and dependency
      structure overlaid, with detailed comments so the whole thing is totally
      self-contained and self-documenting. Use the `br` tool repeatedly to create
      the actual beads. Use /effort max.
    model: opus
    effort: max
    phase: beads

  beads-review-refine:
    text: |
      Check over each bead super carefully — are you sure it makes sense? Is it
      optimal? Could we change anything to make the system work better? If so,
      revise the beads. It's a lot easier and faster to operate in plan space
      before we start implementing. Use /effort max.
    model: opus
    effort: max
    phase: beads
```

**CLI interface:**

```bash
flywheel prompts list                          # show all prompts with metadata
flywheel prompts send "fresh-review" --agent 3 # send to agent pane 3
flywheel prompts send "peer-review" --all      # broadcast to all active agents
```

---

### Component 4 — Vite Dashboard (the monitoring glass + action surface)

**What it does:** A locally-served web UI (`localhost:4200`) that gives you a live view of flywheel state, with a narrow action surface for swarm control and prompt injection. It connects to the local flywheel server over WebSocket — not directly to the VPS. The CLI server handles all SSH communication.

**Architecture:**

```
Browser (dashboard) ←→ WebSocket ←→ flywheel CLI server (localhost) ←→ SSH ←→ VPS
```

**Panels:**

```
┌──────────────────────────────────────────────────────────────────────┐
│ FLYWHEEL CONSOLE    [VPS: ✓ connected]   [Load: 1.2]               │
│                     [GATE: waiting for advance]                     │
├──────────────┬────────────────────────────┬─────────────────────────┤
│ PHASE        │ BEADS (kanban)             │ LOG STREAM              │
│              │                            │                         │
│ ✓ Plan       │ ████░░░ 18/42 done         │ agent-3: claimed bead   │
│ ✓ Beads      │                            │ agent-1: closed bead    │
│ ▶ Swarm      │ [CRITICAL PATH highlight]  │ agent-5: checking mail  │
│ ○ Review     │ PageRank scores visible    │ commit-agent: pushed 3  │
│ ○ Deploy     │ 4 blocked | 6 todo        │                         │
│              │                            │                         │
│ [GATE]       │                            │                         │
│ [Advance ▶]  │                            │                         │
├──────────────┴────────────────────────────┤                         │
│ AGENTS                                    │                         │
│ agent-1 ▶ bead #39 (auth module)          │                         │
│ agent-2 ▶ bead #41 (db schema)            │                         │
│ agent-3 ▶ bead #47 (api routes)           │                         │
│ [commit-agent ↻ 8min remaining]           │                         │
├───────────────────────────────────────────┤                         │
│ PROMPT LIBRARY     MEMORY (cass/cm)       │                         │
│ [Fresh Review] →ag3  Session insights:    │                         │
│ [Peer Review] →all   "auth conflict       │                         │
│ [UBS Scan] →all      resolved via mail"   │                         │
└───────────────────────────────────────────┴──────────────────────────┘
```

**Mutation boundary — three permitted dashboard actions, nothing else:**
1. **Prompt injection** (`prompts send`) — delivers a named prompt to a specific agent or all agents
2. **Swarm pause/resume** — sends `ntm pause` / `ntm resume` to the VPS
3. **Gate advance** — passes the current human gate, unblocking the next phase

---

## Rabbit Holes

1. **SSH reconnection / session recovery** — Do not build in v1. Fail loudly, user reconnects manually.
2. **Multi-model API error handling in wizard** — Save successful plans, fail loudly, allow resume from synthesis step.
3. **Bead stats parsing** — Wrap in thin adapter layer with one test. Do not scatter parsing.
4. **Dashboard real-time topology** — WS is local only. SSH polling at 15–30s server-side. Never build VPS→dashboard push.
5. **Provider key storage** — `providers.yaml` with `chmod 600`. No SQLite. No same file as SSH creds.
6. **CAAM slot rotation** — Round-robin at spawn time is enough for v1.
7. **Idle detection** — Byte-identical snapshots × 3 at 5s + 30min timeout + manual gate. Do not parse Claude Code output.

---

## No-Gos

- No multi-VPS support
- No plugin/extension system
- No team features
- No Windows support
- No Docker/containerized VPS
- No phase-initiation buttons in dashboard
- No smart bead-to-agent assignment
- No VPS-side process supervision
- No autopilot by default
- No deploy without explicit confirmation (`DEPLOY <project-name>`)

---

## Data Model (SQLite, local only)

Seven tables for v1:

- `wizard_runs` — planning sessions
- `flywheel_runs` — flywheel runs per project (with `checkpoint_sha`)
- `ssh_connections` — connection history + latency
- `prompt_sends` — prompt injection audit trail
- `phase_events` — append-only event log (source of truth for replay)
- `bead_snapshots` — bead state per poll cycle (feeds velocity ETA)
- `api_calls` — per-API-call cost log

No ORM. Raw SQLite with prepared statements.

---

## Tech Stack

```
CLI:        Node.js + TypeScript (strict) + commander.js
Dashboard:  Vite + React + TypeScript + Tailwind CSS
SSH layer:  node-ssh (single persistent connection)
Server:     Node.js HTTP + ws (WebSocket, local only)
State:      SQLite (better-sqlite3, synchronous)
API calls:  Anthropic SDK + OpenAI SDK + Google Generative AI SDK
Config:     YAML files (js-yaml)
Build:      tsx for dev, esbuild for CLI bundle, Vite for dashboard
Dist:       npm publish as `agent-flywheel` (binary via package.json#bin)
```

---

## Build Sequence

```
Week 1: SSH Layer
Week 2: SQLite + Config + Gate Machine
Week 3-4: Phase 1 Wizard + Prompt Engine
Week 5: Dashboard + Local WebSocket Server
Week 6: Swarm + Review + Integration + Polish
```

---

*v10 — FINAL. Single-VPS. Shape Up methodology.*
