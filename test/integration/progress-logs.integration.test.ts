import test from "node:test";
import assert from "node:assert/strict";

import { synapseOrchestrate } from "../../lib/synapse/service.js";
import { report, runCycle } from "../../lib/runner/index.js";
import { cleanupDir, createTempRepo, writeSynapseConfig } from "../helpers/synapse-fixtures.js";

test("runner emits phase.progress logs during long-running phase execution", async () => {
  const repoRoot = await createTempRepo("synapse-progress-");
  const previous = process.env.SYNAPSE_PHASE_PROGRESS_LOG_MS;
  process.env.SYNAPSE_PHASE_PROGRESS_LOG_MS = "100";

  try {
    await writeSynapseConfig(repoRoot, {
      require_changes: {
        FRONTEND: false,
        BACKEND: false,
        FRONTEND_TWEAK: false
      },
      adapters: {
        codexExec: {
          command: "node -e \"setTimeout(() => { console.log('ok'); }, 450)\"",
          require_marker: false
        }
      }
    });

    const orchestrated = await synapseOrchestrate({
      request: "Slow backend phase for progress logging test",
      repo_root: repoRoot,
      plan: {
        phases: ["BACKEND"]
      }
    });

    await runCycle(orchestrated.cycle_id, repoRoot);
    const summary = await report(orchestrated.cycle_id, repoRoot);

    assert.equal(summary.status, "DONE");
    const progressEvents = summary.events.filter((e) => e.event === "phase.progress");
    assert.equal(progressEvents.length > 0, true);
  } finally {
    if (previous === undefined) {
      delete process.env.SYNAPSE_PHASE_PROGRESS_LOG_MS;
    } else {
      process.env.SYNAPSE_PHASE_PROGRESS_LOG_MS = previous;
    }
    await cleanupDir(repoRoot);
  }
});
