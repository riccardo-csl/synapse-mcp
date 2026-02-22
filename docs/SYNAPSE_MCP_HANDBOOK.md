# Synapse MCP Handbook

## Goal
This handbook explains the whole repository in plain language.

By the end, you should understand:

1. What this project is.
2. What problem it solves.
3. How the MCP server and runner work together.
4. What files are created, updated, and read.
5. How to run it safely.
6. How to debug problems.

You do not need to know MCP, TypeScript, or internal code details before reading.

## Who This Is For
This document is for:

- Project owners.
- Engineers onboarding to this repository.
- Anyone using Codex and Gemini together and wanting predictable orchestration.

## Quick Summary (2 minutes)
`synapse-mcp` is a local orchestration system.

It has two parts:

1. A local MCP server.
2. A local runner process.

The MCP server does not directly write your feature code.
It creates and manages a structured "cycle" that describes the work.

The runner executes cycle phases one by one.

The default phase sequence is:

1. `FRONTEND` phase (Gemini adapter).
2. `BACKEND` phase (Codex adapter using `codex exec`).
3. `FRONTEND_TWEAK` phase (Gemini adapter, optional, can be skipped automatically).

Everything is saved locally in `.synapse/` inside your repo.

## What Is MCP (Simple Explanation)
MCP means Model Context Protocol.

Think of MCP as a standard way for an AI client (like Codex CLI) to call tools from another local service.

In this repo, the MCP server exposes tools like:

- `synapse.orchestrate`
- `synapse.status`
- `synapse.logs`

When Codex calls one of these tools, Synapse returns structured JSON.

The MCP server in this repo uses stdio transport.
That means it communicates through standard input/output with no external web server required.

## Big Picture Architecture

Code entry points:

- MCP server entry: `index.ts`
- Runner CLI entry: `runner.ts`

Core modules:

- MCP tool definitions: `lib/mcp/tools.ts`
- MCP tool dispatcher: `lib/mcp/handlers.ts`
- Orchestration service layer: `lib/synapse/service.ts`
- State machine rules: `lib/synapse/stateMachine.ts`
- Persistence and locking: `lib/synapse/store.ts`
- Runner loop and execution: `lib/runner/index.ts`, `lib/runner/service.ts`
- Adapters: `lib/runner/adapters/gemini.ts`, `lib/runner/adapters/codexExec.ts`
- Safe file + atomic JSON writes: `lib/storage/files.ts`

Mental model:

- The MCP server is the "control API".
- The runner is the "worker".
- `.synapse/` is the "source of truth" for orchestration state.

## Key Concepts

### Cycle
A cycle is one orchestration job.

A cycle includes:

- Original user request text.
- Repo root path.
- Phase list.
- Status.
- Logs.
- Artifacts.
- Error state.

### Phase
A phase is one step in the cycle.

A phase has:

- Type: `FRONTEND`, `BACKEND`, or `FRONTEND_TWEAK`.
- Status: `PENDING`, `CLAIMED`, `RUNNING`, `DONE`, `FAILED`, `SKIPPED`.
- Attempt counters and timeout.
- Input/output payload fields.

### Adapter
An adapter is the concrete executor for a phase type.

- Gemini adapter handles `FRONTEND` and `FRONTEND_TWEAK`.
- Codex adapter handles `BACKEND` with `codex exec`.

### Claim Token
Runner claims a phase before execution.

This prevents two runners from executing the same phase at once.

### Artifacts
Artifacts are accumulated outputs of a cycle:

- Changed files list.
- Commands run.
- Check/test results.

## Storage Layout (What Is Written To Disk)
Synapse writes under `.synapse/` in your project root.

Expected structure:

```text
.synapse/
  config.json
  cycles/
    <cycle_id>.json
  locks/
    <cycle_id>.lock
```

What each file means:

- `config.json`: runner behavior settings (adapters, checks, safety denylist).
- `cycles/<id>.json`: full state for one cycle.
- `locks/<id>.lock`: temporary lock file used while mutating a cycle.

Important behavior:

- JSON writes are atomic (`tmp` file then rename).
- This reduces corruption risk if process crashes during write.

