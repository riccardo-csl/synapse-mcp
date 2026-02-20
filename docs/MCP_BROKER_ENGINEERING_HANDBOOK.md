# MCP Broker Engineering Handbook

## Goal
Explain exactly how this MCP broker works end to end, so an engineer who never saw this repository can understand:
- what MCP is in this project
- how requests move through the server
- how cycle/session/lock/handoff state is stored and validated
- how to operate and troubleshoot the system

## Who This Is For
- Backend engineers integrating Codex and Gemini into one workflow
- Platform engineers operating the broker in local repositories
- Engineers extending the broker with new tools or phases

## Quick Summary (2-5 minutes)
This project is a local MCP server that coordinates a two-agent workflow:
- `gemini` (frontend side)
- `codex` (backend side)

The broker enforces:
1. Phase order (`frontend -> backend -> frontend_refine -> complete`)
2. Session authentication per role (`session.open` with role PSK)
3. Lock ownership (`lock.acquire` only for active role)
4. Handoff schema and producer/consumer correctness
5. Structured MCP responses (`{ ok: true|false, ... }`)

All state is file-based and repo-local in `.mcp-broker/`.

---

## What MCP Means Here
MCP (Model Context Protocol) is used as the RPC transport between agent clients and this broker server.

In this codebase:
- Server entrypoint: `index.js`
- Transport: stdio JSON-RPC (`StdioServerTransport`)
- Tool registry: `lib/mcp/tools.js`
- Tool execution: `lib/mcp/handlers.js`

### Runtime Request Path
1. Client calls a tool (for example `handoff.write`) over MCP.
2. `index.js` receives the request and forwards `{ name, args }` to `executeTool`.
3. `executeTool` maps tool name to domain function (`lib/index.js` exports).
4. Domain function reads/writes `.mcp-broker/*`, validates state, and returns data.
5. Server always returns JSON text envelope:
- success: `{ "ok": true, "data": ... }`
- failure: `{ "ok": false, "error": { "code", "message", "details" } }`

This means callers can branch on `ok` and `error.code` without relying on transport exceptions.

---

## Repository Structure

### Top-Level Runtime Files
- `index.js`: MCP server process.
- `cli.js`: local helper CLI for manual operations.
- `lib/broker.js`: compatibility re-export.
- `lib/index.js`: composition root exporting broker operations.

### Domain Split
- `lib/core/`: constants, ids, errors, guards, validators.
- `lib/storage/`: atomic file I/O, path mapping, state bootstrap/load helpers.
- `lib/domains/config/`: config load + PSK validation.
- `lib/domains/session/`: session.open + session token validation and touch.
- `lib/domains/lock/`: lock.acquire and lock checks.
- `lib/domains/cycle/`: cycle.start/status/complete/archive and FSM state handling.
- `lib/domains/handoff/`: handoff schema + handoff read/write behavior.
- `lib/mcp/`: MCP tool definitions and dispatcher.

---

## Core Concepts (Glossary Style)

### Cycle
A single feature workflow instance with a unique `cycle_id`.

### Phase
Current stage of the workflow:
- `frontend`
- `backend`
- `frontend_refine`
- `complete`

### Active Role
The role currently allowed to acquire lock and perform sensitive writes.

### Session Token
A capability token created by `session.open(role, psk)` and stored in `sessions.json`.

### Lock Token
A capability token stored in `lock.json`, required for write/complete/archive operations.

### Handoff
A JSON payload exchanged between roles (`handoff/codex.json` or `handoff/gemini.json`).

---

## Storage Model (Repo-Local Files)

Base directory: `.mcp-broker/`

- `config.json`
- `state.json`
- `lock.json`
- `sessions.json`
- `handoff/codex.json`
- `handoff/gemini.json`
- `archive/<cycle_id>/...`

All writes use atomic write strategy (`tmp -> rename`) in `lib/storage/files.js`.

