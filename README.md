# synapse-mcp

Synapse is a local orchestration system for multi-agent coding workflows.

In plain terms:

- Codex acts as the orchestrator-facing agent (it talks to the Synapse MCP server).
- Gemini acts as a phase worker (mainly frontend generation).
- A separate local runner executes the phases and writes state to disk.
- Everything is stored in your project repo under `.synapse/`.

This repository contains both:

- an MCP server (`synapse-mcp`) that exposes orchestration tools
- a runner CLI (`synapse-runner`) that actually executes the work

## Goal (What This Tool Is For)

Synapse helps you run a structured workflow like:

1. Gemini does frontend work
2. Codex does backend work
3. Gemini optionally tweaks frontend after backend changes

This is useful when you want:

- repeatable multi-step workflows
- persisted state (so you can inspect what happened)
- retries, timeouts, cancellation, and recovery
- a tool interface (MCP) instead of manual handoff files

## Who This Is For

This README is written for:

- developers who want to use Synapse in a project repo
- people using Codex CLI + Gemini CLI
- engineers debugging reliability issues in the orchestration flow

You do not need to know MCP internals to use it.

## The Mental Model (Very Important)

Synapse has two separate parts:

### 1) MCP Server (control plane)

The MCP server exposes tools like:

- `synapse.orchestrate`
- `synapse.status`
- `synapse.logs`
- `synapse.cancel`

Codex calls these tools.

The MCP server does **not** run the phases itself.

### 2) Runner (execution plane)

The runner process:

- reads the queued cycles
- claims the next phase
- runs Gemini or Codex adapters
- runs checks (lint/test/build if configured)
- updates `.synapse` state

If the runner is not running, the cycle will be created but nothing will execute.

## What Gets Stored (and Where)

Synapse stores state inside the target project repo (repo-local) under `.synapse/`.

Typical layout:

```text
.synapse/
  config.json
  cycles/
    <cycle_id>.json
  locks/
    <cycle_id>.lock
```

What these files mean:

- `config.json`: runner configuration (adapters, locks, checks, limits)
- `cycles/*.json`: full cycle state, phases, logs, artifacts, errors
- `locks/*.lock`: per-cycle execution lock files (temporary, used during active runs)

Writes are atomic (`tmp -> rename`) to reduce corruption risk.

## Default Workflow (What Synapse Runs)

If you do not force a custom phase plan, Synapse typically runs:

1. `FRONTEND` (Gemini adapter)
2. `BACKEND` (Codex adapter via `codex exec`)
3. `FRONTEND_TWEAK` (Gemini adapter, skipped unless needed)

The runner tracks phase status (`PENDING`, `RUNNING`, `DONE`, `FAILED`, etc.) and cycle status (`RUNNING`, `DONE`, `FAILED`, `CANCELED`).

## Quick Start (Single Repo)

Use this if you want to try Synapse inside this same repo.

### 1) Install and build

```bash
npm install
npm run build
```

### 2) Start the runner

```bash
node dist/runner.js start
```

### 3) Start the MCP server

In another terminal:

```bash
node dist/index.js
```

### 4) Connect Codex to the MCP server

Add this to `.codex/config.toml` in the repo where you run Codex:

```toml
[mcp_servers.synapse]
command = "node"
args = ["/absolute/path/to/this-repo/dist/index.js"]
```

### 5) Ask Codex to use Synapse (opt-in)

Example prompt:

- `Implement feature X, use synapse-mcp`

Codex should then call Synapse tools automatically (you do not need to name each tool).

## Recommended Real Setup (Two Repos)

This is the setup most people want:

- Repo A: this Synapse codebase (`synapse-mcp`)
- Repo B: your actual project (for example `PM_SaaS`)

### What runs where

- Synapse code runs from Repo A
- Synapse state (`.synapse/`) is created in Repo B

### Step 1) Build Synapse in Repo A

```bash
cd /path/to/synapse-mcp
npm install
npm run build
```

### Step 2) Start the runner and point it at Repo B

