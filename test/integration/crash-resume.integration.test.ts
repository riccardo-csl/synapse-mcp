import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";

import { runCycle } from "../../lib/runner/index.js";
import { synapseOrchestrate, synapseStatus } from "../../lib/synapse/service.js";
import { ensureSynapseStore, readCycle, writeCycle } from "../../lib/synapse/store.js";
import { cleanupDir, createTempRepo, writeSynapseConfig } from "../helpers/synapse-fixtures.js";

test("runner resumes stale running phase after crash-style state", async () => {
  const repoRoot = await createTempRepo("synapse-crash-resume-");
  try {
    await writeSynapseConfig(repoRoot, {
      adapters: {
        codexExec: {
          command: "node -e \"require('fs').writeFileSync('resumed.txt','ok')\""
        }
      }
    });

    const orchestrated = await synapseOrchestrate({
      request: "Resume after stale crash",
      repo_root: repoRoot,
      plan: {
        phases: ["BACKEND"]
      }
    });

    const cycle = await readCycle(repoRoot, orchestrated.cycle_id);
    const phase = cycle.phases[0];
    phase.status = "RUNNING";
    phase.claim_token = "dead-claim-token";
    phase.claimed_by = "runner-old";
    phase.started_at = new Date(Date.now() - 120_000).toISOString();
    cycle.status = "RUNNING";
    cycle.current_phase_index = 0;
    await writeCycle(repoRoot, cycle);

    const paths = await ensureSynapseStore(repoRoot);
    const staleLock = {
      schema_version: 1,
      lock_version: 1,
      cycle_id: orchestrated.cycle_id,
      owner_id: "runner-old",
      pid: 99999,
      created_at: new Date(Date.now() - 180_000).toISOString(),
      heartbeat_at: new Date(Date.now() - 180_000).toISOString(),
      expires_at: new Date(Date.now() - 120_000).toISOString()
    };
    await fs.writeFile(
      path.join(paths.locksDir, `${orchestrated.cycle_id}.lock`),
      JSON.stringify(staleLock, null, 2) + "\n",
      "utf8"
    );

    await runCycle(orchestrated.cycle_id, repoRoot);

    const status = await synapseStatus({ cycle_id: orchestrated.cycle_id, repo_root: repoRoot });
    assert.equal(status.status, "DONE");

    const resumedFile = await fs.readFile(path.join(repoRoot, "resumed.txt"), "utf8");
    assert.equal(resumedFile, "ok");
  } finally {
    await cleanupDir(repoRoot);
  }
});
