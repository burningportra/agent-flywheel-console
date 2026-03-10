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

## Mapping to Bead Structure
- `2pl.1.*`: policy, risk inventory, env strategy, DoD/thresholds
- `2pl.2.*`: unit harness and deterministic module tests
- `2pl.3.*`: real boundary integration tests
- `2pl.4.*`: end-to-end scripts + telemetry schema
- `2pl.5.*`: CI quality gates, publishing, flake management

