import test from "node:test";
import assert from "node:assert/strict";

import { synapseOrchestrate, synapseStatus } from "../../lib/synapse/service.js";
import { runCycle } from "../../lib/runner/index.js";
import { cleanupDir, createTempRepo, writeSynapseConfig } from "../helpers/synapse-fixtures.js";

test("frontend phase retries on check failure then marks cycle FAILED", async () => {
  const repoRoot = await createTempRepo("synapse-retry-check-");
  try {
    await writeSynapseConfig(repoRoot, {
      checks: {
        FRONTEND: ["false"]
      },
      require_changes: {
        FRONTEND: false
      },
      adapters: {
        gemini: {
          mode: "cli",
          command: `node -e ${JSON.stringify([
            "console.log('SYNAPSE_RESULT_JSON_BEGIN');",
            "console.log(JSON.stringify({ file_ops: [{ path: 'frontend.txt', action: 'write', content: 'x' }], report: { summary: 'frontend run', files_modified: ['frontend.txt'] }, frontend_tweak_required: false }));",
            "console.log('SYNAPSE_RESULT_JSON_END');"
          ].join(" "))}`,
          require_marker: true
        }
      }
    });

    const orchestrated = await synapseOrchestrate({
      request: "Implement frontend with failing checks",
      repo_root: repoRoot,
      plan: {
        phases: ["FRONTEND"]
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
