import test from "node:test";
import assert from "node:assert/strict";

import { report, runCycle } from "../../lib/runner/index.js";
import { synapseOrchestrate, synapseStatus } from "../../lib/synapse/service.js";
import { cleanupDir, createTempRepo, writeSynapseConfig } from "../helpers/synapse-fixtures.js";

test("gemini capacity exhaustion fails phase without Synapse retry", async () => {
  const repoRoot = await createTempRepo("synapse-gemini-capacity-int-");
  try {
    const script = [
      "console.error('status: 429');",
      "console.error('RESOURCE_EXHAUSTED');",
      "console.error('MODEL_CAPACITY_EXHAUSTED');",
      "console.error('{\"model\":\"gemini-3-pro-preview\"}');",
      "process.exit(1);"
    ].join(" ");
    const command = `node -e ${JSON.stringify(script)}`;

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
      request: "Frontend request during Gemini outage",
      repo_root: repoRoot,
      plan: {
        phases: ["FRONTEND"]
      }
    });

    await runCycle(orchestrated.cycle_id, repoRoot);

    const status = await synapseStatus({ cycle_id: orchestrated.cycle_id, repo_root: repoRoot });
    assert.equal(status.status, "FAILED");
    assert.equal(status.last_error?.code, "ADAPTER_CAPACITY_EXHAUSTED");
    assert.equal(status.phases[0].attempt_count, 1);
    assert.deepEqual(status.artifacts.attempt_history.map((a) => a.outcome), ["FAILED"]);

    const summary = await report(orchestrated.cycle_id, repoRoot);
    assert.equal(summary.errors.recommended_action, "retry_later_or_switch_model");
    assert.equal(typeof summary.errors.hint, "string");
  } finally {
    await cleanupDir(repoRoot);
  }
});
