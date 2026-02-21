# MCP Broker (Gemini/Codex)

## Configure PSKs

Set role credentials in `.mcp-broker/config.json`:

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

If either PSK is missing, broker auth-sensitive operations fail with `CONFIG_INVALID`.

## Agent Flow

1. Open role session: `session.open({ role, psk })` -> `session_token`
2. Active role acquires lock: `lock.acquire({ session_token })` -> `lock_token`
3. Write handoff: `handoff.write({ target, payload, lock_token, session_token })`
4. Complete cycle (Gemini in `frontend_refine`): `cycle.complete({ lock_token, session_token })`
5. Archive cycle (Gemini in `complete`): `cycle.archive({ lock_token, session_token })`

## Security Notes

- `handoff.write` never returns lock tokens.
- `cycle.status` never includes lock token.
- Session role is enforced for `lock.acquire`, `handoff.write`, `cycle.complete`, and `cycle.archive`.
- Session state is persisted in `.mcp-broker/sessions.json`.

## Internal Module Layout

- `lib/core/` shared primitives (constants, errors, ids, guards, validators)
- `lib/storage/` atomic file I/O, path mapping, and state stores
- `lib/domains/config|session|lock|cycle|handoff/` domain logic and state machine rules
- `lib/mcp/` tool definitions and MCP dispatch helpers
- `lib/index.ts` composition root
- `lib/broker.ts` compatibility re-export

## Build

- `npm run build` compiles TypeScript sources to `dist/`.
- Runtime entrypoint is `dist/index.js`.

## Tests

- `npm test` runs all tests under `test/` (unit + integration).
- `npm run test:unit` runs domain unit tests (`fsm`, payload schema).
- `npm run test:integration` runs broker and MCP integration flows.
- `npm run smoke:broker` runs lifecycle integration only.
- `npm run smoke:mcp` runs MCP transport integration only.
