# Test Program Plan and Risk Matrix

## Objective
Deliver comprehensive, granular unit + integration + e2e coverage for the flywheel control plane with high diagnostic quality and no-mock default behavior.

## Critical Workflow Inventory (Risk-Prioritized)

| Workflow | Risk | Why It Matters | Required Test Depth |
|---|---|---|---|
| `flywheel rollback` destructive flow | Critical | Data-loss potential if guardrails fail | Unit + integration + e2e |
| `flywheel deploy` confirmation + push flow | Critical | Production mutation boundary | Unit + integration + e2e |
| Server `/action` and WS action loop | High | Main dashboard mutation surface | Integration + e2e |
| SSH manager and remote command execution | High | Foundational remote boundary | Integration + e2e |
| Gate advance/status transitions | High | Phase-control correctness | Unit + integration |
| Prompt routing/substitution and send contracts | High | Agent behavior steering correctness | Unit + integration + e2e |
| Bead triage parsing and summary logic | Medium | Planning/throughput visibility | Unit + integration |
| Runs/replay chronology and event rendering | Medium | Auditability and debugging | Unit + integration |
| Provider/config loading | Medium | Startup reliability and model policy correctness | Unit + integration |
| Dashboard rendering helpers | Medium | Operator trust/clarity | Unit |

## Execution Order
1. Testing architecture gate (`2pl.1.*`)
2. Baseline harness + deterministic unit coverage (`2pl.2.*`)
3. Integration boundary suites (`2pl.3.*`)
4. E2E happy/failure/recovery scripts with telemetry (`2pl.4.*`)
5. CI gates + coverage enforcement + artifacts (`2pl.5.*`)

## Environment Isolation Strategy
All test tiers use per-test or per-suite isolated resources:
- Temporary HOME/workdir trees.
- Temporary SQLite DB files per suite.
- Ephemeral server ports.
- Deterministic teardown for processes/sockets/timers.
- No shared mutable state across test workers.

## Coverage and Quality Targets
These are minimums for completion of the full testing program:
- Unit coverage floor: 85% statements, 75% branches for `cli/` deterministic modules.
- Integration coverage floor: all high/critical workflows have at least one success and one failure test.
- E2E coverage floor: happy path + minimum 5 named failure/recovery scenarios.
- Safety-path requirement: every destructive or remote-mutating command has negative-path assertions.

## Definition of Done (Program)
1. `npm run test:unit`, `npm run test:integration`, `npm run test:e2e` are implemented and documented.
2. CI enforces coverage thresholds and fails on regressions.
3. Failed integration/e2e runs produce retained artifacts and structured logs.
4. No-mock policy is documented and referenced by review process.
5. Risk matrix workflows above are all covered according to required depth.

## Runner Architecture

### Why Vitest

**Vitest** was chosen over Jest, Mocha, and node:test for these reasons:

| Requirement | Vitest | Jest | Mocha | node:test |
|-------------|--------|------|-------|-----------|
| Native ESM (no transform) | ✓ | requires config | requires esm flag | ✓ |
| TypeScript without emit | ✓ (tsx) | requires Babel/ts-jest | requires ts-node | partial |
| Built-in coverage (v8) | ✓ | requires c8/v8 separately | requires nyc | external |
| Per-file module isolation | ✓ (isolate: true) | global by default | no | no |
| Watch mode + HMR | ✓ | ✓ | external | no |
| Timeout + retry per test | ✓ | ✓ | ✓ | no |

ESM-native is non-negotiable: the CLI is built with esbuild as ESM, and test imports must resolve the same module graph.

### Key Configuration Decisions

All decisions live in `vitest.config.ts`:

| Setting | Value | Why |
|---------|-------|-----|
| `environment` | `node` | No DOM, no jsdom — this is a CLI, not a browser app |
| `isolate` | `true` | Each test file gets a fresh V8 module registry; prevents shared state between `loadPrompts()` cache and similar singletons |
| `testTimeout` | `10_000` ms | Default for unit/contract. Integration and e2e override per-run via `--testTimeout 30000` |
| `retry` | `0` (default) | No masking of failures at the config level; CI stages opt-in via `--retry 1` |
| `coverage.provider` | `v8` | Built into Node.js; no native code required; accurate for ESM |
| `coverage.reporter` | `text, lcov, html` | Human-readable (text), LCOV for CI integrations, HTML for local browsing |

### Test File Naming Conventions

| Pattern | Layer | Runner config |
|---------|-------|---------------|
| `test/unit/**/*.test.ts` | Unit — pure functions, no I/O | Default 10s timeout, retry 0 |
| `test/contract/**/*.test.ts` | HTTP/WS shape contracts | Default 10s, retry 0 |
| `test/integration/**/*.test.ts` | Subprocesses, temp dirs | 30s timeout, retry 1 in CI |
| `test/e2e/local-commands.e2e.ts` | Real binary, no VPS | 30s timeout, retry 1 in CI |
| `test/e2e/**/*.e2e.ts` | VPS E2E (opt-in) | 60s timeout, retry 2 in CI |
| `test/live/**/*.test.ts` | Real API calls (opt-in) | Requires `FLYWHEEL_TEST_LIVE=1` |

### Adding a New Test Tier

1. Choose the correct directory (see naming conventions above).
2. Add the glob to `vitest.config.ts` → `test.include`.
3. Add a dedicated `npm run test:mytier` script to `package.json`.
4. Add a stage to `.github/workflows/ci.yml` with the appropriate `--testTimeout` and `--retry` values.
5. Document any env vars or secrets required in the CI stage and in this file.

## Mapping to Bead Structure
- `2pl.1.*`: policy, risk inventory, env strategy, DoD/thresholds
- `2pl.2.*`: unit harness and deterministic module tests
- `2pl.3.*`: real boundary integration tests
- `2pl.4.*`: end-to-end scripts + telemetry schema
- `2pl.5.*`: CI quality gates, publishing, flake management

