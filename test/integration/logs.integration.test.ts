import test from "node:test";
import assert from "node:assert/strict";

import { synapseOrchestrate, synapsePhaseCompleteManual, synapsePhaseStartManual, synapseStatus } from "../../lib/synapse/service.js";
import { logs, runCycle } from "../../lib/runner/index.js";
import { cleanupDir, createTempRepo, writeSynapseConfig } from "../helpers/synapse-fixtures.js";

test("runner logs returns cycle logs and supports tail", async () => {
  const repoRoot = await createTempRepo("synapse-logs-");
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
    const statusBefore = await synapseStatus({ cycle_id: orchestrated.cycle_id, repo_root: repoRoot });
    const phaseId = statusBefore.phases[0].id;
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

    const full = await logs(orchestrated.cycle_id, repoRoot);
    assert.equal(full.cycle_id, orchestrated.cycle_id);
    assert.equal(full.status, "DONE");
    assert.equal(Array.isArray(full.entries), true);
    assert.equal(full.entries.length > 0, true);

    const tailed = await logs(orchestrated.cycle_id, repoRoot, 2);
    assert.equal(tailed.cycle_id, orchestrated.cycle_id);
    assert.equal(tailed.entries.length <= 2, true);
    assert.deepEqual(tailed.entries, full.entries.slice(-2));
  } finally {
    await cleanupDir(repoRoot);
  }
});
