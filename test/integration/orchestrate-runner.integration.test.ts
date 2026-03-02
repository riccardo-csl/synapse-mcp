import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";

import {
  synapseOrchestrate,
  synapsePhaseCompleteManual,
  synapsePhaseFailManual,
  synapsePhaseStartManual,
  synapseStatus
} from "../../lib/synapse/service.js";
import { startRunner } from "../../lib/runner/index.js";
import { cleanupDir, createTempRepo, writeSynapseConfig } from "../helpers/synapse-fixtures.js";

test("orchestrate + runner waits for manual BACKEND phase and orchestrator completes it", async () => {
  const repoRoot = await createTempRepo("synapse-integration-");
  try {
    await writeSynapseConfig(repoRoot, {
      require_changes: {
        FRONTEND: false,
        BACKEND: true,
        FRONTEND_TWEAK: false
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

    let status = await synapseStatus({ cycle_id: orchestrated.cycle_id, repo_root: repoRoot });
    assert.equal(status.status, "QUEUED");
    assert.equal(status.phases[0].status, "PENDING");
    assert.equal(status.phases[0].control_mode, "ORCHESTRATOR");
    assert.equal(status.current_phase?.id, status.phases[0].id);
    assert.equal(status.current_phase?.control_mode, "ORCHESTRATOR");
    assert.equal(status.manual_backend?.phase_id, status.phases[0].id);
    assert.equal(status.manual_backend?.status, "PENDING");

    const phaseId = status.phases[0].id;
    await synapsePhaseStartManual({
      cycle_id: orchestrated.cycle_id,
      phase_id: phaseId,
      repo_root: repoRoot,
      note: "orchestrator backend start"
    });

    await fs.writeFile(path.join(repoRoot, "backend.txt"), "ok", "utf8");

    await synapsePhaseCompleteManual({
      cycle_id: orchestrated.cycle_id,
      phase_id: phaseId,
      repo_root: repoRoot,
      output: {
        report: {
          summary: "backend complete",
          files_modified: ["backend.txt"],
          checks_run: [],
          checks_results: [],
          notes: ["manual backend completion"]
        },
        changed_files: ["backend.txt"],
        frontend_tweak_required: false,
        api_contract: {
          endpoints: [
            {
              method: "GET",
              path: "/api/test",
              request_shape: {},
              response_shape: { ok: true }
            }
          ],
          data_shapes: [
            {
              name: "BackendStatus",
              example: { ok: true }
            }
          ]
        }
      }
    });

    status = await synapseStatus({ cycle_id: orchestrated.cycle_id, repo_root: repoRoot });
    assert.equal(status.status, "DONE");
    assert.equal(status.phases[0].status, "DONE");
    assert.equal(status.manual_backend?.summary, "backend complete");
    assert.equal(status.manual_backend?.frontend_tweak_required, false);
    assert.equal(status.manual_backend?.files_modified_count, 1);

    const backendFile = await fs.readFile(path.join(repoRoot, "backend.txt"), "utf8");
    assert.equal(backendFile, "ok");
  } finally {
    await cleanupDir(repoRoot);
  }
});

test("manual BACKEND phase can be failed explicitly by orchestrator", async () => {
  const repoRoot = await createTempRepo("synapse-integration-manual-fail-");
  try {
    await writeSynapseConfig(repoRoot, {
      require_changes: {
        FRONTEND: false,
        BACKEND: false,
        FRONTEND_TWEAK: false
      }
    });

    const orchestrated = await synapseOrchestrate({
      request: "Implement backend for feature Y",
      repo_root: repoRoot,
      plan: {
        phases: ["BACKEND"]
      }
    });

    const status = await synapseStatus({ cycle_id: orchestrated.cycle_id, repo_root: repoRoot });
    const phaseId = status.phases[0].id;
    await synapsePhaseStartManual({ cycle_id: orchestrated.cycle_id, phase_id: phaseId, repo_root: repoRoot });
    const failed = await synapsePhaseFailManual({
      cycle_id: orchestrated.cycle_id,
      phase_id: phaseId,
      repo_root: repoRoot,
      error: {
        code: "BACKEND_IMPL_FAILED",
        message: "manual backend implementation failed",
        details: { reason: "test" }
      }
    });

    assert.equal(failed.phase_status, "FAILED");
    assert.equal(failed.cycle_status, "FAILED");

    const finalStatus = await synapseStatus({ cycle_id: orchestrated.cycle_id, repo_root: repoRoot });
    assert.equal(finalStatus.status, "FAILED");
    assert.equal(finalStatus.last_error?.code, "BACKEND_IMPL_FAILED");
    assert.equal(finalStatus.phases[0].status, "FAILED");
  } finally {
    await cleanupDir(repoRoot);
  }
});
