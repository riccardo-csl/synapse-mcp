# AGENTS.md

## Scope
This file applies to the entire `MCP_Codex_Gemini` repository (`synapse-mcp`).

Use this repo to develop and operate the Synapse MCP server and runner. It is separate from application repos that Synapse orchestrates (for example `/home/arch/Scrivania/PM_SaaS`).

## What This Repo Is
- Local MCP server (`synapse-mcp`) for orchestration tools
- Local runner (`synapse-runner`) that executes Synapse phases
- Core orchestration/state machine/store/locking logic
- Adapter implementations (Gemini frontend worker, Codex backend worker)
- Tests and diagnostics tooling for reliability hardening

## Project Map (High Level)
- `lib/mcp/` - MCP tool definitions and handlers (tool boundary)
- `lib/synapse/` - core types, schemas, store, state machine, service, migration
- `lib/runner/` - runner loop, adapters, command execution, phase execution
- `lib/storage/` - atomic file helpers
- `docs/` - manuals, operations, policy docs
- `diagnostics/` - observer/report templates and diagnostics assets
- `scripts/` - local helper scripts (including observer helper)
- `test/unit/` - deterministic unit tests
- `test/integration/` - local integration tests (no real network LLM dependency)
- `test/e2e/` - optional true e2e tests gated by env
- `dist/` - build output (generated)

## Core Working Rules
- Prefer changing source under `lib/`, `docs/`, `scripts/`, and `test/`; do not hand-edit `dist/`.
- Keep behavior changes small and explicit. This repo prioritizes reliability over broad refactors.
- Preserve repo-local persistence and atomic write semantics (`tmp -> rename`) unless intentionally changing storage behavior.
- Maintain machine-readable errors (`{ code, message, details }`) across the stack.
- Keep MCP tool responses normalized (`ok: true/false` envelopes) when touching handlers.

## Build / Test Commands
- Install deps: `npm install`
- Build: `npm run build`
- Full tests: `npm test`
- Unit only: `npm run test:unit`
- Integration only: `npm run test:integration`
- Optional E2E (gated): `npm run test:e2e` (`E2E=1` and env setup required)

## Run Commands
- MCP server: `npm run mcp:start`
- Runner (default polling): `node dist/runner.js start`
- Runner against another repo: `node dist/runner.js start --repo-root=/path/to/repo`
- Runner diagnostics:
  - `node dist/runner.js doctor --repo-root=/path/to/repo`
  - `node dist/runner.js health --repo-root=/path/to/repo`
  - `node dist/runner.js report <cycle_id> --repo-root=/path/to/repo`
  - `node dist/runner.js migrate --dry-run --repo-root=/path/to/repo`

## Cross-Repo Workflow (Important)
- This repo is often used to orchestrate work in another repo.
- Synapse code lives here; `.synapse/` runtime state is created in the target repo (`--repo-root=...`).
- When debugging a target repo cycle, always specify which repo owns the `.synapse` state.
- Do not mix “fix Synapse code” changes (this repo) with “feature work” changes in the target repo unless explicitly requested.

## Observer / Diagnostics Mode
- If acting as a Synapse reliability observer, default to read-only diagnostics:
  - inspect `.synapse` state in the target repo
  - run `synapse-runner report/doctor/health`
  - analyze errors and propose smallest fixes + regression tests
- Only patch code in this repo when explicitly asked to switch from observer mode to fix mode.
- Helper script: `node scripts/synapse-observer-helper.mjs --repo-root=/path/to/target-repo`

## Reliability Priorities (When Making Changes)
Prefer improvements that strengthen:
1. Deterministic parsing and adapter contracts
2. State-machine correctness and retry behavior
3. Locking/heartbeat/stale takeover safety
4. Diagnostics quality (logs/reporting/error classification)
5. Test coverage for real failure modes

## Testing Expectations for Changes
- Behavior changes should include tests when practical (unit or integration).
- For adapter/parser changes, add fixture-style tests in `test/unit/*adapter*.test.ts`.
- For retry/runner behavior changes, prefer integration tests in `test/integration/`.
- Avoid tests that require live Gemini/Codex unless explicitly placing them in optional E2E coverage.

## Docs Expectations
- Update `README.md` for user-facing command/config behavior changes.
- Update `docs/OPERATIONS.md` for operational/reliability behavior changes.
- Add targeted docs instead of broad rewrites.

## Safety / Boundaries
- Do not run destructive git commands (`reset --hard`, checkout overwrite) unless explicitly requested.
- Do not remove `.synapse` state from target repos unless explicitly asked (can destroy debugging evidence).
- Be explicit about which repo is being modified before patching code during cross-repo work.
