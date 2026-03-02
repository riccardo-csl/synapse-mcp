import test from "node:test";
import assert from "node:assert/strict";

import { synapseOrchestrate, synapsePhaseCompleteManual, synapsePhaseStartManual } from "../../lib/synapse/service.js";
import { report, runCycle } from "../../lib/runner/index.js";
import { cleanupDir, createTempRepo, writeSynapseConfig } from "../helpers/synapse-fixtures.js";

test("runner report summarizes a completed cycle", async () => {
  const repoRoot = await createTempRepo("synapse-report-");
  try {
    await writeSynapseConfig(repoRoot, {
      require_changes: {
        FRONTEND: false,
        BACKEND: false,
        FRONTEND_TWEAK: false
      }
    });

    const orchestrated = await synapseOrchestrate({
      request: "Implement backend only",
      repo_root: repoRoot,
      plan: {
        phases: ["BACKEND"]
      }
    });

    await runCycle(orchestrated.cycle_id, repoRoot);
    const phaseId = (await report(orchestrated.cycle_id, repoRoot)).phases[0].id;
    await synapsePhaseStartManual({ cycle_id: orchestrated.cycle_id, phase_id: phaseId, repo_root: repoRoot });
    await synapsePhaseCompleteManual({
      cycle_id: orchestrated.cycle_id,
      phase_id: phaseId,
      repo_root: repoRoot,
      output: {
        report: {
          summary: "manual backend done",
          files_modified: [],
          checks_run: [],
          checks_results: []
        },
        changed_files: [],
        frontend_tweak_required: false
      }
    });
    const summary = await report(orchestrated.cycle_id, repoRoot);

    assert.equal(summary.status, "DONE");
    assert.equal(summary.cycle_id, orchestrated.cycle_id);
    assert.equal(summary.phases.length, 1);
    assert.equal(summary.phases[0].status, "DONE");
    assert.equal(summary.phases[0].control_mode, "ORCHESTRATOR");
    assert.equal(summary.current_phase, null);
    assert.equal(summary.manual_backend?.phase_id, phaseId);
    assert.equal(summary.manual_backend?.status, "DONE");
    assert.equal(summary.manual_backend?.summary, "manual backend done");
    assert.equal(summary.manual_backend?.frontend_tweak_required, false);
    assert.equal(typeof summary.artifacts.commands_run_count, "number");
    assert.equal(Array.isArray(summary.events), true);
    assert.equal(summary.events.length > 0, true);
  } finally {
    await cleanupDir(repoRoot);
  }
});
