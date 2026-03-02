import test from "node:test";
import assert from "node:assert/strict";

import { executeTool } from "../../lib/mcp/handlers.js";
import { cleanupDir, createTempRepo, writeSynapseConfig } from "../helpers/synapse-fixtures.js";

test("unknown MCP tool returns INVALID_TOOL envelope", async () => {
  const result = await executeTool("does.not.exist", {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_TOOL");
});

test("synapse.orchestrate validates required request", async () => {
  const result = await executeTool("synapse.orchestrate", {} as any);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SCHEMA_INVALID");
});

test("synapse.render_prompt succeeds", async () => {
  const result = await executeTool("synapse.render_prompt", { request: "Build dashboard" });
  assert.equal(result.ok, true);
  assert.equal(typeof result.data.snippet, "string");
});

test("synapse.render_backend_completion_template returns manual backend payload template", async () => {
  const repoRoot = await createTempRepo("mcp-tool-template-");
  try {
    await writeSynapseConfig(repoRoot, {
      require_changes: {
        FRONTEND: false,
        BACKEND: false,
        FRONTEND_TWEAK: false
      }
    });

    const orchestrated = await executeTool("synapse.orchestrate", {
      request: "Manual backend template test",
      repo_root: repoRoot,
      plan: { phases: ["BACKEND"] }
    } as any);
    assert.equal(orchestrated.ok, true);

    const cycleId = orchestrated.data.cycle_id;
    const template = await executeTool("synapse.render_backend_completion_template", {
      cycle_id: cycleId,
      repo_root: repoRoot
    });

    assert.equal(template.ok, true);
    assert.equal(template.data.cycle_id, cycleId);
    assert.equal(template.data.tool, "synapse.phase.complete_manual");
    assert.equal(typeof template.data.phase_id, "string");
    assert.equal(template.data.input_template.cycle_id, cycleId);
    assert.equal(template.data.input_template.phase_id, template.data.phase_id);
    assert.equal(typeof template.data.input_template.output.report.summary, "string");
    assert.equal(Array.isArray(template.data.notes), true);
  } finally {
    await cleanupDir(repoRoot);
  }
});