## Data Model (Plain Language)
The main data model lives in `lib/synapse/types.ts`.

### Cycle status values
A cycle can be:

- `QUEUED`: created, waiting for runner work.
- `RUNNING`: at least one phase is active or in progress.
- `DONE`: all required phases finished or were skipped.
- `FAILED`: a phase exceeded retries or hard failure occurred.
- `CANCELED`: manually canceled.

### Phase status values
A phase can be:

- `PENDING`: not started yet.
- `CLAIMED`: reserved by runner.
- `RUNNING`: currently executing.
- `DONE`: completed successfully.
- `FAILED`: permanently failed.
- `SKIPPED`: intentionally skipped.

### What is in one cycle file
A cycle JSON includes:

- Metadata: `id`, timestamps, request, repo path.
- `phases`: full list of phase objects.
- `current_phase_index`: where execution currently points.
- `artifacts`: changed files, commands, checks.
- `logs`: append-only event list.
- `last_error`: machine-readable latest failure.

## End-to-End Flow (Step by Step)
This is the real runtime sequence.

### Step 1: Create a cycle
Codex (or another MCP client) calls `synapse.orchestrate`.

Synapse validates inputs and creates a cycle file.

Result:

- New cycle status is `QUEUED`.
- Phases are created in configured/default order.

### Step 2: Runner finds runnable work
Runner loop calls `claimNextRunnablePhase(...)`.

It scans recent non-terminal cycles.

For each cycle it:

1. Acquires cycle file lock.
2. Tries to claim current `PENDING` phase.
3. Saves claimed state.

### Step 3: Runner marks phase running
Runner updates phase:

- `CLAIMED` -> `RUNNING`
- increments `attempt_count`
- writes log entry

### Step 4: Execute adapter
Runner chooses adapter by phase type:

- `BACKEND` -> Codex adapter (`codex exec` command).
- `FRONTEND` or `FRONTEND_TWEAK` -> Gemini adapter.

### Step 5: Run checks
After adapter execution, runner executes configured checks for that phase.

Examples of checks you can configure:

- `npm run lint`
- `npm test`
- `npm run build`

If any check fails, phase is marked failed/retry logic runs.

### Step 6: Decide next phase
If successful, phase becomes `DONE`.

Special rule:

- If current phase is `BACKEND` and next phase is `FRONTEND_TWEAK`, tweak is auto-skipped unless backend output indicates it is required.

### Step 7: Finish cycle
If no `PENDING` phases remain, cycle becomes `DONE`.

## Conditional FRONTEND_TWEAK Rule
This project already implements conditional skip logic.

How it works:

- After `BACKEND` completes, runner checks `frontend_tweak_required` in adapter result.
- If not required, `FRONTEND_TWEAK` is marked `SKIPPED`.
- If required, it stays `PENDING` and runner will execute it.

How backend can trigger tweak requirement now:

- Codex adapter scans stdout for `frontend_tweak_required=true`.

## MCP Tool Manual

### `synapse.orchestrate`
Creates a new cycle.

Input example:

```json
{
  "request": "Implement the frontend for feature X, then connect backend",
  "repo_root": "/absolute/path/to/repo",
  "constraints": ["Use existing API style"],
  "plan": {
    "phases": ["FRONTEND", "BACKEND", "FRONTEND_TWEAK"]
  }
}
```

Success output example:

```json
{
  "ok": true,
  "data": {
    "cycle_id": "20260221T120000Z_implement-the-frontend-for-feature-x_ab12cd",
    "status": "QUEUED",
    "phases": [
      { "id": "phase_1_frontend", "type": "FRONTEND", "status": "PENDING", "attempt_count": 0, "max_attempts": 2 },
      { "id": "phase_2_backend", "type": "BACKEND", "status": "PENDING", "attempt_count": 0, "max_attempts": 2 },
      { "id": "phase_3_frontend_tweak", "type": "FRONTEND_TWEAK", "status": "PENDING", "attempt_count": 0, "max_attempts": 2 }
    ]
  }
}
```

### `synapse.status`
Returns one cycle summary.

Input example:

```json
{ "cycle_id": "...", "repo_root": "/absolute/path/to/repo" }
```

