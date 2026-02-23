# Synapse Observer Report Template

Use this template in the observer Codex session when reporting findings.

## Scope
- Mode: `live-watch | postmortem | baseline`
- Cycle ID:
- Repo Root:
- Time Window:
- Git Commit (optional):

## Status Summary
- Cycle Status:
- Current / Last Phase:
- Current Phase Index:
- Phase Attempts (summary):
- Terminal State (if any):

## Findings (Severity Ordered)
1. `[SEV-x]` Finding title
   - Error Code(s):
   - Impact:
   - Why it matters:

## Evidence
- `synapse.status` snapshot:
- `synapse-runner report <cycle_id>` summary:
- `synapse.logs` relevant entries:
- `.synapse/cycles/<cycle_id>.json` observations:
- `.synapse/locks/<cycle_id>.lock` observations (if relevant):

## Root Cause Hypothesis
- Most likely cause:
- Confidence: `low | medium | high`
- Unknowns / assumptions:

## Smallest Fix (Non-Breaking)
- Target file(s):
- Minimal patch idea:
- Why this is the smallest safe fix:

## Regression Test To Add
- Test name:
- Layer: `unit | integration`
- Scenario:
- Expected outcome:

## Upgrade Impact
- Reliability only / behavior change:
- Docs update needed:
- Config impact:

## Suggested Next Action
- Immediate:
- Follow-up:
