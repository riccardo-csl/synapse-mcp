import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";

import { synapseOrchestrate, synapseStatus } from "../../lib/synapse/service.js";
import { startRunner } from "../../lib/runner/index.js";
import { cleanupDir, createTempRepo, writeSynapseConfig } from "../helpers/synapse-fixtures.js";

test("orchestrate + runner executes BACKEND phase end-to-end", async () => {
  const repoRoot = await createTempRepo("synapse-integration-");
  try {
    await writeSynapseConfig(repoRoot, {
      require_changes: {
        FRONTEND: false,
        BACKEND: true,
        FRONTEND_TWEAK: false
      },
      adapters: {
        codexExec: {
          command: "node -e \"require('fs').writeFileSync('backend.txt','ok')\""
        }
      }
    });

    const orchestrated = await synapseOrchestrate({
      request: "Implement backend for feature X",
      repo_root: repoRoot,
      plan: {
        phases: ["BACKEND"]
      }
    });

    await startRunner({ repoRoot, once: true, pollMs: 10 });

    const status = await synapseStatus({ cycle_id: orchestrated.cycle_id, repo_root: repoRoot });
    assert.equal(status.status, "DONE");

    const backendFile = await fs.readFile(path.join(repoRoot, "backend.txt"), "utf8");
    assert.equal(backendFile, "ok");
  } finally {
    await cleanupDir(repoRoot);
  }
});
