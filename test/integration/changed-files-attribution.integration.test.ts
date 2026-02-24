import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";

import { synapseOrchestrate } from "../../lib/synapse/service.js";
import { runCycle } from "../../lib/runner/index.js";
import { readCycle } from "../../lib/synapse/store.js";
import { cleanupDir, createTempRepo, writeSynapseConfig } from "../helpers/synapse-fixtures.js";

test("phase changed_files attribution excludes unrelated pre-existing dirty files", async () => {
  const repoRoot = await createTempRepo("synapse-changed-files-");
  try {
    await writeSynapseConfig(repoRoot, {
      require_changes: {
        FRONTEND: false,
        BACKEND: false,
        FRONTEND_TWEAK: false
      },
      adapters: {
        codexExec: {
          command: "node -e \"require('fs').writeFileSync('backend.txt','ok')\"",
          require_marker: false
        }
      }
    });

    // Pre-existing unrelated dirty change in repo before the phase runs.
    await fs.writeFile(path.join(repoRoot, "README.md"), "# temp dirty\n", "utf8");

    const orchestrated = await synapseOrchestrate({
      request: "Backend only changed files attribution test",
      repo_root: repoRoot,
      plan: {
        phases: ["BACKEND"]
      }
    });

    await runCycle(orchestrated.cycle_id, repoRoot);
    const cycle = await readCycle(repoRoot, orchestrated.cycle_id);

    assert.equal(cycle.status, "DONE");
    const phaseOutput = cycle.phases[0].output as any;
    const phaseChangedFiles = Array.isArray(phaseOutput?.changed_files) ? phaseOutput.changed_files : [];
    assert.deepEqual(phaseChangedFiles, ["backend.txt"]);
    assert.equal(cycle.artifacts.changed_files.includes("backend.txt"), true);
    assert.equal(cycle.artifacts.changed_files.includes("README.md"), false);
  } finally {
    await cleanupDir(repoRoot);
  }
});
