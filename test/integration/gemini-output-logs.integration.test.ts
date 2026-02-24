import test from "node:test";
import assert from "node:assert/strict";

import { synapseOrchestrate } from "../../lib/synapse/service.js";
import { logs, report, runCycle } from "../../lib/runner/index.js";
import { cleanupDir, createTempRepo, writeSynapseConfig } from "../helpers/synapse-fixtures.js";

test("gemini visible output can be persisted to synapse logs and emits adapter parsed event", async () => {
  const repoRoot = await createTempRepo("synapse-gemini-output-logs-");
  try {
    const payload = {
      file_ops: [{ path: "ui/feature.txt", action: "write", content: "ok" }],
      report: { summary: "frontend done", files_modified: ["ui/feature.txt"] },
      frontend_tweak_required: false
    };
    const script = [
      "console.log('gemini-visible-progress-line');",
      `console.log(${JSON.stringify("SYNAPSE_RESULT_JSON_BEGIN")});`,
      `console.log(${JSON.stringify(JSON.stringify(payload))});`,
      `console.log(${JSON.stringify("SYNAPSE_RESULT_JSON_END")});`
    ].join(" ");

    await writeSynapseConfig(repoRoot, {
      require_changes: {
        FRONTEND: false,
        BACKEND: false,
        FRONTEND_TWEAK: false
      },
      adapters: {
        gemini: {
          mode: "cli",
          command: `node -e ${JSON.stringify(script)}`,
          require_marker: true,
          max_output_bytes: 1_000_000,
          max_patch_bytes: 500_000,
          max_file_ops: 100,
          max_file_op_bytes: 300_000,
          repair_retry_on_invalid_output: false,
          max_repair_attempts: 1,
          stream_output_to_runner: false,
          stream_output_to_synapse_logs: true
        }
      }
    });

    const orchestrated = await synapseOrchestrate({
      request: "Frontend only test for Gemini output logs",
      repo_root: repoRoot,
      plan: { phases: ["FRONTEND"] }
    });

    await runCycle(orchestrated.cycle_id, repoRoot);
    const summary = await report(orchestrated.cycle_id, repoRoot);

    assert.equal(summary.status, "DONE");
    const stdoutEvents = summary.events.filter((e) => e.event === "adapter.stdout");
    assert.equal(stdoutEvents.length > 0, true);
    assert.equal(stdoutEvents.some((e) => e.message.includes("gemini-visible-progress-line")), true);

    const parsedEvents = summary.events.filter((e) => e.event === "adapter.output.parsed");
    assert.equal(parsedEvents.length > 0, true);

    const contextSeededEvents = summary.events.filter((e) => e.event === "context.seeded");
    assert.equal(contextSeededEvents.length > 0, true);
    const rawLogs = await logs(orchestrated.cycle_id, repoRoot, 200);
    const seededEntry = rawLogs.entries.find((e) => (e.meta as any)?.event === "context.seeded");
    assert.equal(Boolean(seededEntry), true);
    const seededMeta = ((seededEntry as any)?.meta || {}) as Record<string, unknown>;
    assert.equal(typeof seededMeta.suggested_start_files_count, "number");
    assert.equal(typeof seededMeta.seed_file_snippets_count, "number");
  } finally {
    await cleanupDir(repoRoot);
  }
});