Returns status, phase states, current index, artifacts, last error.

### `synapse.logs`
Returns logs for one cycle.

Input example:

```json
{ "cycle_id": "...", "tail": 20 }
```

### `synapse.cancel`
Cancels an active cycle.

Input example:

```json
{ "cycle_id": "...", "reason": "User stopped task" }
```

### `synapse.list`
Lists recent cycles.

Input example:

```json
{ "limit": 10, "status": "RUNNING" }
```

### `synapse.render_prompt`
Returns a reusable text snippet to remind clients how to invoke orchestration.

## Runner Manual

### Command: doctor
Purpose: verify local environment.

Run:

```bash
node dist/runner.js doctor
```

Expected output shape:

```json
{
  "node": "v22.x.x",
  "codex": true,
  "gemini": false
}
```

If `codex` or `gemini` is `false`, that CLI is not available in PATH.

### Command: start
Purpose: continuous worker loop.

Run:

```bash
node dist/runner.js start --poll-ms=500
```

Use `--once` to process at most one claim cycle and exit:

```bash
node dist/runner.js start --once
```

### Command: run
Purpose: process one specific cycle until no runnable phase remains.

Run:

```bash
node dist/runner.js run <cycle_id>
```

Useful for debugging one cycle directly.

## Gemini Adapter (How It Works)
File: `lib/runner/adapters/gemini.ts`.

Modes:

- `stub`: does not call external Gemini CLI. Returns a placeholder report.
- `cli`: executes configured Gemini command.

In `cli` mode, output contract is strict.
Gemini must output JSON containing one of:

1. `patch` with unified diff text.
2. `file_ops` with write/delete operations.

Optional fields:

- `report`
- `frontend_tweak_required`

Safety checks applied:

- File operations cannot escape repo root.
- Patch apply failures return `PATCH_APPLY_FAILED`.

## Codex Adapter (How It Works)
File: `lib/runner/adapters/codexExec.ts`.

Behavior:

- Builds a backend prompt.
- Executes configured backend command (default `codex exec`).
- Captures stdout/stderr.
- Fails on timeout or non-zero exit.
- Sets `frontend_tweak_required` if stdout includes `frontend_tweak_required=true`.

## Safety and Limits
Current safety controls include:

- Repo boundary check for Gemini file ops.
- Command denylist (`denylist_substrings`) in shell execution wrapper.
- Per-phase timeout.
- Per-cycle lock files to reduce concurrent writer collisions.
- Atomic cycle writes.

What this does not yet do:

- It does not sandbox shell commands beyond denylist.
- It does not provide remote authentication; this is local tooling.

## Configuration (Admin Guide)
Config file: `.synapse/config.json`.

Main knobs you can safely tune:

- `checks`: commands to run after each phase type.
- `require_changes`: whether no-file-change should fail a phase.
- `adapters.gemini.mode`: `stub` or `cli`.
- `adapters.gemini.command`: Gemini CLI command string.
- `adapters.codexExec.command`: backend command string, usually starts with `codex exec`.
- `denylist_substrings`: commands/patterns that should be blocked.

Practical first setup:

1. Keep Gemini in `stub` while validating orchestration.
2. Set backend command to your working `codex exec` invocation.
3. Add one cheap check like `npm run build` for `BACKEND`.
4. Later add stricter checks when stable.

## Day-to-Day Procedure

### Procedure: Run one orchestrated request
When to use:

- You want the multi-phase Synapse flow instead of direct ad-hoc coding.

What you need:

- Built project (`npm run build`).
- MCP server running.
- Runner running.

Steps:

1. Start MCP server.

```bash
npm run mcp:start
```

2. Start runner in another terminal.

```bash
node dist/runner.js start --poll-ms=500
```

3. From MCP client, call `synapse.orchestrate` with request.

4. Poll `synapse.status` until terminal state (`DONE`, `FAILED`, `CANCELED`).

5. If needed, inspect `synapse.logs` for details.

What you should see:

- Cycle starts at `QUEUED`, then `RUNNING`, then `DONE` (or `FAILED`).
- Logs include phase claim, running, done/failure messages.