```bash
cd /path/to/synapse-mcp
node dist/runner.js start --repo-root=/path/to/project-repo
```

### Step 3) Configure Codex in Repo B to use Synapse MCP server from Repo A

In Repo B (`/path/to/project-repo/.codex/config.toml`):

```toml
[mcp_servers.synapse]
command = "node"
args = ["/path/to/synapse-mcp/dist/index.js"]
```

### Step 4) Use Synapse in Codex (opened in Repo B)

Example:

- `Implement the frontend for feature X, use synapse-mcp`

Synapse will store cycle files in:

- `/path/to/project-repo/.synapse/`

## Day-to-Day Usage (Operator View)

This is the normal operating loop.

### Start a session

1. Start the runner
2. Make sure the MCP server is configured in Codex
3. Ask Codex to use Synapse (`use synapse-mcp`)

### Watch what is happening

You can inspect progress in three ways:

- via MCP tools (`synapse.status`, `synapse.logs`)
- via runner report (`synapse-runner report <cycle_id>`)
- via live runner logs (`synapse-runner logs <cycle_id> --follow`)

### If something fails

1. Inspect `synapse-runner report <cycle_id>`
2. Check `synapse.logs` or `synapse-runner logs`
3. Fix config/adapter issue or rerun a new cycle

## MCP Tools (What Codex Uses)

The MCP server exposes these tools:

- `synapse.orchestrate`
- `synapse.status`
- `synapse.logs`
- `synapse.cancel`
- `synapse.list`
- `synapse.render_prompt`

### Tool response shape

All MCP tool responses are normalized:

- success: `{ "ok": true, "data": ... }`
- error: `{ "ok": false, "error": { "code", "message", "details" } }`

This makes failures easier to automate and debug.

### 1) `synapse.orchestrate`

Creates a new cycle and queues phases.

Input (example):

```json
{
  "request": "Implement the frontend for feature X and then connect the backend",
  "repo_root": "/path/to/project-repo",
  "constraints": ["Do not change auth", "Keep existing design system"]
}
```

Output (shape summary):

- `cycle_id`
- `status`
- phase summaries

### 2) `synapse.status`

Reads the current status of a cycle.

Input:

```json
{
  "cycle_id": "20260223T175823Z_example_abcd12",
  "repo_root": "/path/to/project-repo"
}
```

Use this for polling during execution.

### 3) `synapse.logs`

Reads cycle logs (optionally tailed).

Input:

```json
{
  "cycle_id": "20260223T175823Z_example_abcd12",
  "tail": 20,
  "repo_root": "/path/to/project-repo"
}
```

Use this when `status` is not enough (errors, retries, stalls).

### 4) `synapse.cancel`

Cancels a queued or running cycle.

Input:

```json
{
  "cycle_id": "20260223T175823Z_example_abcd12",
  "reason": "Stopping this run because config is wrong",
  "repo_root": "/path/to/project-repo"
}
```

If a phase is running, Synapse sends `SIGTERM`, then `SIGKILL` after the configured grace period if needed.

### 5) `synapse.list`

Lists recent cycles (optionally filtered by status).

Input example:

```json
{
  "limit": 10,
  "status": "FAILED",
  "repo_root": "/path/to/project-repo"
}
```

### 6) `synapse.render_prompt`

Returns a user-facing prompt snippet that tells Codex to use Synapse orchestration correctly.

Useful when setting up instructions or templates.

## Runner CLI (What You Run Manually)

The runner CLI is `synapse-runner` (or `node dist/runner.js`).

### Commands

- `synapse-runner start [--once] [--poll-ms=500] [--repo-root=/path]`
- `synapse-runner run <cycle_id> [--repo-root=/path]`
- `synapse-runner doctor [--repo-root=/path]`
- `synapse-runner health [--repo-root=/path]`
- `synapse-runner report <cycle_id> [--repo-root=/path]`
- `synapse-runner logs <cycle_id> [--tail=N] [--follow] [--poll-ms=1000] [--repo-root=/path]`
- `synapse-runner migrate [--dry-run] [--repo-root=/path]`