### `config.json` example
```json
{
  "version": "0.1",
  "mode": "approval",
  "validation": "basic",
  "storage_path": ".mcp-broker",
  "agents": {
    "gemini": { "psk": "GEMINI_SECRET" },
    "codex": { "psk": "CODEX_SECRET" }
  }
}
```

### `state.json` example (active)
```json
{
  "active": true,
  "cycle_id": "20260220T215622Z_featureX",
  "feature": "featureX",
  "phase": "frontend",
  "active_role": "gemini",
  "mode": "approval",
  "created_at": "2026-02-20T21:56:22.000Z",
  "updated_at": "2026-02-20T21:56:22.000Z",
  "handoff_status": {
    "codex": "empty",
    "gemini": "empty"
  }
}
```

### `state.json` example (idle)
```json
{
  "active": false,
  "cycle_id": null,
  "feature": null,
  "phase": null,
  "active_role": null,
  "mode": "approval",
  "created_at": null,
  "updated_at": "2026-02-20T21:58:10.000Z",
  "handoff_status": {
    "codex": "empty",
    "gemini": "empty"
  }
}
```

### `lock.json` example
```json
{
  "locked": true,
  "role": "gemini",
  "lock_token": "<random-hex>",
  "cycle_id": "20260220T215622Z_featureX",
  "acquired_at": "2026-02-20T21:56:22.000Z",
  "expires_at": null
}
```

### `sessions.json` example
```json
{
  "sessions": {
    "sess_abcdef...": {
      "role": "gemini",
      "created_at": "2026-02-20T21:55:59.000Z",
      "last_seen": "2026-02-20T21:56:31.000Z"
    }
  }
}
```

---

## End-to-End Lifecycle (Step by Step)

## Step 0: Configure PSKs
Before sensitive tools can work, `config.json` must include:
- `agents.gemini.psk`
- `agents.codex.psk`

If missing, sensitive operations return `CONFIG_INVALID`.

## Step 1: Open Role Sessions
Each client opens its own session:

Example calls:
```json
{ "name": "session.open", "arguments": { "role": "gemini", "psk": "GEMINI_SECRET" } }
```
```json
{ "name": "session.open", "arguments": { "role": "codex", "psk": "CODEX_SECRET" } }
```

Success response envelope:
```json
{
  "ok": true,
  "data": {
    "session_token": "sess_...",
    "role": "gemini"
  }
}
```

## Step 2: Start Cycle
`cycle.start({ feature })` initializes `state.json`, `lock.json`, and clears handoffs.
Initial state:
- `phase = frontend`
- `active_role = gemini`
- lock role = `gemini`

## Step 3: Active Role Acquires Lock Token
`lock.acquire({ session_token })` checks:
1. session exists
2. cycle active
3. `state.active_role === session.role`
4. lock is held by same role

Then returns current lock token.

## Step 4: Write Handoff
`handoff.write({ target, payload, lock_token, session_token })` checks:
- valid target (`codex|gemini`)
- phase/target allowed by FSM
- session role matches producer for target
- session role equals active role
- lock role equals active role
- provided lock token equals lock token in `lock.json`
- payload schema and payload cycle/feature consistency

If successful:
- handoff file is written (`handoff/codex.json` or `handoff/gemini.json`)
- state updates phase and active_role
- lock rotates to next role when transition requires rotation
- response does **not** include lock token

## Step 5: Complete Cycle
`cycle.complete({ lock_token, session_token })` allowed only in `frontend_refine` by `gemini`.
After complete:
- `phase = complete`
- `active_role = gemini` (important for archive continuity)
- lock remains held by gemini

## Step 6: Archive Cycle
`cycle.archive({ lock_token, session_token })` allowed only when:
- `phase = complete`
- lock held by gemini
- session role is gemini
- lock token matches

Archive operation:
- copies `config/state/lock/handoffs` into `archive/<cycle_id>/`
- writes `manifest.json`
- clears current handoffs
- resets state to idle and lock to unlocked

---

## State Machine Rules

