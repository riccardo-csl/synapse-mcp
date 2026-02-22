import test from "node:test";
import assert from "node:assert/strict";

import { runCycle } from "../../lib/runner/index.js";
import { synapseOrchestrate, synapseStatus } from "../../lib/synapse/service.js";
import { readCycle, writeCycle } from "../../lib/synapse/store.js";
import { cleanupDir, createTempRepo, writeSynapseConfig } from "../helpers/synapse-fixtures.js";

test("backend timeout exhausts retries and fails cycle", async () => {
  const repoRoot = await createTempRepo("synapse-timeout-");
  try {
    await writeSynapseConfig(repoRoot, {
      require_changes: {
        BACKEND: false
      },
      adapters: {
        codexExec: {
          command: "node -e \"setTimeout(() => {}, 600)\""
        }
      }
    });

    const orchestrated = await synapseOrchestrate({
      request: "Implement slow backend",
      repo_root: repoRoot,
      plan: {
        phases: ["BACKEND"]
      }
    });

    const cycle = await readCycle(repoRoot, orchestrated.cycle_id);
    cycle.phases[0].timeout_ms = 100;
    await writeCycle(repoRoot, cycle);

    await runCycle(orchestrated.cycle_id, repoRoot);

    const status = await synapseStatus({ cycle_id: orchestrated.cycle_id, repo_root: repoRoot });
    assert.equal(status.status, "FAILED");
    assert.equal(status.last_error?.code, "PHASE_TIMEOUT");
    assert.equal(status.phases[0].attempt_count, 2);
  } finally {
    await cleanupDir(repoRoot);
  }
});
