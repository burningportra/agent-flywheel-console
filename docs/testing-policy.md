# Testing Policy (No-Mock Default)

## Purpose
This policy defines how tests for Agent Flywheel Console are designed and reviewed so test outcomes are trustworthy for real operator workflows.

## Core Rules
1. Default to real boundaries and real behavior.
2. Prefer deterministic execution over synthetic shortcuts.
3. Require explicit, documented approval for any mock/fake exception.
4. Every failure path in a destructive or remote-facing flow must be test-covered.

## No-Mock Default
By default, tests must use:
- Real SQLite files (temporary on-disk DBs) for state behavior.
- Real process execution (`spawn`) for CLI contract tests.
- Real HTTP + WebSocket loop for server action/snapshot behavior.
- Real filesystem I/O in isolated temp workdirs.

Disallowed by default:
- Mocking `StateManager` DB behavior in unit or integration tests.
- Replacing CLI command invocation with direct handler calls for integration claims.
- Replacing remote-runner output with ad-hoc fake objects in integration tests.

## Allowed Exceptions (Strict)
An exception is allowed only when all conditions are true:
1. Real dependency cannot be provisioned deterministically in CI/local.
2. The exception is narrow (single boundary), not whole-subsystem stubbing.
3. A companion contract test exists at a lower/higher layer to validate real behavior.
4. The PR includes a short "Mock Exception" section with:
   - What is replaced and why.
   - Why real dependency is currently impractical.
   - Exit condition for removing the exception.

## Review Checklist
A test change is not accepted unless reviewers can answer yes to all:
- Does this test assert observable behavior, not implementation details?
- Does it validate both success and failure paths?
- Is cleanup deterministic (temp dirs, sockets, server shutdown, timers)?
- If an exception exists, is it documented with an exit condition?

## Logging and Diagnostics Standard
Integration/e2e tests must emit structured step logs containing:
- timestamp (ISO-8601)
- test/suite name
- operation name
- command/action payload summary
- duration_ms
- exit/result status
- stdout/stderr excerpt pointers (not full noise by default)
- artifact paths (snapshot JSON, transcripts, failure dumps)

## Security and Safety Focus Areas
Mandatory negative-path coverage for:
- rollback/deploy guardrails and confirmation checks
- JSON parsing and malformed remote output handling
- remote command timeout/exit-code propagation
- gate transition validation and invalid phase refusal

