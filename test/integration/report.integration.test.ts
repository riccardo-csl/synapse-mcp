import test from "node:test";
import assert from "node:assert/strict";

import { synapseOrchestrate } from "../../lib/synapse/service.js";
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
    const summary = await report(orchestrated.cycle_id, repoRoot);

    assert.equal(summary.status, "DONE");
    assert.equal(summary.cycle_id, orchestrated.cycle_id);
    assert.equal(summary.phases.length, 1);
    assert.equal(summary.phases[0].status, "DONE");
    assert.equal(typeof summary.artifacts.commands_run_count, "number");
    assert.equal(Array.isArray(summary.events), true);
    assert.equal(summary.events.length > 0, true);
  } finally {
    await cleanupDir(repoRoot);
  }
});
