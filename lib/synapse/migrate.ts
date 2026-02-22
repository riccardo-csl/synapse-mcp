import * as path from "node:path";
import { promises as fs } from "node:fs";
import { atomicWriteJson, readJson, readJsonIfExists } from "../storage/files.js";
import { synapseError } from "./errors.js";
import { cycleLockSchema, cycleSpecSchema, parseOrSchemaError, runnerConfigSchema } from "./schemas.js";
import { CURRENT_SCHEMA_VERSION, DEFAULT_STORAGE_DIR, ensureSynapseStore, synapsePaths } from "./store.js";

type FileKind = "config" | "cycle" | "lock";

interface TargetFile {
  kind: FileKind;
  absPath: string;
  id: string;
}

export interface MigrationStatus {
  current_schema_version: number;
  config_version: number | null;
  cycles: { total: number; needs_migration: number; unsupported: number };
  locks: { total: number; needs_migration: number; unsupported: number };
  migration_needed: boolean;
}

export interface MigrationReport {
  current_schema_version: number;
  dry_run: boolean;
  scanned_files: number;
  files_to_update: number;
  updated_files: number;
  unsupported_files: Array<{ path: string; schema_version: number }>;
}

function extractVersion(raw: unknown): number {
  if (raw && typeof raw === "object" && typeof (raw as any).schema_version === "number") {
    return (raw as any).schema_version;
  }
  return 0;
}

function ensureObject(raw: unknown, kind: FileKind, filePath: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const code = kind === "config" ? "CONFIG_INVALID" : kind === "lock" ? "LOCK_CORRUPT" : "CYCLE_CORRUPT";
    throw synapseError(code, `Invalid ${kind} payload shape`, { path: filePath });
  }
  return raw as Record<string, unknown>;
}

function validateByKind(kind: FileKind, raw: unknown, filePath: string): void {
  try {
    if (kind === "config") {
      parseOrSchemaError(runnerConfigSchema, raw, "Invalid runner config payload");
      return;
    }
    if (kind === "lock") {
      parseOrSchemaError(cycleLockSchema, raw, "Invalid lock payload");
      return;
    }
    parseOrSchemaError(cycleSpecSchema, raw, "Invalid cycle payload");
  } catch (err: any) {
    if (err?.code === "SCHEMA_INVALID") {
      const code = kind === "config" ? "CONFIG_INVALID" : kind === "lock" ? "LOCK_CORRUPT" : "CYCLE_CORRUPT";
      throw synapseError(code, `Invalid ${kind} schema`, {
        path: filePath,
        issues: err?.details?.issues || []
      });
    }
    throw err;
  }
}

async function collectTargetFiles(repoRoot: string, storageDir = DEFAULT_STORAGE_DIR): Promise<TargetFile[]> {
  const paths = await ensureSynapseStore(repoRoot, storageDir);
  const targets: TargetFile[] = [
    { kind: "config", absPath: paths.configPath, id: "config" }
  ];

  const cycleNames = await fs.readdir(paths.cyclesDir);
  for (const name of cycleNames) {
    if (name.endsWith(".json")) {
      targets.push({
        kind: "cycle",
        absPath: path.join(paths.cyclesDir, name),
        id: name.replace(/\.json$/, "")
      });
    }
  }

  const lockNames = await fs.readdir(paths.locksDir);
  for (const name of lockNames) {
    if (name.endsWith(".lock")) {
      targets.push({
        kind: "lock",
        absPath: path.join(paths.locksDir, name),
        id: name.replace(/\.lock$/, "")
      });
    }
  }

  return targets;
}

async function readTarget(target: TargetFile): Promise<unknown | null> {
  try {
    if (target.kind === "config") {
      return await readJsonIfExists(target.absPath);
    }
    return await readJson(target.absPath);
  } catch (err: any) {
    const code = target.kind === "config" ? "CONFIG_INVALID" : target.kind === "lock" ? "LOCK_CORRUPT" : "CYCLE_CORRUPT";
    throw synapseError(code, `Malformed JSON in ${target.kind} file`, {
      path: target.absPath,
      error: err?.message || String(err)
    });
  }
}

export async function detectMigrationStatus(repoRoot: string, storageDir = DEFAULT_STORAGE_DIR): Promise<MigrationStatus> {
  const paths = synapsePaths(repoRoot, storageDir);
  const targets = await collectTargetFiles(repoRoot, storageDir);

  let configVersion: number | null = null;
  let cycleTotal = 0;
  let cycleNeeds = 0;
  let cycleUnsupported = 0;
  let lockTotal = 0;
  let lockNeeds = 0;
  let lockUnsupported = 0;

  for (const target of targets) {
    const raw = await readTarget(target);
    if (!raw) {
      continue;
    }
    const version = extractVersion(raw);

    if (target.kind === "config") {
      configVersion = version;
      continue;
    }

    if (target.kind === "cycle") {
      cycleTotal += 1;
      if (version < CURRENT_SCHEMA_VERSION) {
        cycleNeeds += 1;
      }
      if (version > CURRENT_SCHEMA_VERSION) {
        cycleUnsupported += 1;
      }
      continue;
    }

    lockTotal += 1;
    if (version < CURRENT_SCHEMA_VERSION) {
      lockNeeds += 1;
    }
    if (version > CURRENT_SCHEMA_VERSION) {
      lockUnsupported += 1;
    }
  }

  const configNeedsMigration = configVersion !== null && configVersion < CURRENT_SCHEMA_VERSION;
  const configUnsupported = configVersion !== null && configVersion > CURRENT_SCHEMA_VERSION;

  return {
    current_schema_version: CURRENT_SCHEMA_VERSION,
    config_version: configVersion,
    cycles: {
      total: cycleTotal,
      needs_migration: cycleNeeds,
      unsupported: cycleUnsupported
    },
    locks: {
      total: lockTotal,
      needs_migration: lockNeeds,
      unsupported: lockUnsupported
    },
    migration_needed: Boolean(configNeedsMigration || cycleNeeds > 0 || lockNeeds > 0 || configUnsupported || cycleUnsupported > 0 || lockUnsupported > 0)
  };
}

export async function migrateStore(
  repoRoot: string,
  { dryRun = false, storageDir = DEFAULT_STORAGE_DIR }: { dryRun?: boolean; storageDir?: string } = {}
): Promise<MigrationReport> {
  const targets = await collectTargetFiles(repoRoot, storageDir);
  const unsupportedFiles: Array<{ path: string; schema_version: number }> = [];

  let scanned = 0;
  let toUpdate = 0;
  let updated = 0;

  for (const target of targets) {
    const rawMaybe = await readTarget(target);
    if (rawMaybe == null) {
      continue;
    }

    scanned += 1;
    const raw = ensureObject(rawMaybe, target.kind, target.absPath);
    const version = extractVersion(raw);

    if (version > CURRENT_SCHEMA_VERSION) {
      unsupportedFiles.push({ path: target.absPath, schema_version: version });
      continue;
    }

    const migrated = { ...raw, schema_version: CURRENT_SCHEMA_VERSION };
    validateByKind(target.kind, migrated, target.absPath);

    if (version < CURRENT_SCHEMA_VERSION) {
      toUpdate += 1;
      if (!dryRun) {
        await atomicWriteJson(target.absPath, migrated);
        updated += 1;
      }
    }
  }

  return {
    current_schema_version: CURRENT_SCHEMA_VERSION,
    dry_run: dryRun,
    scanned_files: scanned,
    files_to_update: toUpdate,
    updated_files: updated,
    unsupported_files: unsupportedFiles
  };
}
