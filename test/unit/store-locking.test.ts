import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";

import { ensureSynapseStore, readCycle, withCycleLock } from "../../lib/synapse/store.js";
import { cleanupDir, createTempRepo } from "../helpers/synapse-fixtures.js";

test("withCycleLock denies concurrent holder with LOCK_HELD", async () => {
  const repoRoot = await createTempRepo("synapse-lock-held-");
  try {
    await withCycleLock(repoRoot, "cycle-a", async () => {
      await assert.rejects(
        () => withCycleLock(repoRoot, "cycle-a", async () => "nope", {
          ownerId: "runner-b",
          acquire_timeout_ms: 150,
          lockConfig: {
            ttl_ms: 5_000,
            heartbeat_ms: 1_000,
            takeover_grace_ms: 5_000
          }
        }),
        (err: any) => err?.code === "LOCK_HELD"
      );
    }, {
      ownerId: "runner-a",
      lockConfig: {
        ttl_ms: 5_000,
        heartbeat_ms: 50,
        takeover_grace_ms: 5_000
      }
    });
  } finally {
    await cleanupDir(repoRoot);
  }
});

test("withCycleLock takes over stale lock", async () => {
  const repoRoot = await createTempRepo("synapse-lock-stale-");
  try {
    const paths = await ensureSynapseStore(repoRoot);
    const lockPath = path.join(paths.locksDir, "cycle-b.lock");
    const stale = {
      schema_version: 1,
      lock_version: 1,
      cycle_id: "cycle-b",
      owner_id: "dead-runner",
      pid: 99999,
      created_at: new Date(Date.now() - 60_000).toISOString(),
      heartbeat_at: new Date(Date.now() - 60_000).toISOString(),
      expires_at: new Date(Date.now() - 30_000).toISOString()
    };
    await fs.writeFile(lockPath, JSON.stringify(stale, null, 2) + "\n", "utf8");

    const result = await withCycleLock(repoRoot, "cycle-b", async () => "ok", {
      ownerId: "runner-new",
      acquire_timeout_ms: 500,
      lockConfig: {
        ttl_ms: 1_000,
        heartbeat_ms: 25,
        takeover_grace_ms: 0
      }
    });

    assert.equal(result, "ok");
  } finally {
    await cleanupDir(repoRoot);
  }
});

test("withCycleLock quarantines corrupt lock and recovers", async () => {
  const repoRoot = await createTempRepo("synapse-lock-corrupt-");
  try {
    const paths = await ensureSynapseStore(repoRoot);
    const lockPath = path.join(paths.locksDir, "cycle-c.lock");
    await fs.writeFile(lockPath, "{\"lock_version\":1,\"cycle_id\":", "utf8");

    const result = await withCycleLock(repoRoot, "cycle-c", async () => "recovered", {
      ownerId: "runner-recover",
      acquire_timeout_ms: 500,
      lockConfig: {
        ttl_ms: 1_000,
        heartbeat_ms: 25,
        takeover_grace_ms: 0
      }
    });

    assert.equal(result, "recovered");
    const entries = await fs.readdir(paths.locksDir);
    assert.ok(entries.some((name) => name.includes("cycle-c.lock.corrupt.")));
  } finally {
    await cleanupDir(repoRoot);
  }
});

test("readCycle rejects corrupt cycle payloads", async () => {
  const repoRoot = await createTempRepo("synapse-corrupt-cycle-");
  try {
    const paths = await ensureSynapseStore(repoRoot);
    await fs.writeFile(
      path.join(paths.cyclesDir, "bad-cycle.json"),
      JSON.stringify({ id: "bad-cycle", status: "RUNNING" }, null, 2) + "\n",
      "utf8"
    );

    await assert.rejects(
      () => readCycle(repoRoot, "bad-cycle"),
      (err: any) => err?.code === "CYCLE_CORRUPT"
    );
  } finally {
    await cleanupDir(repoRoot);
  }
});

test("readCycle rejects unsupported schema version", async () => {
  const repoRoot = await createTempRepo("synapse-unsupported-cycle-");
  try {
    const paths = await ensureSynapseStore(repoRoot);
    await fs.writeFile(
      path.join(paths.cyclesDir, "future-cycle.json"),
      JSON.stringify({
        schema_version: 2,
        id: "future-cycle",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        request_text: "future",
        repo_root: repoRoot,
        constraints: [],
        phases: [],
        status: "QUEUED",
        current_phase_index: null,
        artifacts: {
          changed_files: [],
          commands_run: [],
          test_results: [],
          phase_durations_ms: {},
          attempt_history: []
        },
        logs: [],
        last_error: null,
        canceled_reason: null
      }, null, 2) + "\n",
      "utf8"
    );

    await assert.rejects(
      () => readCycle(repoRoot, "future-cycle"),
      (err: any) => err?.code === "UNSUPPORTED_VERSION"
    );
  } finally {
    await cleanupDir(repoRoot);
  }
});
