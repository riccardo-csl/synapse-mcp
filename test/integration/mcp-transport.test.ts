import os from "os";
import path from "path";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";

import { callTool, createMcpClient } from "../helpers/mcp-client.js";
import { GEMINI_PSK } from "../helpers/broker-fixtures.js";

const serverPath = path.resolve(process.cwd(), "dist/index.js");

async function writeBrokerConfig(rootDir) {
  const storageDir = path.join(rootDir, ".mcp-broker");
  await mkdir(storageDir, { recursive: true });
  await writeFile(
    path.join(storageDir, "config.json"),
    JSON.stringify(
      {
        version: "0.1",
        mode: "approval",
        validation: "basic",
        storage_path: ".mcp-broker",
        agents: {
          gemini: { psk: GEMINI_PSK },
          codex: { psk: "CODEX_SECRET" }
        }
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

test("MCP layer returns structured errors for broker failures", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-broker-mcp-errors-"));
  let client;
  try {
    client = await createMcpClient({ serverPath, cwd: tmpRoot });
    const result = await callTool(client, "cycle.start", { feature: "featureX" });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "CONFIG_INVALID");
    assert.equal(typeof result.error.message, "string");
    assert.equal(typeof result.error.details, "object");
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("MCP layer enforces auth and preserves no-token-leak responses", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-broker-mcp-flow-"));
  let client;
  try {
    await writeBrokerConfig(tmpRoot);
    client = await createMcpClient({ serverPath, cwd: tmpRoot });

    const geminiSession = await callTool(client, "session.open", {
      role: "gemini",
      psk: GEMINI_PSK
    });
    assert.equal(geminiSession.ok, true);

    const started = await callTool(client, "cycle.start", { feature: "featureX" });
    assert.equal(started.ok, true);

    const lock = await callTool(client, "lock.acquire", {
      session_token: geminiSession.data.session_token
    });
    assert.equal(lock.ok, true);

    const write = await callTool(client, "handoff.write", {
      target: "codex",
      payload: {
        cycle_id: started.data.cycle_id,
        feature: "featureX",
        producer: "gemini",
        consumer: "codex",
        files_modified: ["web/components/FeatureX.tsx"],
        endpoints: [{ method: "GET", path: "/api/feature-x" }],
        data_shapes: [],
        assumptions: [],
        todos: [],
        notes: [],
        extras: {}
      },
      lock_token: lock.data.lock_token,
      session_token: geminiSession.data.session_token
    });

    assert.equal(write.ok, true);
    assert.equal("lock_token" in write.data, false);

    const status = await callTool(client, "cycle.status");
    assert.equal(status.ok, true);
    assert.equal("lock_token" in (status.data.lock || {}), false);
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
    await rm(tmpRoot, { recursive: true, force: true });
  }
});
