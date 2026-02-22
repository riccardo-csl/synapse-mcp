import test from "node:test";
import assert from "node:assert/strict";

import { runCycle } from "../../lib/runner/index.js";
import { synapseOrchestrate, synapseStatus } from "../../lib/synapse/service.js";
import { cleanupDir, createTempRepo, writeSynapseConfig } from "../helpers/synapse-fixtures.js";

test("non-retryable adapter schema errors fail phase without retry", async () => {
  const repoRoot = await createTempRepo("synapse-nonretryable-");
  try {
    const invalidOutput = JSON.stringify({ file_ops: [{ path: "x.ts", action: "write" }] });
    const command = `node -e ${JSON.stringify(`console.log(${JSON.stringify(invalidOutput)})`)}`;

    await writeSynapseConfig(repoRoot, {
      adapters: {
        gemini: {
          mode: "cli",
          command
        }
      },
      require_changes: {
        FRONTEND: false
      }
    });

    const orchestrated = await synapseOrchestrate({
      request: "Implement frontend with invalid adapter output",
      repo_root: repoRoot,
      plan: {
        phases: ["FRONTEND"]
      }
    });

    await runCycle(orchestrated.cycle_id, repoRoot);

    const status = await synapseStatus({ cycle_id: orchestrated.cycle_id, repo_root: repoRoot });
    assert.equal(status.status, "FAILED");
    assert.equal(status.last_error?.code, "ADAPTER_OUTPUT_INVALID");
    assert.equal(status.phases[0].attempt_count, 1);

    const outcomes = status.artifacts.attempt_history.map((entry) => entry.outcome);
    assert.deepEqual(outcomes, ["FAILED"]);
  } finally {
    await cleanupDir(repoRoot);
  }
});
