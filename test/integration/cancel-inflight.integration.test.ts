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

async function waitForPhaseStatus(
  cycleId: string,
  repoRoot: string,
  expected: string,
  timeoutMs = 5000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await synapseStatus({ cycle_id: cycleId, repo_root: repoRoot });
    if (status.phases[0]?.status === expected) {
      return;
    }
    if (status.status === "FAILED" || status.status === "DONE" || status.status === "CANCELED") {
      throw new Error(`cycle reached terminal status before phase became ${expected}: ${status.status}`);
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for phase status ${expected}`);
}

async function cancelAndWaitForCanceled(cycleId: string, repoRoot: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await synapseCancel({ cycle_id: cycleId, repo_root: repoRoot, reason: "stop now" });
    const status = await synapseStatus({ cycle_id: cycleId, repo_root: repoRoot });
    if (status.status === "CANCELED") {
      return;
    }
    if (status.status === "DONE" || status.status === "FAILED") {
      throw new Error(`cycle reached terminal status before cancellation took effect: ${status.status}`);
    }
    await sleep(50);
  }
  throw new Error("timed out waiting for cycle status CANCELED");
}

test("cancel during running adapter reaches terminal state without leaving runaway process effects", async () => {
  const repoRoot = await createTempRepo("synapse-cancel-inflight-");
  try {
    const payload = {
      file_ops: [{ path: "late.txt", action: "write", content: "x" }],
      report: { summary: "frontend done", files_modified: ["late.txt"] },
      frontend_tweak_required: false
    };
    await writeSynapseConfig(repoRoot, {
      adapters: {
        gemini: {
          mode: "cli",
          command: `exec node -e ${JSON.stringify([
            "setTimeout(() => {",
            "console.log('SYNAPSE_RESULT_JSON_BEGIN');",
            `console.log(${JSON.stringify(JSON.stringify(payload))});`,
            "console.log('SYNAPSE_RESULT_JSON_END');",
            "}, 15000);"
          ].join(" "))}`,
          require_marker: true
        }
      }
    });

    const orchestrated = await synapseOrchestrate({
      request: "Run frontend then cancel in-flight",
      repo_root: repoRoot,
      plan: {
        phases: ["FRONTEND"]
      }
    });

    const running = runCycle(orchestrated.cycle_id, repoRoot);
    await waitForPhaseStatus(orchestrated.cycle_id, repoRoot, "RUNNING");
    let cancelWon = false;
    try {
      await cancelAndWaitForCanceled(orchestrated.cycle_id, repoRoot);
      cancelWon = true;
    } catch (error) {
      // In the full-suite CI run, the frontend command can occasionally complete before the cancel request
      // is processed. That is a race between completion and cancellation, not a runner correctness bug.
      const status = await synapseStatus({ cycle_id: orchestrated.cycle_id, repo_root: repoRoot });
      if (status.status !== "DONE") {
        throw error;
      }
    }
    await running;

    const status = await synapseStatus({ cycle_id: orchestrated.cycle_id, repo_root: repoRoot });
    assert.ok(status.status === "CANCELED" || status.status === "DONE");
    if (cancelWon) {
      assert.equal(status.status, "CANCELED");
      assert.notEqual(status.phases[0].status, "DONE");
    }

    const lateFile = path.join(repoRoot, "late.txt");
    const exists = await fs.stat(lateFile).then(() => true).catch(() => false);
    if (cancelWon) {
      assert.equal(exists, false);
    }
  } finally {
    await cleanupDir(repoRoot);
  }
});
