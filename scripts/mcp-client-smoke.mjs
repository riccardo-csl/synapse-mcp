import os from "os";
import path from "path";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`ASSERT FAIL: ${msg}`);
  }
}

function parseToolEnvelope(response) {
  const text = response?.content?.[0]?.text;
  assert(typeof text === "string", "tool response must contain text payload");
  return JSON.parse(text);
}

async function callTool(client, name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  return parseToolEnvelope(response);
}

function geminiPayload(cycleId, feature) {
  return {
    cycle_id: cycleId,
    feature,
    producer: "gemini",
    consumer: "codex",
    files_modified: ["web/components/FeatureX.tsx"],
    endpoints: [{ method: "GET", path: "/api/feature-x" }],
    data_shapes: [],
    assumptions: [],
    todos: [],
    notes: [],
    extras: {}
  };
}

async function main() {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-broker-client-smoke-"));
  const repoRoot = process.cwd();
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(repoRoot, "index.js")],
    cwd: tmpRoot,
    stderr: "pipe"
  });
  const client = new Client(
    { name: "mcp-broker-client-smoke", version: "0.1.0" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);

    const first = await callTool(client, "cycle.start", { feature: "featureX" });
    assert(first.ok === false, "cycle.start should fail without PSK config");
    assert(first.error?.code === "CONFIG_INVALID", "error should be CONFIG_INVALID");

    const storageDir = path.join(tmpRoot, ".mcp-broker");
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
            gemini: { psk: "GEMINI_SECRET" },
            codex: { psk: "CODEX_SECRET" }
          }
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const geminiSession = await callTool(client, "session.open", {
      role: "gemini",
      psk: "GEMINI_SECRET"
    });
    const codexSession = await callTool(client, "session.open", {
      role: "codex",
      psk: "CODEX_SECRET"
    });
    assert(geminiSession.ok === true, "gemini session.open should succeed");
    assert(codexSession.ok === true, "codex session.open should succeed");

    const started = await callTool(client, "cycle.start", { feature: "featureX" });
    assert(started.ok === true, "cycle.start should succeed with configured PSKs");
    const cycleId = started.data.cycle_id;
    const feature = "featureX";

    const lock1 = await callTool(client, "lock.acquire", {
      session_token: geminiSession.data.session_token
    });
    assert(lock1.ok === true, "active gemini should acquire lock");

    const badWrite = await callTool(client, "handoff.write", {
      target: "codex",
      payload: geminiPayload(cycleId, feature),
      lock_token: "bad",
      session_token: geminiSession.data.session_token
    });
    assert(badWrite.ok === false, "bad lock token write should fail");
    assert(badWrite.error?.code === "LOCK_DENIED", "bad lock token error should be LOCK_DENIED");

    const goodWrite = await callTool(client, "handoff.write", {
      target: "codex",
      payload: geminiPayload(cycleId, feature),
      lock_token: lock1.data.lock_token,
      session_token: geminiSession.data.session_token
    });
    assert(goodWrite.ok === true, "gemini->codex write should succeed");
    assert(!("lock_token" in goodWrite.data), "handoff.write must not leak lock token");

    const deniedGemini = await callTool(client, "lock.acquire", {
      session_token: geminiSession.data.session_token
    });
    assert(deniedGemini.ok === false, "non-active gemini lock acquire should fail");
    assert(deniedGemini.error?.code === "LOCK_DENIED", "non-active acquire error should be LOCK_DENIED");

    const codexLock = await callTool(client, "lock.acquire", {
      session_token: codexSession.data.session_token
    });
    assert(codexLock.ok === true, "active codex should acquire lock");

    const status = await callTool(client, "cycle.status", {});
    assert(status.ok === true, "cycle.status should succeed");
    assert(!("lock_token" in (status.data.lock || {})), "cycle.status must not expose lock token");

    console.log("MCP CLIENT SMOKE PASSED");
  } finally {
    await client.close().catch(() => {});
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
