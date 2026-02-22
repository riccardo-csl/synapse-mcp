import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";

import { loadRunnerConfig } from "../../lib/synapse/store.js";
import { cleanupDir, createTempRepo } from "../helpers/synapse-fixtures.js";

test("loadRunnerConfig rejects invalid config with CONFIG_INVALID", async () => {
  const repoRoot = await createTempRepo("synapse-config-invalid-");
  try {
    const synapseDir = path.join(repoRoot, ".synapse");
    await fs.mkdir(synapseDir, { recursive: true });
    await fs.writeFile(
      path.join(synapseDir, "config.json"),
      JSON.stringify({
        schema_version: 1,
        storage_dir: ".synapse",
        checks: { FRONTEND: [], BACKEND: [], FRONTEND_TWEAK: [] },
        require_changes: { FRONTEND: false, BACKEND: true, FRONTEND_TWEAK: false },
        adapters: {
          gemini: { mode: "stub", command: "gemini" },
          codexExec: { command: "codex exec" }
        },
        locks: { ttl_ms: -1, heartbeat_ms: 100, takeover_grace_ms: 0 },
        denylist_substrings: []
      }, null, 2) + "\n",
      "utf8"
    );

    await assert.rejects(
      () => loadRunnerConfig(repoRoot),
      (err: any) => err?.code === "CONFIG_INVALID"
    );
  } finally {
    await cleanupDir(repoRoot);
  }
});

test("loadRunnerConfig rejects unsupported schema version", async () => {
  const repoRoot = await createTempRepo("synapse-config-unsupported-");
  try {
    const synapseDir = path.join(repoRoot, ".synapse");
    await fs.mkdir(synapseDir, { recursive: true });
    await fs.writeFile(
      path.join(synapseDir, "config.json"),
      JSON.stringify({
        schema_version: 2,
        storage_dir: ".synapse",
        checks: { FRONTEND: [], BACKEND: [], FRONTEND_TWEAK: [] },
        require_changes: { FRONTEND: false, BACKEND: true, FRONTEND_TWEAK: false },
        adapters: {
          gemini: { mode: "stub", command: "gemini" },
          codexExec: { command: "codex exec" }
        },
        locks: { ttl_ms: 20000, heartbeat_ms: 1000, takeover_grace_ms: 0 },
        denylist_substrings: []
      }, null, 2) + "\n",
      "utf8"
    );

    await assert.rejects(
      () => loadRunnerConfig(repoRoot),
      (err: any) => err?.code === "UNSUPPORTED_VERSION"
    );
  } finally {
    await cleanupDir(repoRoot);
  }
});
