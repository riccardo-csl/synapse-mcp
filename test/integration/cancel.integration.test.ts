import test from "node:test";
import assert from "node:assert/strict";

import { runCycle } from "../../lib/runner/index.js";
import { synapseCancel, synapseOrchestrate, synapseStatus } from "../../lib/synapse/service.js";
import { cleanupDir, createTempRepo, writeSynapseConfig } from "../helpers/synapse-fixtures.js";

test("canceled cycle is not executed by runner", async () => {
  const repoRoot = await createTempRepo("synapse-cancel-");
  try {
    await writeSynapseConfig(repoRoot, {
      adapters: {
        codexExec: {
          command: "node -e \"require('fs').writeFileSync('should-not-exist.txt','x')\""
        }
      }
    });

    const orchestrated = await synapseOrchestrate({
      request: "Implement backend then cancel",
      repo_root: repoRoot,
      plan: {
        phases: ["BACKEND"]
      }
    });

    await synapseCancel({ cycle_id: orchestrated.cycle_id, repo_root: repoRoot, reason: "user stop" });
    await runCycle(orchestrated.cycle_id, repoRoot);

    const status = await synapseStatus({ cycle_id: orchestrated.cycle_id, repo_root: repoRoot });
    assert.equal(status.status, "CANCELED");
    assert.equal(status.current_phase_index, null);
    assert.equal(status.canceled_reason, "user stop");
  } finally {
    await cleanupDir(repoRoot);
  }
});
