import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";

import { runCycle } from "../../lib/runner/index.js";
import { synapseCancel, synapseOrchestrate, synapseStatus } from "../../lib/synapse/service.js";
import { cleanupDir, createTempRepo, writeSynapseConfig } from "../helpers/synapse-fixtures.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("cancel during running adapter kills process and keeps cycle canceled", async () => {
  const repoRoot = await createTempRepo("synapse-cancel-inflight-");
  try {
    await writeSynapseConfig(repoRoot, {
      adapters: {
        codexExec: {
          command: "node -e \"setTimeout(()=>require('fs').writeFileSync('late.txt','x'), 1500)\""
        }
      }
    });

    const orchestrated = await synapseOrchestrate({
      request: "Run backend then cancel in-flight",
      repo_root: repoRoot,
      plan: {
        phases: ["BACKEND"]
      }
    });

    const running = runCycle(orchestrated.cycle_id, repoRoot);
    await sleep(150);
    await synapseCancel({ cycle_id: orchestrated.cycle_id, repo_root: repoRoot, reason: "stop now" });
    await running;

    const status = await synapseStatus({ cycle_id: orchestrated.cycle_id, repo_root: repoRoot });
    assert.equal(status.status, "CANCELED");
    assert.notEqual(status.phases[0].status, "DONE");

    const lateFile = path.join(repoRoot, "late.txt");
    const exists = await fs.stat(lateFile).then(() => true).catch(() => false);
    assert.equal(exists, false);
  } finally {
    await cleanupDir(repoRoot);
  }
});
