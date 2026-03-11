# feat: Dashboard — Vanilla TypeScript + Missing Panels

**Date:** March 2026
**Type:** Enhancement
**Appetite:** 1 day
**Reviewed by:** DHH (anti-migration), Kieran (TypeScript bugs), Simplicity Reviewer (YAGNI)

---

## Decision

Keep the vanilla JS dashboard. Port to TypeScript for type safety. Add the missing panels.
Do **not** migrate to React, Zustand, or Tailwind. The existing 960-line `main.js` is well-structured and already handles WS reconnect, action dispatch, and all panel rendering correctly.

---

## Overview

Three actual deliverables:

1. **Type safety** — extract `DashboardSnapshot` and all sub-types into `dashboard/types.ts`; convert `dashboard/main.js` → `dashboard/main.ts` with strict type checking
2. **Missing panels** — `MemoryPanel` (richer session content), `CostPanel` (api_calls table visualization)
3. **Server path update** — 3-line change to `resolveDashboardAssetPath()` so `tsx` dev mode keeps working

---

## What the Server Already Provides

`DashboardSnapshot` shape (source of truth in `cli/server.ts`, all types currently unexported):

```typescript
interface DashboardSnapshot {
  generatedAt: string;
  server: { host: string; port: number; sessionName: string; remoteProjectPath?: string };
  ssh: { connected: boolean; host?: string };
  run: RunSummary | null;
  agents: AgentStatus[];        // from cli/ntm-bridge.ts
  beads: BeadSummary | null;
  vpsHealth: VpsHealth | null;
  mail: { available: boolean; reason?: string };
  prompts: PromptSummary[];
  guidance: { title: string; detail: string };
  actions: ActionName[];
  actionStates: Record<ActionName, ActionState>;
  lastError?: string;
}

type ActionName = "prompt.send" | "swarm.pause" | "swarm.resume" | "gate.advance";
type Phase = "plan" | "beads" | "swarm" | "review" | "deploy";
type AgentRuntimeType = "claude" | "codex" | "gemini" | "user" | "unknown";
```

Note: `AgentStatus` and `AgentRuntimeType` are defined in `cli/ntm-bridge.ts`, not `cli/server.ts`. Both need to be in `types.ts`.

`BeadSummary` column semantics (confirmed from server source):
- `open` = backlog (open but not in progress)
- `inProgress` = in progress
- `closed` = done
- `blocked` = blocked
- `total` = sum of all

---

## Implementation Plan

### T1 — Export types from CLI + create `dashboard/types.ts`

**depends_on: []**

- In `cli/server.ts`: export `DashboardSnapshot`, `RunSummary`, `BeadSummary`, `VpsHealth`, `PromptSummary`, `ActionName`, `ActionState`, `Phase`, `WorkflowGuidance` (add `export` keyword to existing type/interface declarations)
- In `cli/ntm-bridge.ts`: export `AgentStatus`, `AgentRuntimeType`
- Create `dashboard/types.ts`:
  ```typescript
  // Re-export from CLI for dashboard consumption (no runtime import — types only)
  export type { DashboardSnapshot, RunSummary, BeadSummary, VpsHealth,
                PromptSummary, ActionName, ActionState, Phase } from '../cli/server.js'
  export type { AgentStatus, AgentRuntimeType } from '../cli/ntm-bridge.js'

  // Client-only types
  export type ServerMessage =
    | { type: 'snapshot'; payload: DashboardSnapshot }
    | { type: 'action_result'; ok: true; action: ActionName; payload: unknown }
    | { type: 'action_result'; ok: false; error: string }

  export interface ActionLogEntry {
    timestamp: string;
    action: ActionName;
    ok: boolean;
    payload?: unknown;
    error?: string;
  }
  ```
- Add a `dashboard/tsconfig.json` (standalone, NOT extending root — root uses `NodeNext`, dashboard needs `Bundler`/`ESNext`):
  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "module": "ESNext",
      "moduleResolution": "Bundler",
      "strict": true,
      "noEmit": true,
      "lib": ["ES2022", "DOM", "DOM.Iterable"],
      "skipLibCheck": true,
      "checkJs": true,
      "allowJs": true
    },
    "include": ["*.ts", "*.js"]
  }
  ```
- Add `"typecheck:dashboard": "tsc --project dashboard/tsconfig.json"` to `package.json` scripts

**Acceptance:** `npm run typecheck:dashboard` passes with 0 errors.

---

### T2 — Convert `dashboard/main.js` → `dashboard/main.ts`

**depends_on: [T1]**

- Rename `dashboard/main.js` → `dashboard/main.ts`
- Add `import type { DashboardSnapshot, ServerMessage, ActionLogEntry, ... } from './types.js'`
- Annotate `state` object, `ui` cache, and all function signatures with types from `types.ts`
- Fix any type errors surfaced (expected: a handful around the `ui` element cache and `applySnapshot` parameter)
- Update `dashboard/index.html` script tag to reference `main.ts` (no build step change needed — the server serves it directly via tsx in dev, or pre-compiled)
- Update `cli/server.ts` `resolveDashboardAssetPath()` to probe `main.ts` before `main.js` (3-line change)

**Do NOT change any logic** — only type annotations. If a change is needed to satisfy types, use the narrowest possible fix.

**IDs to verify are still present in main.ts** (all 35 from the Playwright harness):
`#ws-status`, `#run-badge`, `#guidance-title`, `#guidance-detail`, `#workflow-rail`,
`#metric-run`, `#metric-project`, `#metric-phase`, `#metric-phase-meta`, `#metric-ssh`,
`#metric-host`, `#metric-agents`, `#metric-agent-breakdown`, `#metric-beads`,
`#metric-top-pick`, `#metric-velocity`, `#metric-prompts`, `#metric-session`,
`#error-banner`, `#agent-list`, `#bead-summary`, `#action-availability`,
`#prompt-library`, `#prompt-library-meta`, `#vps-health`, `#mail-status`,
`#action-log`, `#prompt-form`, `#prompt-name`, `#prompt-options`, `#prompt-pane`,
`#prompt-all`, `#prompt-vars`, `#prompt-meta`, `#prompt-submit`, `#session-summary`,
`#pause-button`, `#resume-button`, `#swarm-controls-note`, `#gate-form`,
`#gate-phase`, `#gate-checkpoint`, `#gate-submit`, `#gate-note`, `#server-meta`,
`#server-url`, `#reconnect-button`, `#refresh-button`, `#agents-updated`