Transitions in `lib/domains/cycle/fsm.js`:

- `frontend + target=codex -> backend` (rotate lock to codex)
- `backend + target=gemini -> frontend_refine` (rotate lock to gemini)
- `frontend_refine + target=codex -> backend` (rework loop, rotate lock to codex)

Completion and archive are explicit operations outside `handoff.write`.

---

## Tool-by-Tool Behavior (with Examples)

## `cycle.start`
Input:
```json
{ "feature": "featureX" }
```
Output `data`:
```json
{
  "cycle_id": "20260220T215622Z_featureX",
  "phase": "frontend",
  "active_role": "gemini",
  "lock_token": "..."
}
```

## `cycle.status`
Returns status snapshot without lock token:
```json
{
  "cycle_id": "...",
  "phase": "backend",
  "active_role": "codex",
  "mode": "approval",
  "handoffs": {
    "codex": { "status": "present", "updated_at": "..." },
    "gemini": { "status": "empty", "updated_at": null }
  },
  "lock": { "locked": true, "role": "codex" }
}
```

## `session.open`
Validates role and PSK from config and creates session token.

Failure example:
```json
{
  "ok": false,
  "error": {
    "code": "AUTH_FAILED",
    "message": "Invalid role credentials.",
    "details": { "role": "gemini" }
  }
}
```

## `lock.acquire`
Input:
```json
{ "session_token": "sess_..." }
```
Success:
```json
{
  "ok": true,
  "data": {
    "cycle_id": "...",
    "role": "codex",
    "lock_token": "..."
  }
}
```

Failure when non-active role asks for lock:
```json
{
  "ok": false,
  "error": {
    "code": "LOCK_DENIED",
    "message": "role is not active for the current phase",
    "details": {
      "activeRole": "codex",
      "requestedRole": "gemini"
    }
  }
}
```

## `handoff.read`
Returns full handoff payload if present, or `{}`.
No auth/session required.

## `handoff.write`
Input includes `target`, `payload`, `lock_token`, `session_token`.

Security property:
- response never returns a lock token

Success response:
```json
{
  "ok": true,
  "data": {
    "ok": true,
    "phase": "backend",
    "active_role": "codex",
    "next_step": "Provide lock_token to codex"
  }
}
```

## `cycle.complete`
Gemini-only completion from `frontend_refine`.

## `cycle.archive`
Gemini-only archive from `complete`.

---

## Handoff Schema (Practical)
A valid payload must include:
- `cycle_id` (non-empty string, must match current cycle)
- `feature` (non-empty string, must match current feature)
- `producer` / `consumer` (must match target direction)
- arrays: `files_modified`, `endpoints`, `data_shapes`, `assumptions`, `todos`, `notes`
- optional `extras` object

### Producer/Consumer mapping
- target `codex` => producer must be `gemini`, consumer must be `codex`
- target `gemini` => producer must be `codex`, consumer must be `gemini`

---

## Authorization Matrix

### session.open
- Requires: valid `role`, valid `psk`

### lock.acquire
- Requires: valid `session_token`
- Requires role alignment: `session.role == state.active_role == lock.role`

### handoff.write
- Requires valid session token
- Requires role to be active
- Requires role to match producer implied by `target`
- Requires correct lock token

### cycle.complete
- Requires valid session token for gemini
- Requires lock token for gemini
- Requires `phase=frontend_refine`

### cycle.archive
- Requires valid session token for gemini
- Requires gemini lock token
- Requires `phase=complete`

---

## Error Codes You Should Handle
Common machine-readable codes:
- `CONFIG_INVALID`
- `AUTH_FAILED`
- `INVALID_ROLE`
- `INVALID_SESSION`
- `INVALID_TARGET`
- `NO_ACTIVE_CYCLE`
- `CYCLE_ALREADY_ACTIVE`
- `INVALID_PHASE`
- `LOCK_DENIED`
- `ARCHIVE_NOT_ALLOWED`
- `SCHEMA_INVALID`
- `INVALID_TOOL`
- `INTERNAL_ERROR`

