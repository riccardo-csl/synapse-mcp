import test from "node:test";
import assert from "node:assert/strict";

import { runCodexBackendPhase } from "../../lib/runner/adapters/codexExec.js";
import { createCycleSpec } from "../../lib/synapse/stateMachine.js";
import type { RunnerConfig } from "../../lib/synapse/types.js";
import { cleanupDir, createTempRepo } from "../helpers/synapse-fixtures.js";

function baseConfig(command: string, requireMarker = false): RunnerConfig {
  return {
    schema_version: 1,
    storage_dir: ".synapse",
    checks: {
      FRONTEND: [],
      BACKEND: [],
      FRONTEND_TWEAK: []
    },
    require_changes: {
      FRONTEND: false,
      BACKEND: false,
      FRONTEND_TWEAK: false
    },
    adapters: {
      gemini: {
        mode: "stub",
        command: "gemini",
        require_marker: false
      },
      codexExec: {
        command,
        require_marker: requireMarker
      }
    },
    locks: {
      ttl_ms: 20000,
      heartbeat_ms: 5000,
      takeover_grace_ms: 2000,
      pid_liveness_check: true
    },
    cancellation: {
      term_grace_ms: 1500
    },
    denylist_substrings: []
  };
}

test("Codex adapter requires structured marker when strict mode is enabled", async () => {
  const repoRoot = await createTempRepo("synapse-codex-marker-required-");
  try {
    const cycle = createCycleSpec({
      request: "Build backend",
      repo_root: repoRoot,
      constraints: [],
      phases: ["BACKEND"]
    });

    await assert.rejects(
      () => runCodexBackendPhase(cycle, cycle.phases[0], baseConfig(`node -e ${JSON.stringify("console.log('done')")}`, true)),
      (err: any) => err?.code === "ADAPTER_OUTPUT_PARSE_FAILED"
    );
  } finally {
    await cleanupDir(repoRoot);
  }
});

test("Codex adapter parses structured marker payload", async () => {
  const repoRoot = await createTempRepo("synapse-codex-marker-");
  try {
    const cycle = createCycleSpec({
      request: "Build backend",
      repo_root: repoRoot,
      constraints: [],
      phases: ["BACKEND"]
    });

    const payload = JSON.stringify({
      frontend_tweak_required: true,
      report: {
        source: "structured"
      }
    });
    const script = `console.log(${JSON.stringify(`SYNAPSE_RESULT_JSON: ${payload}`)});`;
    const result = await runCodexBackendPhase(cycle, cycle.phases[0], baseConfig(`node -e ${JSON.stringify(script)}`, true));

    assert.equal(result.frontend_tweak_required, true);
    assert.equal((result.report as any).source, "structured");
  } finally {
    await cleanupDir(repoRoot);
  }
});

test("Codex adapter falls back to heuristic when marker is optional", async () => {
  const repoRoot = await createTempRepo("synapse-codex-heuristic-");
  try {
    const cycle = createCycleSpec({
      request: "Build backend",
      repo_root: repoRoot,
      constraints: [],
      phases: ["BACKEND"]
    });

    const script = "console.log('frontend_tweak_required=true');";
    const result = await runCodexBackendPhase(cycle, cycle.phases[0], baseConfig(`node -e ${JSON.stringify(script)}`, false));
    assert.equal(result.frontend_tweak_required, true);
  } finally {
    await cleanupDir(repoRoot);
  }
});
