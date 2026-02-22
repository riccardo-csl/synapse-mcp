# Synapse Operations Guide

## What This Covers

This document explains operational behavior for the runner and storage layer:

- schema validation boundaries
- lock lifecycle (acquire, heartbeat, stale takeover)
- failure/retry signals
- diagnostics commands

## Validation Boundaries

Synapse validates these objects with zod before using them:

- MCP tool inputs and outputs
- `.synapse/config.json`
- `.synapse/cycles/*.json`
- `.synapse/locks/*.lock`
- Gemini structured adapter output
- optional Codex structured trailer output

Invalid persisted cycle files fail with `CYCLE_CORRUPT`.
Invalid config fails with `CONFIG_INVALID`.
Unsupported persisted schema versions fail with `UNSUPPORTED_VERSION`.

Persisted files use `schema_version` (current: `1`):

- `.synapse/config.json`
- `.synapse/cycles/<cycle_id>.json`
- `.synapse/locks/<cycle_id>.lock`

## Locking Model

Each cycle has a file lock at `.synapse/locks/<cycle_id>.lock`.

Lock fields:

- `owner_id`
- `pid`
- `heartbeat_at`
- `expires_at`

Behavior:

1. Runner acquires lock before claim/transition writes.
2. Runner keeps lock lease for full phase execution (run adapter, checks, then finalize state write).
3. While lock is held, heartbeat refreshes `heartbeat_at` and `expires_at`.
4. If lock exists and is fresh, other runners wait until timeout (`LOCK_HELD`).
5. If lock is stale (`now > expires_at + takeover_grace_ms`), runner takes over lock and proceeds.
6. If lock JSON is malformed, runner quarantines lock file (`*.corrupt.*`) and retries acquisition.
7. If cycle phase is left in stale `CLAIMED`/`RUNNING` state (crash/restart), runner reclaims it to `PENDING` and re-claims safely.

Config knobs:

- `locks.ttl_ms`
- `locks.heartbeat_ms`
- `locks.takeover_grace_ms`

## Retry/Failure Behavior

- Phase retries are controlled by per-phase `max_attempts`.
- On non-terminal failure with attempts remaining, phase returns to `PENDING`.
- On final failure, phase becomes `FAILED` and cycle becomes `FAILED`.
- Cycle artifacts track:
  - `phase_durations_ms`
  - `attempt_history` with outcomes `DONE | RETRY | FAILED`

## Adapter Contracts

### Gemini (`FRONTEND`, `FRONTEND_TWEAK`)

Gemini must return JSON with exactly one mode:

- `patch` (unified diff), or
- `file_ops` (`write` / `delete`)

Failure codes:

- `ADAPTER_OUTPUT_PARSE_FAILED`
- `ADAPTER_OUTPUT_INVALID`
- `PATCH_INVALID`
- `PATCH_APPLY_FAILED`

Parser strategy:

- If `SYNAPSE_RESULT_JSON:` marker exists, parse marker payload.
- Otherwise parse JSON candidates from stdout and accept the last schema-valid payload.

### Codex (`BACKEND`)

Codex runs via configured `codex exec` command.

Optional structured trailer:

`SYNAPSE_RESULT_JSON: {...}`

If present, trailer JSON is validated. If missing, Synapse falls back to text heuristics (`frontend_tweak_required=true`).

## Diagnostics

Commands:

- `synapse-runner doctor`
- `synapse-runner health`

`doctor` reports dependency availability (`codex`, `gemini`), storage paths, cycle counts, and lock config.
`health` reports process/runtime info for supervision checks.

## Retry Policy

Retryable phase failures:

- `PHASE_TIMEOUT`
- `LOCK_HELD`
- `CHECK_FAILED`
- `ADAPTER_FAILED`

Terminal phase failures (no retry):

- `SCHEMA_INVALID`
- `ADAPTER_OUTPUT_PARSE_FAILED`
- `ADAPTER_OUTPUT_INVALID`
- `PATCH_INVALID`
- `PATCH_APPLY_FAILED`
- `REPO_BOUNDARY`
- `COMMAND_BLOCKED`
- `CONFIG_INVALID`
- `CYCLE_CORRUPT`

## In-flight Cancellation

Runner polls cycle status during adapter/check execution.

- When cycle becomes `CANCELED`, runner aborts active child process.
- Child processes are terminated with `SIGKILL`.
- Phase is not advanced to `DONE`; cycle remains `CANCELED`.
