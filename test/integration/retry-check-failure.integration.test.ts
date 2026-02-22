import test from "node:test";
import assert from "node:assert/strict";

import { synapseOrchestrate, synapseStatus } from "../../lib/synapse/service.js";
import { runCycle } from "../../lib/runner/index.js";
import { cleanupDir, createTempRepo, writeSynapseConfig } from "../helpers/synapse-fixtures.js";

test("backend phase retries on check failure then marks cycle FAILED", async () => {
  const repoRoot = await createTempRepo("synapse-retry-check-");
  try {
    await writeSynapseConfig(repoRoot, {
      checks: {
        BACKEND: ["false"]
      },
      require_changes: {
        BACKEND: false
      },
      adapters: {
        codexExec: {
          command: "node -e \"console.log('backend run')\""
        }
      }
    });

    const orchestrated = await synapseOrchestrate({
      request: "Implement backend with failing checks",
      repo_root: repoRoot,
      plan: {
        phases: ["BACKEND"]
      }
    });

    await runCycle(orchestrated.cycle_id, repoRoot);

    const status = await synapseStatus({ cycle_id: orchestrated.cycle_id, repo_root: repoRoot });
    assert.equal(status.status, "FAILED");
    assert.equal(status.phases[0].attempt_count, 2);
    assert.equal(status.last_error?.code, "CHECK_FAILED");

    const outcomes = status.artifacts.attempt_history.map((entry) => entry.outcome);
    assert.deepEqual(outcomes, ["RETRY", "FAILED"]);
  } finally {
    await cleanupDir(repoRoot);
  }
});
