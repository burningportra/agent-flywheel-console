# feat: Send Phase Step Prompts to Agents + Iterate

**Date:** March 2026
**Type:** Enhancement
**Appetite:** 1 day

---

## Overview

Phase step prompt buttons currently only copy text to the clipboard. This plan wires them to actually send prompts to agent panes via the dashboard, shows delivery confirmation inline, and advances to the next step automatically — creating a sequential dispatch flow that guides you through each phase's review/iteration cycle.

---

## Problem Statement

The review phase has 5 steps (fresh-review, peer-review, scrutinize-ui, apply-ubs, advance gate). Right now:
- Buttons copy text to clipboard
- User must manually open a terminal, paste into an NTM pane, repeat for each step
- No visibility into which agents received which prompt
- No tracking of which steps have been sent
- No guidance on "now send this next one to the OTHER agents"

The desired flow:
1. Click "Send to pane 1" on the fresh-review step → agent 1 receives it
2. Delivery confirmed inline ("Delivered to pane 1")
3. Step 2 (peer-review) becomes the highlighted current step
4. Click "Send to panes 2, 3, 4" → those agents receive it
5. Continue through all steps

---

## Architecture Context

Key constraints from the existing codebase:

- **No response text from agents** — NTM only confirms delivery (`delivered: N, targets: [1,2,3]`). Agents process prompts in their tmux panes; there's no channel to read their output back.
- **`prompt.send` currently requires a named prompt** from `prompts.yaml` — arbitrary text not supported (`cli/server.ts:497-501`)
- **Agent status updates every 10s** via `ntm status --json` → after a send, the agent will show as `active` on the next poll cycle
- **`refreshAll()` is called after every action** (`cli/server.ts:541-542`), so snapshot.agents will reflect new agent state quickly
- **Step progression must be ephemeral** — tracked in the `state` object in `dashboard/main.ts`, reset on page reload

---

## Proposed Solution

### Three changes

**1. Server: support `promptText` (arbitrary text) in `prompt.send`**
Extend the DashboardAction type so the dashboard can send the hardcoded phase-step prompts without requiring them to be in `prompts.yaml`.

**2. Server: richer `action_result` for prompt.send**
Include `delivered`, `targets` in the result payload so the dashboard can show "Delivered to panes 1, 2, 3" inline.

**3. Dashboard: replace clipboard buttons with inline send UI**
Each phase step gets an agent selector (pill buttons per pane + "All") and a send button. After sending:
- Step shows "✓ Delivered to pane N" inline
- Step state changes to "done"
- Next step becomes "current" automatically
- Agent pane dots appear next to the step (active/idle/stuck from snapshot.agents)

---

## Implementation Plan

### T1 — Server: extend DashboardAction + handlePromptSend

**depends_on: []**

In `cli/server.ts`:

**Extend the `prompt.send` union member** (line ~120) to accept `promptText`:
```typescript
| {
    type: "prompt.send";
    promptName?: string;     // optional when promptText is set
    promptText?: string;     // NEW: arbitrary text, bypasses prompts.yaml lookup
    pane?: number;
    all?: boolean;
    variables?: Record<string, string>;
    sessionName?: string;
  }
```

**Update `handlePromptSend()`** (line ~494):
- If `action.promptText` is set, use it directly (still run through `substituteVariables`)
- Else look up by `action.promptName` (existing behavior unchanged)
- Log label: `action.promptName ?? "step-prompt"` for the audit trail

**Richer response** — return `{ delivered, targets, ok: true }` explicitly so the dashboard can display it. The existing `NtmSendResult` already has this; just ensure it reaches the `action_result` payload.

**Files:** `cli/server.ts:120-141` (type), `cli/server.ts:494-536` (handler)

---

### T2 — Dashboard: add `sentSteps` tracking to state

**depends_on: []** (parallel with T1)

In `dashboard/main.ts`, add to the `state` object:
```typescript
sentSteps: new Map<string, { panes: number[]; deliveredAt: string }>()
// key: "{phase}:{stepIndex}", e.g., "review:0"
```

This tracks which steps were sent and to which panes. Ephemeral — reset on reconnect.

---

### T3 — Dashboard: inline send UI on phase steps

**depends_on: [T1, T2]**

Replace the `step-prompt-btn` (clipboard copy) with a send UI component in `renderPhaseSteps()`:

**For each step that has `promptText`:**

```
┌─────────────────────────────────────────────────────┐
│ ▶  Fresh review — catch bugs the author missed      │
│    Each agent re-reads the code they just wrote...  │
│                                                     │
│    Send to:  [All]  [·1 claude]  [·2 codex]  [·3]  │
│              └── clicking any sends immediately ──┘  │
└─────────────────────────────────────────────────────┘
```

