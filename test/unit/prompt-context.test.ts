import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";

import { createCycleSpec } from "../../lib/synapse/stateMachine.js";
import { buildWorkerPhaseContextBlock } from "../../lib/runner/adapters/promptContext.js";
import { cleanupDir, createTempRepo } from "../helpers/synapse-fixtures.js";

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

test("buildWorkerPhaseContextBlock includes recent completed phase summary/files and retry context", async () => {
  const repoRoot = await createTempRepo("synapse-prompt-context-");
  try {
    const cycle = createCycleSpec({
      request: "Implement backend integration after frontend changes",
      repo_root: repoRoot,
      constraints: ["Keep API stable"],
      phases: ["FRONTEND", "BACKEND", "FRONTEND_TWEAK"]
    });

    await fs.mkdir(path.join(repoRoot, "apps/web/src/features/tasks/ui"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "apps/web/src/features/tasks/ui/UpdateTaskModal.tsx"),
      "export function UpdateTaskModal() { return null; }\n",
      "utf8"
    );

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
      message: "Backend tests failed on previous attempt",
      details: {
        stdout_tail: "Look at apps/web/src/features/tasks/ui/UpdateTaskModal.tsx for expected request payload."
      }
    };

    await fs.mkdir(path.join(repoRoot, ".synapse/context"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".synapse/context", `${cycle.id}.json`), JSON.stringify({
      schema_version: 1,
      cycle_id: cycle.id,
      updated_at: "2026-02-23T00:01:00.000Z",
      file_hints: [
        {
          path: "apps/web/src/features/tasks/ui/UpdateTaskModal.tsx",
          reason: "Frontend handoff file to inspect first",
          source: "phase_result",
          last_seen_at: "2026-02-23T00:00:59.000Z"
        }
      ],
      phase_attempts: [
        {
          phase_id: "phase_1_frontend",
          phase_type: "FRONTEND",
          attempt: 1,
          ts: "2026-02-23T00:00:59.000Z",
          outcome: "DONE",
          candidate_files: ["apps/web/src/features/tasks/ui/UpdateTaskModal.tsx"]
        }
      ]
    }, null, 2), "utf8");

    const block = await buildWorkerPhaseContextBlock(cycle, backend, { storageDir: ".synapse" });
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
    assert.equal(Array.isArray(parsed.seed_file_snippets), true);
    assert.equal(
      parsed.seed_file_snippets.some((s: any) => s.path === "apps/web/src/features/tasks/ui/UpdateTaskModal.tsx"),
      true
    );
    assert.equal(parsed.worker_memory.file_hints[0].path, "apps/web/src/features/tasks/ui/UpdateTaskModal.tsx");
  } finally {
    await cleanupDir(repoRoot);
  }
});
