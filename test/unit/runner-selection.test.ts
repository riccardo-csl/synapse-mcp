import test from "node:test";
import assert from "node:assert/strict";

import { createCycleSpec } from "../../lib/synapse/stateMachine.js";
import { writeCycle } from "../../lib/synapse/store.js";
import { claimNextRunnablePhase } from "../../lib/runner/service.js";
import { cleanupDir, createTempRepo } from "../helpers/synapse-fixtures.js";

test("runner claims next runnable phase from non-terminal cycles", async () => {
  const repoRoot = await createTempRepo("synapse-runner-pick-");
  try {
    const doneCycle = createCycleSpec({
      request: "done cycle",
      repo_root: repoRoot,
      constraints: [],
      phases: ["BACKEND"]
    });
    doneCycle.status = "DONE";
    doneCycle.current_phase_index = null;

    const runnableCycle = createCycleSpec({
      request: "runnable cycle",
      repo_root: repoRoot,
      constraints: [],
      phases: ["BACKEND"]
    });

    await writeCycle(repoRoot, doneCycle);
    await writeCycle(repoRoot, runnableCycle);

    const claimed = await claimNextRunnablePhase(repoRoot, "runner-test");
    assert.ok(claimed);
    assert.equal(claimed?.cycle_id, runnableCycle.id);
    assert.equal(claimed?.phase_index, 0);
  } finally {
    await cleanupDir(repoRoot);
  }
});