### Command examples

Run continuous runner for another repo:

```bash
node dist/runner.js start --repo-root=/path/to/project-repo
```

Run one execution loop only (good for debugging):

```bash
node dist/runner.js start --once --repo-root=/path/to/project-repo
```

Run a specific cycle manually:

```bash
node dist/runner.js run <cycle_id> --repo-root=/path/to/project-repo
```

Check environment and config:

```bash
node dist/runner.js doctor --repo-root=/path/to/project-repo
node dist/runner.js health --repo-root=/path/to/project-repo
```

Get a structured summary of one cycle:

```bash
node dist/runner.js report <cycle_id> --repo-root=/path/to/project-repo
```

Tail cycle logs once (JSON output):

```bash
node dist/runner.js logs <cycle_id> --repo-root=/path/to/project-repo --tail=20
```

Watch cycle logs live until it finishes:

```bash
node dist/runner.js logs <cycle_id> --repo-root=/path/to/project-repo --tail=20 --follow
```

Check schema migrations:

```bash
node dist/runner.js migrate --dry-run --repo-root=/path/to/project-repo
node dist/runner.js migrate --repo-root=/path/to/project-repo
```

## Configuration (`.synapse/config.json`)

Synapse creates a default config on first run if none exists.

This file is per target project repo.

Example (current default shape, shortened comments removed):

```json
{
  "schema_version": 1,
  "storage_dir": ".synapse",
  "checks": {
    "FRONTEND": [],
    "BACKEND": [],
    "FRONTEND_TWEAK": []
  },
  "require_changes": {
    "FRONTEND": false,
    "BACKEND": true,
    "FRONTEND_TWEAK": false
  },
  "adapters": {
    "gemini": {
      "mode": "stub",
      "command": "gemini",
      "require_marker": false,
      "max_output_bytes": 1000000,
      "max_patch_bytes": 500000,
      "max_file_ops": 100,
      "max_file_op_bytes": 300000,
      "repair_retry_on_invalid_output": false,
      "max_repair_attempts": 1,
      "stream_output_to_runner": false,
      "stream_output_to_synapse_logs": false
    },
    "codexExec": {
      "command": "codex exec",
      "require_marker": false
    }
  },
  "locks": {
    "ttl_ms": 20000,
    "heartbeat_ms": 5000,
    "takeover_grace_ms": 2000,
    "pid_liveness_check": true
  },
  "cancellation": {
    "term_grace_ms": 1500
  },
  "denylist_substrings": [
    "rm -rf /",
    "git reset --hard",
    "git clean -fdx"
  ]
}
```

### The most important config settings (practical explanation)

#### `adapters.gemini.mode`

- `"stub"`: fake/simulated Gemini behavior (good for tests)
- `"cli"`: actually runs Gemini CLI

For real usage, set:

```json
{ "adapters": { "gemini": { "mode": "cli" } } }
```

#### `adapters.gemini.command`

Command Synapse runs for Gemini phases.

Synapse appends the prompt text to this command, so for non-interactive use you usually want Gemini CLI prompt mode in the command itself.

Example:

```json
{
  "adapters": {
    "gemini": {
      "command": "gemini -m gemini-3-pro-preview -p"
    }
  }
}
```

#### `adapters.*.require_marker` (recommended = `true`)

When enabled, adapters require a structured output marker instead of guessing/parsing loose output.

This improves reliability.

Recommended:

```json
{
  "adapters": {
    "gemini": { "require_marker": true },
    "codexExec": { "require_marker": true }
  }
}
```

#### Gemini output safety limits

These protect you from huge or malformed outputs:

- `max_output_bytes`
- `max_patch_bytes`
- `max_file_ops`
- `max_file_op_bytes`
- `repair_retry_on_invalid_output`
- `max_repair_attempts`

Recommended for real Gemini usage:

```json
{
  "adapters": {
    "gemini": {
      "require_marker": true,
      "repair_retry_on_invalid_output": true,
      "max_repair_attempts": 1
    }
  }
}
```

