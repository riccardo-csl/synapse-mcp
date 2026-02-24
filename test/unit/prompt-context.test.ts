import test from "node:test";
import assert from "node:assert/strict";

import { createCycleSpec } from "../../lib/synapse/stateMachine.js";
import { buildWorkerPhaseContextBlock } from "../../lib/runner/adapters/promptContext.js";

function extractContextJson(block: string): any {
  const begin = "SYNAPSE_PHASE_CONTEXT_BEGIN";
  const end = "SYNAPSE_PHASE_CONTEXT_END";
  const beginIdx = block.indexOf(begin);
  const endIdx = block.indexOf(end);
  assert.notEqual(beginIdx, -1);
  assert.notEqual(endIdx, -1);
  const raw = block.slice(beginIdx + begin.length, endIdx).trim();
  return JSON.parse(raw);
}

test("buildWorkerPhaseContextBlock includes recent completed phase summary/files and retry context", () => {
  const cycle = createCycleSpec({
    request: "Implement backend integration after frontend changes",
    repo_root: "/tmp/repo",
    constraints: ["Keep API stable"],
    phases: ["FRONTEND", "BACKEND", "FRONTEND_TWEAK"]
  });

  const frontend = cycle.phases[0];
  frontend.status = "DONE";
  frontend.attempt_count = 1;
  frontend.finished_at = "2026-02-23T00:00:01.000Z";
  frontend.output = {
    report: {
      summary: "Implemented task modal behavior and expects PATCH /api/tasks/:id.",
      files_modified: ["apps/web/src/features/tasks/ui/UpdateTaskModal.tsx"]
    },
    changed_files: ["apps/web/src/features/tasks/ui/UpdateTaskModal.tsx"],
    completed_at: "2026-02-23T00:00:01.000Z"
  };

  const backend = cycle.phases[1];
  backend.status = "RUNNING";
  backend.attempt_count = 2;
  cycle.current_phase_index = 1;
  cycle.last_error = {
    code: "CHECK_FAILED",
    message: "Backend tests failed on previous attempt"
  };

  const block = buildWorkerPhaseContextBlock(cycle, backend);
  const parsed = extractContextJson(block);

  assert.equal(parsed.current_phase.type, "BACKEND");
  assert.equal(parsed.current_phase.attempt, 2);
  assert.equal(parsed.retry_context.last_error.code, "CHECK_FAILED");
  assert.equal(parsed.recent_completed_phases.length, 1);
  assert.equal(
    parsed.recent_completed_phases[0].files_modified[0],
    "apps/web/src/features/tasks/ui/UpdateTaskModal.tsx"
  );
  assert.equal(
    parsed.suggested_start_files.includes("apps/web/src/features/tasks/ui/UpdateTaskModal.tsx"),
    true
  );
});

