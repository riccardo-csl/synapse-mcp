import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";

import { runGeminiPhase } from "../../lib/runner/adapters/gemini.js";
import { createCycleSpec } from "../../lib/synapse/stateMachine.js";
import type { RunnerConfig } from "../../lib/synapse/types.js";
import { cleanupDir, createTempRepo } from "../helpers/synapse-fixtures.js";

function baseConfig(command: string): RunnerConfig {
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
        mode: "cli",
        command
      },
      codexExec: {
        command: "codex exec"
      }
    },
    locks: {
      ttl_ms: 20000,
      heartbeat_ms: 5000,
      takeover_grace_ms: 2000
    },
    denylist_substrings: []
  };
}

test("Gemini adapter rejects non-JSON output", async () => {
  const repoRoot = await createTempRepo("synapse-gemini-parse-");
  try {
    const cycle = createCycleSpec({
      request: "Build frontend",
      repo_root: repoRoot,
      constraints: [],
      phases: ["FRONTEND"]
    });

    await assert.rejects(
      () => runGeminiPhase(cycle, cycle.phases[0], baseConfig("node -e \"console.log('not-json')\"")),
      (err: any) => err?.code === "ADAPTER_OUTPUT_PARSE_FAILED"
    );
  } finally {
    await cleanupDir(repoRoot);
  }
});

test("Gemini adapter validates schema for output payload", async () => {
  const repoRoot = await createTempRepo("synapse-gemini-schema-");
  try {
    const cycle = createCycleSpec({
      request: "Build frontend",
      repo_root: repoRoot,
      constraints: [],
      phases: ["FRONTEND"]
    });

    const output = JSON.stringify({ file_ops: [{ path: "x.ts", action: "write" }] });
    await assert.rejects(
      () => runGeminiPhase(cycle, cycle.phases[0], baseConfig(`node -e ${JSON.stringify(`console.log(${JSON.stringify(output)})`)}`)),
      (err: any) => err?.code === "ADAPTER_OUTPUT_INVALID"
    );
  } finally {
    await cleanupDir(repoRoot);
  }
});

test("Gemini adapter uses final marked payload when debug JSON is present", async () => {
  const repoRoot = await createTempRepo("synapse-gemini-marker-");
  try {
    const cycle = createCycleSpec({
      request: "Build frontend",
      repo_root: repoRoot,
      constraints: [],
      phases: ["FRONTEND"]
    });

    const payload = {
      file_ops: [{ path: "ui/result.txt", action: "write", content: "ok" }],
      report: { source: "marker" }
    };
    const script = [
      "console.log(JSON.stringify({debug:true, note:'example'}));",
      `console.log(${JSON.stringify(`SYNAPSE_RESULT_JSON: ${JSON.stringify(payload)}`)});`
    ].join(" ");
    const command = `node -e ${JSON.stringify(script)}`;

    const result = await runGeminiPhase(cycle, cycle.phases[0], baseConfig(command));
    assert.equal((result.report as any).source, "marker");

    const written = await fs.readFile(path.join(repoRoot, "ui/result.txt"), "utf8");
    assert.equal(written, "ok");
  } finally {
    await cleanupDir(repoRoot);
  }
});