After send:
```
┌─────────────────────────────────────────────────────┐
│ ✓  Fresh review — catch bugs the author missed      │
│    ✓ Delivered to pane 1 (claude) · 2 min ago       │
│    · Pane 1 status: active                          │
└─────────────────────────────────────────────────────┘
```

**Implementation:**
- Agent selector pills are built from `snapshot.agents` — shows pane number + agent type badge
- "All" pill sends with `all: true`
- Individual pill sends with `pane: N`
- On click: call `postAction({ type: "prompt.send", promptText: step.promptText, pane: N })` (or `all: true`)
- On success: store in `state.sentSteps`, re-render steps (done state shows delivery info)
- On failure: show inline error

**Step-done display** shows:
- "✓ Delivered to pane N (type)"
- Agent status dot (from `snapshot.agents`) that refreshes on poll

**Files:** `dashboard/main.ts` (renderPhaseSteps, new sendStepPrompt helper), `dashboard/style.css` (agent-pill, send-result styles)

---

### T4 — Dashboard: auto-advance current step after send

**depends_on: [T3]**

In `getPhaseSteps()`, when computing step states:
- If `state.sentSteps` has an entry for step index N, mark that step as `"done"`
- The step AFTER the last sent step becomes `"current"`
- This creates the natural iteration flow: send step 1 → step 2 highlights → send step 2 → etc.

The gate-advance step is still controlled by `actionStates["gate.advance"].enabled` from the server — sending all prompts doesn't automatically enable it.

---

### T5 — Dashboard: inline delivery result display

**depends_on: [T3]**

After a step is sent, the done-state body shows:
- Delivery timestamp ("Sent 2 min ago")
- Which panes received it ("panes 1, 2, 3")
- Live agent status dots that update from snapshot.agents

```typescript
// In renderPhaseSteps, for a done step:
if (sent) {
  const result = state.sentSteps.get(stepKey);
  const paneStatuses = result.panes.map(paneNum => {
    const agent = snapshot.agents.find(a => a.pane === paneNum);
    return `pane ${paneNum} (${agent?.status ?? "unknown"})`;
  });
  detail.textContent = `Delivered to ${paneStatuses.join(", ")} · ${formatRelative(result.deliveredAt)}`;
}
```

---

## CSS additions

New classes to add to `dashboard/style.css`:

```css
/* Agent selector pills */
.agent-pills { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.5rem; }
.agent-pill { /* pill button per pane + "All" */ }
.agent-pill--all { /* amber color */ }
.agent-pill--sending { /* spinning/busy state */ }

/* Send result */
.step-send-result { /* delivery confirmation line */ }
.step-agent-dot { /* status dot: green=active, amber=idle, red=stuck */ }
```

---

## Files Changed

| File | Change |
|------|--------|
| `cli/server.ts` | Add `promptText?` to DashboardAction prompt.send type; update handlePromptSend() to use it |
| `dashboard/main.ts` | Add `sentSteps` to state; add `sendStepPrompt()` helper; update renderPhaseSteps() with send UI + auto-advance; update step done-state to show delivery result |
| `dashboard/style.css` | Add agent-pill, send-result, step-agent-dot styles |

**No new dependencies. No schema changes.**

---

## Dependency Graph

```
T1 (server: promptText support)   T2 (state: sentSteps tracking)
     └──────────────┬──────────────┘
                    ▼
           T3 (inline send UI)
                    │
          ┌─────────┴──────────┐
          ▼                    ▼
   T4 (auto-advance)    T5 (delivery display)
```

---

## Acceptance Criteria

- [ ] Clicking "Send to pane 1" on a phase step sends the prompt text to that agent (POST /action → ntm send)
- [ ] Clicking "All" sends to all active agent panes
- [ ] The sent step changes state to "done" with delivery confirmation ("Delivered to pane 1 · just now")
- [ ] The next step automatically becomes the highlighted "current" step
- [ ] Agent status dots on sent steps update live from snapshot.agents (active/idle/stuck)
- [ ] Named prompts from the Prompt Library panel still work unchanged
- [ ] `tsc --noEmit` and `tsc --project dashboard/tsconfig.json` both pass
- [ ] Action log still records each send

## What This Doesn't Do

- **No agent response text** — NTM confirms delivery only; actual output stays in the tmux pane
- **No automatic step timing** — you decide when to send step 2 after step 1
- **No cross-session persistence** — sent state resets on page reload
- **No Agent Mail polling** — reading agent mail messages is a separate future feature

---

## References

- `cli/server.ts:120-141` — DashboardAction type (prompt.send variant)
- `cli/server.ts:494-536` — handlePromptSend()
- `cli/ntm-bridge.ts:88-94` — NtmSendResult (delivered, targets)
- `dashboard/main.ts:531-574` — existing prompt form submission
- `dashboard/main.ts:733-761` — runAction() / postAction()