Caller pattern:
1. Parse tool response envelope
2. If `ok=false`, branch by `error.code`
3. Never parse user text strings for control logic

---

## Daily Operational Procedures

## Procedure: Start a New Feature Cycle
What you need:
- config with PSKs
- both clients able to call MCP tools

Steps:
1. `session.open` for gemini
2. `session.open` for codex
3. `cycle.start({ feature })`
4. gemini `lock.acquire`
5. gemini `handoff.write(target="codex", ...)`
6. codex `lock.acquire`
7. codex `handoff.write(target="gemini", ...)`
8. repeat rework loop as needed
9. gemini `cycle.complete`
10. gemini `lock.acquire` (optional re-acquire)
11. gemini `cycle.archive`

Expected result:
- `.mcp-broker/archive/<cycle_id>/` created
- current state reset to idle

## Procedure: Diagnose a Failed Write
If `handoff.write` fails:
1. inspect `error.code`
2. if `LOCK_DENIED`: call `cycle.status`, verify active role, then call `lock.acquire` with active session
3. if `INVALID_PHASE`: verify target matches current phase
4. if `SCHEMA_INVALID`: verify payload fields and producer/consumer mapping

---

## Troubleshooting

## Symptom: `CONFIG_INVALID`
Likely cause:
- `config.json` missing `agents.gemini.psk` or `agents.codex.psk`

Fix:
- update `.mcp-broker/config.json` with both PSKs

## Symptom: `INVALID_SESSION`
Likely cause:
- expired/typo/unknown session token

Fix:
- call `session.open` again for that role and use new `session_token`

## Symptom: `LOCK_DENIED` after phase transition
Likely cause:
- using old lock token after lock rotation
- role is not currently active

Fix:
1. call `cycle.status`
2. active role calls `lock.acquire`
3. retry with returned token

## Symptom: `INVALID_PHASE` on `handoff.write`
Likely cause:
- target does not match legal transition for current phase

Fix:
- check phase and use correct target per FSM table

## Symptom: `ARCHIVE_NOT_ALLOWED`
Likely cause:
- trying to archive before completion

Fix:
- ensure `cycle.complete` succeeded and phase is `complete`

---

## How to Run and Validate

Install dependencies:
```bash
npm install
```

Run both smoke suites:
```bash
npm test
```

Run only broker smoke:
```bash
npm run smoke:broker
```

Run only MCP client smoke:
```bash
npm run smoke:mcp
```

---

## Where to Change Things

### Add or modify a tool
- schema: `lib/mcp/tools.js`
- dispatch behavior: `lib/mcp/handlers.js`
- business logic: domain service in `lib/domains/*/service.js`

### Change auth/session rules
- `lib/domains/session/service.js`
- `lib/domains/lock/service.js`
- `lib/domains/handoff/service.js`
- `lib/domains/cycle/service.js`

### Change FSM transitions
- `lib/domains/cycle/fsm.js`

### Change payload validation
- `lib/domains/handoff/schema.js`

### Change file layout or atomic persistence
- `lib/storage/paths.js`
- `lib/storage/files.js`
- `lib/storage/state-store.js`

---

## Glossary
- MCP: protocol used by client and server to exchange tool calls and responses.
- Tool: named operation exposed by MCP server (`cycle.start`, `handoff.write`, etc.).
- Session token: role-auth capability obtained via PSK.
- Lock token: write capability for active role within the cycle.
- Active role: role currently allowed to mutate workflow state.
- Handoff: structured payload sent from one role to the other.
- Archive: persisted snapshot of one completed cycle.

---

## Final Notes
This broker is intentionally strict and stateful. It is designed to fail early with explicit error codes instead of silently accepting invalid order, invalid identity, or malformed payloads. If you integrate clients, always consume `ok/error.code`, never assume operation ordering, and reacquire lock tokens after role transitions.
