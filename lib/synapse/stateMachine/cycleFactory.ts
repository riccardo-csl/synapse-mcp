import { randomBytes } from "node:crypto";
import { nowIso } from "../../core/time.js";
import type { CycleSpec, OrchestrateInput, PhaseType } from "../types.js";
import { buildPhases } from "./planning.js";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 40) || "cycle";
}

export function createCycleSpec(input: Required<Pick<OrchestrateInput, "request" | "repo_root">> & {
  constraints: string[];
  phases?: PhaseType[];
}): CycleSpec {
  const createdAt = nowIso();
  const id = `${createdAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}_${slugify(input.request)}_${randomBytes(3).toString("hex")}`;
  const phases = buildPhases(input.phases);

  return {
    schema_version: 1,
    id,
    created_at: createdAt,
    updated_at: createdAt,
    request_text: input.request,
    repo_root: input.repo_root,
    constraints: input.constraints,
    phases,
    status: "QUEUED",
    current_phase_index: phases.length ? 0 : null,
    artifacts: {
      changed_files: [],
      commands_run: [],
      test_results: [],
      phase_durations_ms: {},
      attempt_history: []
    },
    logs: [
      {
        ts: createdAt,
        level: "INFO",
        message: "Cycle created"
      }
    ],
    last_error: null,
    canceled_reason: null
  };
}