Common mistakes:

- Runner not running: cycle stays `QUEUED`.
- Bad adapter command: phase fails with `ADAPTER_FAILED`.
- Check command fails: phase retries then can become `FAILED`.

## Troubleshooting

### Symptom: Cycle stays `QUEUED` forever
Likely causes:

- Runner process is not started.
- Runner cannot find cycles because wrong `repo_root` is used.

How to check:

- Run `node dist/runner.js doctor`.
- Confirm runner terminal is active.
- Check `synapse.status` for correct `repo_root`.

How to fix:

- Start runner with correct repo path.
- Re-run `synapse.orchestrate` with explicit `repo_root`.

### Symptom: Backend phase fails immediately
Likely causes:

- `codex exec` not installed or not in PATH.
- Backend command in config is invalid.

How to check:

- `node dist/runner.js doctor` and verify `codex: true`.
- Read last error in `synapse.status`.
- View tail logs with `synapse.logs`.

How to fix:

- Install/fix Codex CLI in PATH.
- Update `.synapse/config.json` adapter command.

### Symptom: Gemini phase does nothing
Likely causes:

- Gemini adapter in `stub` mode.

How to check:

- Open `.synapse/config.json`.
- Look at `adapters.gemini.mode`.

How to fix:

- Set mode to `cli`.
- Provide working `adapters.gemini.command`.

### Symptom: Phase fails with `NO_CHANGES`
Likely causes:

- `require_changes` is true for that phase.
- Adapter produced no file changes.

How to check:

- Inspect `.synapse/config.json` -> `require_changes`.

How to fix:

- Disable strict change requirement for that phase, or fix prompt/adapter output so files change.

### Symptom: `CHECK_FAILED`
Likely causes:

- Post-phase check command failed.

How to check:

- Inspect `artifacts.test_results` in `synapse.status` output.

How to fix:

- Fix code or adjust check commands in config.

## How To Extend The System

### Add a new MCP tool
1. Add definition in `lib/mcp/tools.ts`.
2. Add handler mapping in `lib/mcp/handlers.ts`.
3. Implement service logic in `lib/synapse/service.ts` or a new module.
4. Add tests.

### Add a new phase type
1. Extend phase type union in `lib/synapse/types.ts`.
2. Update state machine defaults in `lib/synapse/stateMachine.ts`.
3. Add adapter routing in `lib/runner/service.ts`.
4. Add config support and tests.

### Change retry or timeout policy
- Edit defaults in `lib/synapse/stateMachine.ts`.
- Optional: allow these values from orchestrate input or config in future iterations.

## Where To Change Things (Cheat Sheet)

- Tool contracts: `lib/mcp/tools.ts`
- Tool execution envelope: `lib/mcp/handlers.ts`
- Input validation + service logic: `lib/synapse/service.ts`
- Transition rules and retries: `lib/synapse/stateMachine.ts`
- Persistence and locking: `lib/synapse/store.ts`
- Runner loop: `lib/runner/index.ts`
- Phase execution orchestration: `lib/runner/service.ts`
- Gemini behavior: `lib/runner/adapters/gemini.ts`
- Codex backend behavior: `lib/runner/adapters/codexExec.ts`
- Shell execution safety/timeouts: `lib/runner/command.ts`

## Glossary

MCP:
A protocol for tool-calling between AI clients and local services.

Cycle:
One orchestration job containing multiple phases.

Phase:
A single execution step in a cycle.

Adapter:
A component that executes a phase using a specific external tool/CLI.

Artifact:
Recorded outputs like changed files, commands, and check results.

Claim:
A lock-safe reservation of a phase by one runner.

Terminal status:
A status where execution is finished (`DONE`, `FAILED`, `CANCELED`).

## Final Notes
This repository is currently an MVP orchestrator.

It already gives you:

- Deterministic cycle/phase flow.
- Persisted state and logs.
- Retry and failure behavior.
- MCP control API.
- Runner execution path.

For production-hardening, the next likely improvements are:

1. Strong schema validation with a dedicated library (for example zod).
2. Richer check/report dashboards.
3. Better stale-lock recovery and observability.