To see Gemini's visible CLI output live in the runner terminal (for human monitoring), enable:

```json
{
  "adapters": {
    "gemini": {
      "stream_output_to_runner": true
    }
  }
}
```

Quick one-off override (without editing config):

```bash
SYNAPSE_GEMINI_STREAM_OUTPUT_TO_RUNNER=1 node dist/runner.js start --repo-root=/path/to/project-repo
```

To make Gemini visible output available to Codex via `synapse.logs` / `synapse-runner logs`, enable:

```json
{
  "adapters": {
    "gemini": {
      "stream_output_to_synapse_logs": true
    }
  }
}
```

This writes truncated/rate-limited Gemini stdout/stderr snippets into the cycle event log (for monitoring), in addition to normal phase lifecycle events.

#### `checks`

Commands to run after a phase completes.

Example:

```json
{
  "checks": {
    "FRONTEND": ["pnpm lint --filter web", "pnpm test --filter web"],
    "BACKEND": ["pnpm lint --filter api", "pnpm test --filter api"],
    "FRONTEND_TWEAK": ["pnpm lint --filter web"]
  }
}
```

#### `require_changes`

If `true`, Synapse fails the phase when no repo changes are detected.

Default:

- backend requires changes
- frontend/frontend_tweak do not

#### Lock settings (`locks.*`)

These control lock TTL, heartbeat, and stale takeover behavior.

You usually do not need to change them unless you have:

- very slow machines
- sleep/resume issues
- long-running commands

#### `cancellation.term_grace_ms`

How long Synapse waits after `SIGTERM` before using `SIGKILL`.

## How Gemini and Codex Are Used (Current Design)

This is a common point of confusion, so here is the exact split:

### Codex

Codex is the orchestration-facing agent.

It uses Synapse MCP tools:

- create cycles
- check status
- check logs
- cancel if needed

### Gemini

Gemini is a phase worker (adapter subprocess), not an MCP client in this architecture.

Synapse runs Gemini CLI during `FRONTEND` / `FRONTEND_TWEAK` and validates its structured output.

This design is intentional:

- Codex handles tool orchestration
- Gemini handles frontend generation inside a strict contract

## Reliability Features (What Synapse Already Handles)

Synapse is designed to be reliable for local workflows. Important built-in behavior:

- atomic file writes (`tmp -> rename`)
- persisted cycle state in JSON
- schema validation (Zod) for config/cycle/lock files
- schema version checks (`UNSUPPORTED_VERSION` vs corrupt payloads)
- lock heartbeat + stale lock takeover
- PID liveness check before stale takeover (best-effort safety)
- timeout handling
- cancellation with `SIGTERM` -> `SIGKILL` escalation
- retries for retryable errors
- terminal failure for non-retryable errors
- migration tooling for stored data (`migrate`)

### Gemini-specific hardening (recent)

- strict marker parsing support
- BEGIN/END marker block support
- duplicate `file_ops` path rejection
- patch pre-check (`git apply --check`)
- output size and file-op limits
- optional repair retry on invalid output
- capacity/quota error classification (`ADAPTER_CAPACITY_EXHAUSTED`)
- fail-fast behavior for capacity exhaustion (avoids burning retries)

## Understanding Failures (What to Look At First)

When a cycle fails, use this order:

### 1) `report` (best summary)

```bash
node dist/runner.js report <cycle_id> --repo-root=/path/to/project-repo
```

Look for:

- `status`
- phase statuses
- `errors.last_error.code`
- `errors.recommended_action`
- `errors.hint`

### 2) `logs` (details)

```bash
node dist/runner.js logs <cycle_id> --repo-root=/path/to/project-repo --tail=50
```

### 3) Raw cycle file (full truth)

- `.synapse/cycles/<cycle_id>.json`

This contains everything:

- phases
- logs
- artifacts
- last error
- attempts

## Common Problems and What They Mean

### Gemini capacity / quota errors

Symptoms:

