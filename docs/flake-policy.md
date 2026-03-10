# Flake Detection, Retry, and Quarantine Policy

## Purpose

Flaky tests undermine trust. A test that sometimes passes and sometimes fails on
the same code provides no reliable signal. This document defines exactly how the
project detects, retries, quarantines, and clears flaky tests so the problem
remains visible and never silently rots.

---

## Detection

### Nightly automation

`.github/workflows/flake-detect.yml` runs the integration + local e2e suite **5
times in parallel** every night at 02:00 UTC, with `--retry 0` (no retry
masking). The `scripts/analyze-flakes.js` aggregator then marks any test that
both passed and failed across runs as flaky.

The workflow fails if **more than 1 flaky test** is found, creating a CI signal
that requires triage.

### Manual detection

Run the suite repeatedly with `--retry 0`:

```bash
# Quick: 3 consecutive runs
for i in 1 2 3; do
  npx vitest run test/integration --retry 0 --reporter=json \
    --outputFile=reports/run-$i.json
done
node scripts/analyze-flakes.js reports/
```

---

## Retry Policy

| Test layer | Retry in CI | Rationale |
|------------|-------------|-----------|
| Unit tests | **0** (never) | Unit tests are pure functions. A retry masks a real bug. |
| Contract tests | **0** | HTTP/WS with loopback. Flakes here mean a real race. |
| Integration tests | **1** | Process startup timing, port allocation, temp-dir races. One retry is tolerated; two consecutive failures means real. |
| Local E2E | **1** | Subprocess lifecycle. Same rationale as integration. |
| VPS E2E | **2** | Network latency + remote process startup. Higher retry ceiling; quarantine threshold is still 1 per 5 runs. |

Retry values are set via `--retry` in `.github/workflows/ci.yml`.

A test that passes only after retry is a **candidate for quarantine** if it
recurs across more than one run of the nightly flake detector.

---

## Quarantine Workflow

Quarantine means: the test still exists and is tracked, but is excluded from the
blocking CI run. It must remain **visible** so it cannot silently rot.

### Step 1: Mark with `.skipIf`

```typescript
// QUARANTINE: flaky due to port allocation race — see bead: agent-<id>
// Last flake: 2026-03-15 | Owner: @yourname | Exit: fix port binding
it.skipIf(process.env.CI === "1")("server starts and accepts connections", async () => {
  // ...
});
```

Or for a full file, use vitest `--exclude` in a separate quarantine CI stage.

### Step 2: Create a bead

```bash
br create --title "Quarantine: fix <test name>" --type task --label flake,quarantine \
  --description "Flaky since <date>. Cause: <known/unknown>. Exit: <condition>."
```

Quarantine beads are **P1** by default — a flaky test is a debt.

### Step 3: Run quarantined tests separately

Add a dedicated CI stage that runs only quarantined tests (never blocking):

```yaml
# .github/workflows/ci.yml — quarantine stage (non-blocking)
- name: Run quarantined tests (informational)
  continue-on-error: true
  run: npx vitest run --exclude='**/quarantined/**' ...
```

### Step 4: Clear the quarantine

A test exits quarantine when it passes cleanly for **3 consecutive nightly
flake-detect runs**. Remove the `.skipIf`, close the bead, delete any
`--exclude` from CI.

---

## Thresholds

| Metric | Threshold | Action |
|--------|-----------|--------|
| Flaky tests detected per nightly run | > 1 | Flake-detect workflow fails; owner must quarantine or fix within 2 business days |
| Consecutive nightly runs a quarantined test fails | > 3 | Escalate: bead priority bumped to P0 |
| Days a test has been quarantined | > 14 | Owner is pinged in bead comment; bead added to next sprint |
| Days a test has been quarantined | > 30 | Test is deleted unless owner provides a fix timeline |

---

## Ownership

- The **person who merges** a PR that introduces a flaky test owns the quarantine.
- The **bead system** tracks quarantined tests — `br list --label flake` shows all active quarantine beads.
- The **flake-detect workflow** is the early-warning system; it fires before test failures reach humans.

---

## Anti-Patterns

**Do not:**
- Set `retry: 3` globally to make a flaky suite "green." Retry masks real failures.
- Use `.skip` without creating a bead. Skipped tests without tracking silently rot.
- Mark an always-failing test as flaky. Always-failing tests are broken, not flaky — fix them immediately.
- Ignore flake-detect failures for more than 2 business days.

---

## Related Files

- `.github/workflows/flake-detect.yml` — nightly detection automation
- `.github/workflows/ci.yml` — per-stage retry config
- `scripts/analyze-flakes.js` — aggregation script
- `docs/testing-policy.md` — no-mock policy and review checklist
