import test from "node:test";
import assert from "node:assert/strict";

import { synapseOrchestrate, synapseStatus } from "../../lib/synapse/service.js";
import { runCycle } from "../../lib/runner/index.js";
import { cleanupDir, createTempRepo, writeSynapseConfig } from "../helpers/synapse-fixtures.js";

test("optional true e2e: runner executes a real Gemini frontend command", async (t) => {
  if (process.env.E2E !== "1") {
    t.skip("Set E2E=1 to run optional e2e tests");
    return;
  }

  const geminiCmd = process.env.E2E_GEMINI_CMD;
  if (!geminiCmd) {
    t.skip("Set E2E_GEMINI_CMD to a real Gemini CLI command");
    return;
  }

  const repoRoot = await createTempRepo("synapse-e2e-");
  try {
    await writeSynapseConfig(repoRoot, {
      adapters: {
        gemini: {
          mode: "cli",
          command: geminiCmd,
          require_marker: false
        }
      },
      checks: {
        FRONTEND: [],
        BACKEND: [],
        FRONTEND_TWEAK: []
      },
      require_changes: {
        FRONTEND: false,
        BACKEND: false,
        FRONTEND_TWEAK: false
      }
    });

    const orchestrated = await synapseOrchestrate({
      request: "Implement frontend feature",
      repo_root: repoRoot,
      plan: {
        phases: ["FRONTEND"]
      }
    });

    await runCycle(orchestrated.cycle_id, repoRoot);
    const status = await synapseStatus({ cycle_id: orchestrated.cycle_id, repo_root: repoRoot });
    assert.equal(status.status, "DONE");
  } finally {
    await cleanupDir(repoRoot);
  }
});