**Acceptance:** `npm run typecheck:dashboard` still passes; existing Playwright E2E suite passes green.

---

### T3 — Add MemoryPanel

**depends_on: [T2]**

The `#session-summary` element already exists and renders `snapshot.server.sessionName`. Enrich it:

- Add a `renderMemoryPanel(snapshot: DashboardSnapshot): void` function
- Display: session name, remote project path, run ID (if active), phase, started-at timestamp
- Optionally: last gate passed timestamp
- All data is already in `snapshot.server` and `snapshot.run` — no new server-side work needed
- Hook into `applySnapshot()` call chain

**Acceptance:** Session panel shows session name + project path + run phase when a run is active.

---

### T4 — Add CostPanel

**depends_on: [T2]**

The `api_calls` table is populated by the CLI on every LLM call (model, input_tokens, output_tokens, cost_usd, phase) but never surfaced in the UI.

- Add `GET /cost` endpoint to `cli/server.ts` — queries `api_calls` for the current run, returns `{ totalCostUsd: number; byModel: Record<string, number>; byPhase: Record<Phase, number> }`
- Add a `renderCostPanel(data: CostSummary): void` function to `dashboard/main.ts`
- Poll alongside snapshot (attach to same 10s WS tick or fetch on snapshot update)
- Add a `#cost-panel` container in `dashboard/index.html`
- Display: total cost ($0.00 format), breakdown by model (Opus/Sonnet/Haiku/GPT-4o/Gemini), breakdown by phase

**Note on polling:** Simplest approach — call `fetch('/cost')` inside `applySnapshot()` and render inline. No new WS message type needed.

**Acceptance:** Cost panel shows running total and model breakdown during an active flywheel run.

---

### T5 — Typecheck in CI

**depends_on: [T1]**

- Add `npm run typecheck:dashboard` step to `.github/workflows/ci.yml` in the type-check stage (parallel with existing `npm run typecheck`)
- No coverage changes needed

**Acceptance:** CI fails if `dashboard/main.ts` has type errors.

---

## Dependency Graph

```
T1 (export types + dashboard/types.ts + tsconfig)
  └── T2 (rename main.js → main.ts, annotate)
        ├── T3 (MemoryPanel enrichment)   ─┐ parallel
        └── T4 (CostPanel + /cost endpoint) ─┘
              └── T5 (CI typecheck step)
```

---

## Files Changed

```
cli/server.ts           ← export types; add GET /cost; resolveDashboardAssetPath update
cli/ntm-bridge.ts       ← export AgentStatus, AgentRuntimeType
dashboard/types.ts      ← NEW: re-exports + client-only ServerMessage, ActionLogEntry
dashboard/tsconfig.json ← NEW: standalone tsconfig (ESNext, checkJs, allowJs)
dashboard/main.js       ← RENAME → main.ts (type annotations only, no logic changes)
dashboard/index.html    ← script src: main.js → main.ts
package.json            ← add typecheck:dashboard script
.github/workflows/ci.yml ← add typecheck:dashboard step
```

**New dependencies: none.**

---

## Acceptance Criteria

- [ ] `npm run typecheck:dashboard` passes (0 errors)
- [ ] `npm run typecheck` (CLI) still passes — exporting types from server.ts/ntm-bridge.ts is additive
- [ ] All 35+ Playwright element IDs resolve — existing `test/e2e/dashboard/` E2E suite passes green
- [ ] MemoryPanel shows session name, project path, run phase when active
- [ ] CostPanel shows total cost + model breakdown during an active run
- [ ] CI pipeline type-checks the dashboard on every push

---

## No-Gos

- No React, no Zustand, no Tailwind — reviewers were unanimous
- No build step added to the dashboard — it continues to be served directly by the CLI server
- No logic changes in T2 — type annotations only, zero behavior change
- No new WS message types for cost (use HTTP polling via fetch inside applySnapshot)

---

## References

- `cli/server.ts` — `DashboardSnapshot`, `resolveDashboardAssetPath()`
- `cli/ntm-bridge.ts` — `AgentStatus`, `AgentRuntimeType`
- `dashboard/main.js` — existing 960-line vanilla JS (rename target)
- `dashboard/index.html` — 35+ stable element IDs
- `test/e2e/dashboard/` — Playwright harness (acceptance gate)
- `docs/pitch.md` — Component 4 spec
- Reviews: DHH (anti-migration), Kieran (8 concrete plan bugs fixed above), Simplicity (YAGNI analysis)
