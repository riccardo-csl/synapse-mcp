import test from "node:test";
import assert from "node:assert/strict";

import { synapseOrchestrate } from "../../lib/synapse/service.js";
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
