import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";

import { createCycleSpec } from "../../lib/synapse/stateMachine.js";
import { CURRENT_SCHEMA_VERSION, DEFAULT_RUNNER_CONFIG, ensureSynapseStore } from "../../lib/synapse/store.js";
import { detectMigrationStatus, migrateStore } from "../../lib/synapse/migrate.js";
import { cleanupDir, createTempRepo } from "../helpers/synapse-fixtures.js";

test("migration detect + apply updates legacy schema_version files", async () => {
  const repoRoot = await createTempRepo("synapse-migrate-apply-");
  try {
    const paths = await ensureSynapseStore(repoRoot);
    const cycle = createCycleSpec({
      request: "Legacy cycle",
      repo_root: repoRoot,
      constraints: [],
      phases: ["BACKEND"]
    });

    await fs.writeFile(
      paths.configPath,
      JSON.stringify({ ...DEFAULT_RUNNER_CONFIG, schema_version: 0 }, null, 2) + "\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(paths.cyclesDir, `${cycle.id}.json`),
      JSON.stringify({ ...cycle, schema_version: 0 }, null, 2) + "\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(paths.locksDir, `${cycle.id}.lock`),
      JSON.stringify({
        schema_version: 0,
        lock_version: 1,
        cycle_id: cycle.id,
        owner_id: "legacy-runner",
        pid: process.pid,
        created_at: new Date(Date.now() - 60_000).toISOString(),
        heartbeat_at: new Date(Date.now() - 30_000).toISOString(),
        expires_at: new Date(Date.now() + 30_000).toISOString()
      }, null, 2) + "\n",
      "utf8"
    );

    const status = await detectMigrationStatus(repoRoot);
    assert.equal(status.migration_needed, true);
    assert.equal(status.config_version, 0);
    assert.equal(status.cycles.needs_migration, 1);
    assert.equal(status.locks.needs_migration, 1);

    const dryRun = await migrateStore(repoRoot, { dryRun: true });
    assert.equal(dryRun.files_to_update, 3);
    assert.equal(dryRun.updated_files, 0);

    const apply = await migrateStore(repoRoot, { dryRun: false });
    assert.equal(apply.files_to_update, 3);
    assert.equal(apply.updated_files, 3);

    const configRaw = JSON.parse(await fs.readFile(paths.configPath, "utf8"));
    const cycleRaw = JSON.parse(await fs.readFile(path.join(paths.cyclesDir, `${cycle.id}.json`), "utf8"));
    const lockRaw = JSON.parse(await fs.readFile(path.join(paths.locksDir, `${cycle.id}.lock`), "utf8"));
    assert.equal(configRaw.schema_version, CURRENT_SCHEMA_VERSION);
    assert.equal(cycleRaw.schema_version, CURRENT_SCHEMA_VERSION);
    assert.equal(lockRaw.schema_version, CURRENT_SCHEMA_VERSION);
  } finally {
    await cleanupDir(repoRoot);
  }
});

test("migration reports unsupported future schema files", async () => {
  const repoRoot = await createTempRepo("synapse-migrate-unsupported-");
  try {
    const paths = await ensureSynapseStore(repoRoot);
    const cycle = createCycleSpec({
      request: "future cycle",
      repo_root: repoRoot,
      constraints: [],
      phases: ["BACKEND"]
    });

    await fs.writeFile(
      path.join(paths.cyclesDir, `${cycle.id}.json`),
      JSON.stringify({ ...cycle, schema_version: CURRENT_SCHEMA_VERSION + 1 }, null, 2) + "\n",
      "utf8"
    );

    const status = await detectMigrationStatus(repoRoot);
    assert.equal(status.cycles.unsupported, 1);
    assert.equal(status.migration_needed, true);

    const report = await migrateStore(repoRoot, { dryRun: true });
    assert.equal(report.unsupported_files.length, 1);
    assert.equal(report.updated_files, 0);
  } finally {
    await cleanupDir(repoRoot);
  }
});
