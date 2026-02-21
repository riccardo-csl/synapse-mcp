import test from "node:test";
import assert from "node:assert/strict";

import { executeTool } from "../../lib/mcp/handlers.js";

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
