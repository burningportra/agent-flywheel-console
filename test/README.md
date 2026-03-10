# Test Suite

## Philosophy

**No mocks. No stubs. No fakes.**
All tests use real implementations:
- Real SQLite (in-memory via `initDb(':memory:')` or real temp files)
- Real temp directories on disk (`tempDir()`)
- Real YAML files written to disk (`tempYaml()`)
- Real HTTP servers on port 0 (OS-assigned)
- Real subprocesses for CLI integration tests

## Test layers

### Unit tests — `npm run test:unit`
- `test/unit/**/*.test.ts`
- No network, no VPS, no API keys required
- Runs in under 10 seconds total
- Tests: pure logic, SQLite state machine, config loaders, prompt engine

### Integration tests — `npm run test:integration`
- `test/integration/**/*.test.ts`
- No VPS or API keys required
- Runs real local processes (spawns `node dist/cli.js`)
- Requires `npm run build` first
- Runs in under 60 seconds

### E2E tests — `npm run test:e2e`
- `test/e2e/**/*.e2e.ts`
- Requires: `~/.flywheel/ssh.yaml` configured, VPS reachable
- Required tools on VPS: ntm, br, bv, gh, git
- Automatically skipped when ssh.yaml is missing
- Set `FLYWHEEL_TEST_E2E=1` to enable

## Test isolation

Every test that writes to disk or reads config uses `FLYWHEEL_HOME` env var:
```ts
process.env.FLYWHEEL_HOME = tempDir.path;
// ...test body...
delete process.env.FLYWHEEL_HOME; // restore in afterEach
```

This redirects all config reads/writes to a unique temp directory.
Real `~/.flywheel/` is never touched during test runs.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `FLYWHEEL_HOME` | Override `~/.flywheel/` dir (used for test isolation) |
| `FLYWHEEL_STATE_DB` | Override SQLite path (use `:memory:` for unit tests) |
| `FLYWHEEL_TEST_E2E` | Set to `1` to enable VPS E2E tests |
| `FLYWHEEL_TEST_PROJECT` | Project name to use for E2E (default: `flywheel-e2e-{timestamp}`) |
| `FLYWHEEL_TEST_VPS_TIMEOUT` | SSH timeout in ms (default: 30000) |
| `FLYWHEEL_PROVIDERS_YAML` | Path to providers.yaml for wizard E2E tests |

## Commands

```bash
npm test                       # Run unit + integration tests (no VPS)
npm run test:watch             # Watch mode
npm run test:unit              # Unit tests only (fast, ~3s)
npm run test:integration       # Integration tests (requires npm run build first)
npm run test:e2e               # VPS E2E tests (requires ssh.yaml + FLYWHEEL_TEST_E2E=1)
npm run test:e2e:local         # Local-only E2E (no VPS, real binary)
npm run test:coverage          # With lcov + html coverage report
npm run test:surface           # Export surface gap report (which exports have no test?)
npm run test:surface:strict    # Exits 1 if any uncovered exports are found
```

## Export surface report

`npm run test:surface` scans all `cli/*.ts` exports and reports which exported
identifiers are not referenced in any test file.

This is a coarse "did we forget to write a test?" detector — not a replacement for
line/branch coverage. Known intentional gaps (type aliases, VPS-only commands,
pure wiring exports) are listed in `scripts/coverage-surface.ts:KNOWN_GAPS`.

## Coverage thresholds

Configured in `vitest.config.ts`:
- Lines: ≥ 35%
- Functions: ≥ 50%
- Branches: ≥ 35%
- Statements: ≥ 35%

These are CI ratchet floors set from the current full-suite baseline. Raise them
as coverage improves; do not let the gate drift downward casually.

Current scope: the Vitest coverage gate measures Node-instrumented `cli/**/*.ts`
modules. Dashboard browser code is validated by E2E tests, but it is not yet
collected by the Node coverage pipeline.

Run `npm run test:coverage` and open `coverage/index.html` to view.
