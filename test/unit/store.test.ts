import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";

import { createCycleSpec } from "../../lib/synapse/stateMachine.js";
import { ensureSynapseStore, readCycle, writeCycle } from "../../lib/synapse/store.js";
import { cleanupDir, createTempRepo } from "../helpers/synapse-fixtures.js";

test("store writes/reads cycle atomically without tmp leftovers", async () => {
  const repoRoot = await createTempRepo("synapse-store-");
  try {
    const cycle = createCycleSpec({
      request: "Implement feature X",
      repo_root: repoRoot,
      constraints: []
    });

    await writeCycle(repoRoot, cycle);
    const loaded = await readCycle(repoRoot, cycle.id);
    assert.equal(loaded.id, cycle.id);
    assert.equal(loaded.request_text, "Implement feature X");

    const paths = await ensureSynapseStore(repoRoot);
    const entries = await fs.readdir(path.join(paths.cyclesDir));
    assert.ok(entries.some((name) => name === `${cycle.id}.json`));
    assert.ok(entries.every((name) => !name.includes(".tmp")));
  } finally {
    await cleanupDir(repoRoot);
  }
});

test("writeCycle does not overwrite terminal canceled cycle with stale non-canceled snapshot", async () => {
  const repoRoot = await createTempRepo("synapse-store-cancel-preserve-");
  try {
    const cycle = createCycleSpec({
      request: "Implement feature X",
      repo_root: repoRoot,
      constraints: []
    });

    await writeCycle(repoRoot, cycle);

    const canceled = structuredClone(cycle);
    canceled.status = "CANCELED";
    canceled.current_phase_index = null;
    canceled.updated_at = new Date().toISOString();
    await writeCycle(repoRoot, canceled);

    const staleDone = structuredClone(cycle);
    staleDone.status = "DONE";
    staleDone.current_phase_index = null;
    staleDone.updated_at = new Date().toISOString();
    await writeCycle(repoRoot, staleDone);

    const loaded = await readCycle(repoRoot, cycle.id);
    assert.equal(loaded.status, "CANCELED");
  } finally {
    await cleanupDir(repoRoot);
  }
});