- Gemini stderr mentions `429`, `RESOURCE_EXHAUSTED`, `MODEL_CAPACITY_EXHAUSTED`, `rateLimitExceeded`
- cycle fails with `ADAPTER_CAPACITY_EXHAUSTED`

What Synapse does:

- fails fast (no phase retry burn)

What you should do:

- retry later
- switch Gemini model
- verify Gemini CLI auth/quota/provider status

### Cycle created but nothing runs

Usually means:

- runner is not running

Fix:

- start `synapse-runner`

### Codex cannot use Synapse tools

Usually means:

- `.codex/config.toml` does not include the Synapse MCP server
- wrong path to `dist/index.js`

Fix:

- update `.codex/config.toml`
- rebuild Synapse (`npm run build`)

### Stale lock / lock held

Synapse already handles stale takeover, but if something looks stuck:

1. inspect `report` and `logs`
2. inspect `.synapse/locks/`
3. verify no old runner process is still alive

## Observer Workflow (Optional, for Reliability Testing)

This repo includes an observer helper script and docs to help a second Codex session monitor Synapse reliability.

Helper command:

```bash
npm run observer:target -- --repo-root=/path/to/project-repo
```

This does **not** spawn Codex. It only prints a target cycle and checklist for a human/observer agent.

Related files:

- `scripts/synapse-observer-helper.mjs`
- `diagnostics/templates/SYNAPSE_OBSERVER_REPORT_TEMPLATE.md`
- `docs/CODEX_SYNAPSE_ORCHESTRATION_POLICY.md`

## Development and Testing (for This Repo)

### Build

```bash
npm run build
```

### Tests

```bash
npm test
npm run test:unit
npm run test:integration
npm run test:e2e
```

Notes:

- `test:e2e` is optional
- it only runs when `E2E=1`
- use `E2E_CODEX_CMD` to provide a real backend command for true E2E

## Scripts Included in `package.json`

- `npm run mcp:start` (build + start MCP server)
- `npm run runner:start` (build + start runner)
- `npm run runner:doctor` (build + doctor)
- `npm run runner:health` (build + health)
- `npm run runner:migrate` (build + migrate `--dry-run`)
- `npm run observer:target` (observer helper)

These are convenience commands. For multi-repo usage, `node dist/runner.js ... --repo-root=...` is often clearer.

## Recommended First Real Run (Copy/Paste)

Replace the paths with your own.

### Terminal 1: runner

```bash
cd /path/to/synapse-mcp
npm run build
node dist/runner.js start --repo-root=/path/to/project-repo
```

### Codex session (opened in project repo)

Make sure `.codex/config.toml` points to Synapse MCP server, then prompt:

- `Implement feature X, use synapse-mcp`

### Terminal 2: live logs (optional)

```bash
cd /path/to/synapse-mcp
node dist/runner.js logs <cycle_id> --repo-root=/path/to/project-repo --tail=20 --follow
```

### If it fails

```bash
node dist/runner.js report <cycle_id> --repo-root=/path/to/project-repo
node dist/runner.js logs <cycle_id> --repo-root=/path/to/project-repo --tail=50
```

## Current Scope / Non-Goals (So Expectations Are Clear)

Synapse is already usable, but it is still a local orchestrator for developer workflows.

It is not currently:

- a hosted service
- a GUI dashboard
- an event-streaming system
- a replacement for CI/CD orchestration

It is a local, reliable, inspectable orchestration tool for multi-agent coding workflows.

## Glossary (Simple Terms)

### Cycle

One orchestrated job (for example: implement one feature request).

### Phase

One step inside a cycle (`FRONTEND`, `BACKEND`, `FRONTEND_TWEAK`).

### Runner

The local process that executes phases and updates state.

### MCP server

The tool server Codex connects to in order to create/check/cancel cycles.

### Adapter

Code that runs an external tool (Gemini CLI or `codex exec`) and translates its output into Synapse’s structured format.

### `.synapse/`

The repo-local storage folder where Synapse keeps config, cycle files, and locks.
