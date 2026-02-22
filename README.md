# synapse-mcp

Local MCP orchestrator for multi-agent workflows (Gemini frontend + Codex backend).

## What It Does

`synapse-mcp` provides:

1. An MCP stdio server with orchestration tools.
2. A local runner that executes cycle phases and updates persisted state.

Default phase flow:

1. `FRONTEND` (Gemini adapter)
2. `BACKEND` (Codex adapter via `codex exec`)
3. `FRONTEND_TWEAK` (Gemini adapter, skipped unless backend signals it)

## MCP Tools

- `synapse.orchestrate`
- `synapse.status`
- `synapse.logs`
- `synapse.cancel`
- `synapse.list`
- `synapse.render_prompt`

All tool responses are wrapped as:

- success: `{ "ok": true, "data": ... }`
- error: `{ "ok": false, "error": { "code", "message", "details" } }`

## Storage

Repo-local state under `.synapse/`:

- `.synapse/config.json`
- `.synapse/cycles/<cycle_id>.json`
- `.synapse/locks/<cycle_id>.lock`

Writes are atomic (`tmp -> rename`).

## Setup

```bash
npm install
npm run build
```

## Run MCP Server

```bash
npm run mcp:start
# or
node dist/index.js
```

## Run Runner

```bash
npm run runner:doctor
node dist/runner.js start --poll-ms=500
node dist/runner.js start --once
node dist/runner.js run <cycle_id>
```

Runner commands:

- `synapse-runner start [--once] [--poll-ms=500] [--repo-root=/path]`
- `synapse-runner run <cycle_id> [--repo-root=/path]`
- `synapse-runner doctor [--repo-root=/path]`
- `synapse-runner health [--repo-root=/path]`

## Config

Runner config is `.synapse/config.json`.

On first run, defaults are created:

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
      "command": "gemini"
    },
    "codexExec": {
      "command": "codex exec"
    }
  },
  "locks": {
    "ttl_ms": 20000,
    "heartbeat_ms": 5000,
    "takeover_grace_ms": 2000
  },
  "denylist_substrings": [
    "rm -rf /",
    "git reset --hard",
    "git clean -fdx"
  ]
}
```

Notes:

- Set `adapters.gemini.mode` to `cli` to execute Gemini CLI.
- Backend adapter runs `${adapters.codexExec.command} "<prompt>"`.
- Lock behavior:
  - runner acquires per-cycle lock before claim/transition writes
  - runner now keeps the lock lease during full phase execution (adapter + checks + finalize)
  - lock heartbeat extends lock while a phase is running
  - stale locks are automatically taken over after `expires_at + takeover_grace_ms`
  - stale in-memory phase claims (`CLAIMED`/`RUNNING`) are reclaimed automatically before re-execution
- Persisted cycle/config/lock payloads are schema-validated (zod) before use.
- `schema_version` is enforced for persisted files:
  - newer unsupported versions return `UNSUPPORTED_VERSION`
  - malformed/incompatible payloads return `*_CORRUPT` or `CONFIG_INVALID`

## Codex MCP Config Example

Add to `.codex/config.toml`:

```toml
[mcp_servers.synapse]
command = "node"
args = ["/absolute/path/to/repo/dist/index.js"]
```

## Usage Pattern (Opt-In)

Use orchestration only when explicitly requested in your prompt:

- "Implement the frontend for feature X, **use synapse-mcp**"

If you do not include that instruction, use normal direct coding flow.

## Tests

```bash
npm test
npm run test:unit
npm run test:integration
```

## Current MVP Notes

- Gemini adapter supports `stub` mode and `cli` mode.
- In `cli` mode, Gemini must output JSON containing either:
  - `patch` (unified diff), or
  - `file_ops` (`write`/`delete` operations),
  plus an optional `report` object.
- Gemini patch flow now runs `git apply --check` before `git apply`.
- Gemini parser prefers `SYNAPSE_RESULT_JSON: {...}` when present; otherwise it selects the last schema-valid JSON object from stdout.
- Codex backend adapter supports an optional structured trailer:
  - `SYNAPSE_RESULT_JSON: {"frontend_tweak_required":true,"report":{...}}`
- Cycle artifacts include per-phase duration and attempt history for diagnostics.
- Retry policy is code-driven:
  - retryable: `PHASE_TIMEOUT`, `LOCK_HELD`, `CHECK_FAILED`, `ADAPTER_FAILED`
  - terminal (no retry): `SCHEMA_INVALID`, `ADAPTER_OUTPUT_PARSE_FAILED`, `ADAPTER_OUTPUT_INVALID`, `PATCH_INVALID`, `PATCH_APPLY_FAILED`, `REPO_BOUNDARY`, `COMMAND_BLOCKED`, `CONFIG_INVALID`, `CYCLE_CORRUPT`
- Cancellation:
  - `synapse.cancel` during a running phase triggers in-flight process abort (`SIGKILL`) and keeps cycle state `CANCELED`.
