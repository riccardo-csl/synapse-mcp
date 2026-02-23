# Codex Synapse Orchestration Policy

This document gives you a copy/paste instruction block for Codex so you can say:

`Implement feature X, use synapse-mcp`

and let Codex choose the Synapse MCP tools automatically without you specifying tool names.

## What This Policy Does

It defines a simple rule:

- You explicitly choose whether to use Synapse (`use synapse-mcp`)
- Codex autonomously chooses which Synapse tools to call (`synapse.orchestrate`, `synapse.status`, etc.)

This preserves opt-in orchestration while avoiding tool micromanagement.

## Full Instruction Block (Recommended)

Copy this into your Codex system/developer/project instructions.

```md
When the user explicitly asks to "use synapse-mcp" (or equivalent phrasing like "use synapse", "use the synapse orchestrator"), treat the request as an orchestration task and use the Synapse MCP tools autonomously.

Do NOT ask the user which Synapse tool to call.
Do NOT ask the user to manually sequence the workflow.
The user is opting into orchestration, not tool micromanagement.

## Trigger Rule (Opt-In Only)
Use Synapse MCP tools ONLY if the user explicitly opts in with wording that clearly requests Synapse orchestration (for example: "use synapse-mcp").

If the user does not explicitly opt in, proceed with normal coding workflow and do not call Synapse tools.

## Primary Goal
Translate the user's natural-language request into a Synapse cycle and manage it to completion (DONE / FAILED / CANCELED), then report outcome clearly.

## Default Tool Flow (Autonomous)
1. Call `synapse.orchestrate` with:
   - `request`: the user’s request (cleaned but semantically unchanged)
   - `repo_root`: current workspace root if available
   - `constraints`: include any explicit user constraints
   - omit custom `plan` unless the user explicitly requests a different phase order
2. Call `synapse.status` on the returned `cycle_id`
3. Continue polling `synapse.status` until terminal state:
   - `DONE`
   - `FAILED`
   - `CANCELED`
4. Use `synapse.logs` only when needed:
   - failure diagnosis
   - long-running phase with unclear progress
   - user asks for details
5. Call `synapse.list` only if user asks for recent cycles or if needed to recover context
6. Call `synapse.cancel` only if:
   - user explicitly asks to cancel
   - a safety issue is detected and cancellation is the safest option

## Polling Behavior
- Poll `synapse.status` at a reasonable interval (avoid aggressive spam).
- Prefer status polling over repeated log pulls.
- Use `synapse.logs` with a tail when diagnosing failures.

## What to Tell the User During Execution
- Briefly acknowledge orchestration start and provide the `cycle_id`
- Give concise progress updates (current status / phase)
- On completion, summarize:
  - final status
  - key outputs / changed files if available
  - any remaining issues or follow-ups

## Error Handling
If a Synapse tool returns:
`{ "ok": false, "error": { "code", "message", "details" } }`

Then:
- Treat it as a normal tool-level failure (not transport failure)
- Report the `code` and a short explanation
- If recoverable, try the next sensible step (e.g. inspect status/logs)
- Do not invent state; use Synapse status/logs as source of truth

## Planning Rules
- Default orchestration plan is Synapse’s standard flow (typically FE -> BE -> FE_TWEAK).
- Do not force a custom phase plan unless the user explicitly asks.
- If the user specifies a phase order, pass it via `plan.phases`.

## Constraints Handling
Pass user constraints into `synapse.orchestrate.constraints`, such as:
- framework/library constraints
- style/system constraints
- testing requirements
- “do not change X”
- performance/security constraints

## Non-Goals
Do not manually reproduce Synapse’s orchestration logic inside Codex.
Do not directly spawn Gemini/Codex subprocesses yourself when Synapse is requested.
Synapse is the orchestrator.

## Example Behavior
User: "Implement feature X, use synapse-mcp"
You:
- call `synapse.orchestrate`
- poll `synapse.status`
- inspect `synapse.logs` only if needed
- report DONE/FAILED with summary

User: "Implement feature X" (no Synapse mention)
You:
- do normal direct coding workflow
- do not call Synapse tools
```

## Compact Version (Optional)

Use this if you want a shorter rule in a constrained prompt.

```md
If the user explicitly says "use synapse-mcp", use Synapse MCP tools autonomously (start with `synapse.orchestrate`, then monitor with `synapse.status`, use `synapse.logs` only when needed, and report terminal status). Do not ask the user which Synapse tools to call. If the user does not explicitly opt in, do not use Synapse.
```

## Recommended User Prompt Patterns

- `Implement feature X, use synapse-mcp`
- `Refactor Y with tests, use synapse-mcp`
- `Build frontend for Z first, then backend, use synapse-mcp`

## Notes

- This policy is intentionally opt-in.
- It keeps normal Codex workflows unchanged unless Synapse is explicitly requested.
- It assumes the Synapse MCP server and runner are already configured and running.
