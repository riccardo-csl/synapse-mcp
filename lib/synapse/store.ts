import * as path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { ensureDir, atomicWriteJson, readJson, readJsonIfExists } from "../storage/files.js";
import { nowIso } from "../core/time.js";
import { synapseError } from "./errors.js";
import type { CycleLockState, CycleSpec, CycleStatus, RunnerConfig } from "./types.js";
import { cycleLockSchema, cycleSpecSchema, parseOrSchemaError, runnerConfigSchema } from "./schemas.js";

const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 50;
const CURRENT_SCHEMA_VERSION = 1;

export const DEFAULT_STORAGE_DIR = ".synapse";

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  schema_version: CURRENT_SCHEMA_VERSION,
  storage_dir: DEFAULT_STORAGE_DIR,
  checks: {
    FRONTEND: [],
    BACKEND: [],
    FRONTEND_TWEAK: []
  },
  require_changes: {
    FRONTEND: false,
    BACKEND: true,
    FRONTEND_TWEAK: false
  },
  adapters: {
    gemini: {
      mode: "stub",
      command: "gemini"
    },
    codexExec: {
      command: "codex exec"
    }
  },
  locks: {
    ttl_ms: 20_000,
    heartbeat_ms: 5_000,
    takeover_grace_ms: 2_000
  },
  denylist_substrings: ["rm -rf /", "git reset --hard", "git clean -fdx"]
};

export interface SynapsePaths {
  rootDir: string;
  cyclesDir: string;
  locksDir: string;
  configPath: string;
}

export interface CycleLockOptions {
  storageDir?: string;
  ownerId?: string;
  acquire_timeout_ms?: number;
  lockConfig?: RunnerConfig["locks"];
}

export function synapsePaths(repoRoot: string, storageDir = DEFAULT_STORAGE_DIR): SynapsePaths {
  const rootDir = path.join(repoRoot, storageDir);
  return {
    rootDir,
    cyclesDir: path.join(rootDir, "cycles"),
    locksDir: path.join(rootDir, "locks"),
    configPath: path.join(rootDir, "config.json")
  };
}

export async function ensureSynapseStore(repoRoot: string, storageDir = DEFAULT_STORAGE_DIR): Promise<SynapsePaths> {
  const paths = synapsePaths(repoRoot, storageDir);
  await ensureDir(paths.rootDir);
  await ensureDir(paths.cyclesDir);
  await ensureDir(paths.locksDir);
  return paths;
}

function parseCycleOrThrow(raw: unknown, cycleId: string): CycleSpec {
  const version = (raw && typeof raw === "object" && typeof (raw as any).schema_version === "number")
    ? (raw as any).schema_version
    : 1;
  if (version > CURRENT_SCHEMA_VERSION) {
    throw synapseError("UNSUPPORTED_VERSION", `Cycle schema version ${version} is not supported`, {
      cycle_id: cycleId,
      schema_version: version,
      supported_schema_version: CURRENT_SCHEMA_VERSION
    });
  }

  try {
    return parseOrSchemaError(cycleSpecSchema, raw, `Invalid cycle JSON for ${cycleId}`) as CycleSpec;
  } catch (err: any) {
    if (err?.code === "SCHEMA_INVALID") {
      throw synapseError("CYCLE_CORRUPT", `Cycle file is invalid: ${cycleId}`, {
        cycle_id: cycleId,
        issues: err?.details?.issues || []
      });
    }
    throw err;
  }
}

function parseLockOrThrow(raw: unknown, cycleId: string): CycleLockState {
  const schemaVersion = (raw && typeof raw === "object" && typeof (raw as any).schema_version === "number")
    ? (raw as any).schema_version
    : 1;
  const lockVersion = (raw && typeof raw === "object" && typeof (raw as any).lock_version === "number")
    ? (raw as any).lock_version
    : 1;
  if (schemaVersion > CURRENT_SCHEMA_VERSION || lockVersion > 1) {
    throw synapseError("UNSUPPORTED_VERSION", `Lock schema version is not supported for cycle ${cycleId}`, {
      cycle_id: cycleId,
      schema_version: schemaVersion,
      lock_version: lockVersion,
      supported_schema_version: CURRENT_SCHEMA_VERSION,
      supported_lock_version: 1
    });
  }

  try {
    return parseOrSchemaError(cycleLockSchema, raw, `Invalid lock JSON for ${cycleId}`) as CycleLockState;
  } catch (err: any) {
    if (err?.code === "SCHEMA_INVALID") {
      throw synapseError("LOCK_CORRUPT", `Lock file is invalid for cycle ${cycleId}`, {
        cycle_id: cycleId,
        issues: err?.details?.issues || []
      });
    }
    throw err;
  }
}

function mergeRunnerConfig(current: unknown): RunnerConfig {
  const source = (current || {}) as Record<string, any>;
  const version = typeof source.schema_version === "number" ? source.schema_version : 1;
  if (version > CURRENT_SCHEMA_VERSION) {
    throw synapseError("UNSUPPORTED_VERSION", `Config schema version ${version} is not supported`, {
      schema_version: version,
      supported_schema_version: CURRENT_SCHEMA_VERSION
    });
  }
  const merged: RunnerConfig = {
    ...DEFAULT_RUNNER_CONFIG,
    ...source,
    checks: {
      ...DEFAULT_RUNNER_CONFIG.checks,
      ...(source.checks || {})
    },
    require_changes: {
      ...DEFAULT_RUNNER_CONFIG.require_changes,
      ...(source.require_changes || {})
    },
    adapters: {
      gemini: {
        ...DEFAULT_RUNNER_CONFIG.adapters.gemini,
        ...(source.adapters?.gemini || {})
      },
      codexExec: {
        ...DEFAULT_RUNNER_CONFIG.adapters.codexExec,
        ...(source.adapters?.codexExec || {})
      }
    },
    locks: {
      ...DEFAULT_RUNNER_CONFIG.locks,
      ...(source.locks || {})
    },
    denylist_substrings: Array.isArray(source.denylist_substrings)
      ? source.denylist_substrings
      : DEFAULT_RUNNER_CONFIG.denylist_substrings
  };

  return parseOrSchemaError(runnerConfigSchema, merged, "Invalid .synapse/config.json") as RunnerConfig;
}

export async function loadRunnerConfig(repoRoot: string, storageDir = DEFAULT_STORAGE_DIR): Promise<RunnerConfig> {
  const paths = await ensureSynapseStore(repoRoot, storageDir);
  let current: unknown;
  try {
    current = await readJsonIfExists(paths.configPath);
  } catch (err: any) {
    throw synapseError("CONFIG_INVALID", "Invalid .synapse/config.json (malformed JSON)", {
      error: err?.message || String(err)
    });
  }
  if (!current) {
    await atomicWriteJson(paths.configPath, DEFAULT_RUNNER_CONFIG);
    return DEFAULT_RUNNER_CONFIG;
  }

  try {
    return mergeRunnerConfig(current);
  } catch (err: any) {
    if (err?.code === "SCHEMA_INVALID") {
      throw synapseError("CONFIG_INVALID", err.message, err?.details || {});
    }
    throw err;
  }
}

export async function writeCycle(repoRoot: string, cycle: CycleSpec, storageDir = DEFAULT_STORAGE_DIR): Promise<void> {
  const paths = await ensureSynapseStore(repoRoot, storageDir);
  const validated = parseOrSchemaError(cycleSpecSchema, cycle, `Refusing to write invalid cycle ${cycle.id}`) as CycleSpec;
  const filePath = path.join(paths.cyclesDir, `${validated.id}.json`);
  await atomicWriteJson(filePath, validated);
}

export async function readCycle(repoRoot: string, cycleId: string, storageDir = DEFAULT_STORAGE_DIR): Promise<CycleSpec> {
  const paths = await ensureSynapseStore(repoRoot, storageDir);
  const filePath = path.join(paths.cyclesDir, `${cycleId}.json`);
  let cycle: unknown;
  try {
    cycle = await readJsonIfExists(filePath);
  } catch (err: any) {
    throw synapseError("CYCLE_CORRUPT", `Cycle file is malformed JSON: ${cycleId}`, {
      cycle_id: cycleId,
      error: err?.message || String(err)
    });
  }
  if (!cycle) {
    throw synapseError("CYCLE_NOT_FOUND", `cycle not found: ${cycleId}`, { cycle_id: cycleId });
  }
  return parseCycleOrThrow(cycle, cycleId);
}

export async function listCycles(
  repoRoot: string,
  {
    limit,
    status,
    storageDir = DEFAULT_STORAGE_DIR
  }: { limit?: number; status?: CycleStatus; storageDir?: string } = {}
): Promise<CycleSpec[]> {
  const paths = await ensureSynapseStore(repoRoot, storageDir);
  const entries = await fs.readdir(paths.cyclesDir);
  const cycles: CycleSpec[] = [];

  for (const name of entries) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(paths.cyclesDir, name);
    let raw: unknown;
    try {
      raw = await readJson(filePath);
    } catch (err: any) {
      throw synapseError("CYCLE_CORRUPT", `Cycle file is malformed JSON: ${name}`, {
        cycle_id: name.replace(/\.json$/, ""),
        error: err?.message || String(err)
      });
    }
    const cycle = parseCycleOrThrow(raw, name.replace(/\.json$/, ""));
    if (status && cycle.status !== status) {
      continue;
    }
    cycles.push(cycle);
  }

  cycles.sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (typeof limit === "number" && limit > 0) {
    return cycles.slice(0, limit);
  }
  return cycles;
}

function toLockState(cycleId: string, ownerId: string, ttlMs: number, createdAt?: string): CycleLockState {
  const base = createdAt || nowIso();
  const heartbeatAt = nowIso();
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    lock_version: 1,
    cycle_id: cycleId,
    owner_id: ownerId,
    pid: process.pid,
    created_at: base,
    heartbeat_at: heartbeatAt,
    expires_at: new Date(Date.now() + ttlMs).toISOString()
  };
}

async function quarantineCorruptLock(lockPath: string): Promise<void> {
  const corruptPath = `${lockPath}.corrupt.${Date.now()}.${randomBytes(4).toString("hex")}`;
  await fs.rename(lockPath, corruptPath).catch((err: any) => {
    if (err?.code === "ENOENT") {
      return;
    }
    throw err;
  });
}

async function readLockFile(lockPath: string, cycleId: string): Promise<CycleLockState | null> {
  let raw: unknown;
  try {
    raw = await readJsonIfExists(lockPath);
  } catch (err: any) {
    throw synapseError("LOCK_CORRUPT", `Lock file is malformed JSON for cycle ${cycleId}`, {
      cycle_id: cycleId,
      error: err?.message || String(err)
    });
  }
  if (!raw) {
    return null;
  }
  return parseLockOrThrow(raw, cycleId);
}

function isStale(lock: CycleLockState, takeoverGraceMs: number): boolean {
  const expiresAt = Date.parse(lock.expires_at);
  if (!Number.isFinite(expiresAt)) {
    return true;
  }
  return Date.now() > expiresAt + takeoverGraceMs;
}

async function acquireNewLock(lockPath: string, state: CycleLockState): Promise<boolean> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(lockPath, "wx");
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    return true;
  } catch (err: any) {
    if (err?.code === "EEXIST") {
      return false;
    }
    throw err;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function stealStaleLock(lockPath: string, cycleId: string): Promise<boolean> {
  const stalePath = `${lockPath}.stale.${Date.now()}.${randomBytes(4).toString("hex")}`;
  try {
    await fs.rename(lockPath, stalePath);
    await fs.unlink(stalePath).catch(() => {});
    return true;
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return false;
    }
    throw synapseError("LOCK_STALE_TAKEOVER_FAILED", `Failed to takeover stale lock for cycle ${cycleId}`, {
      cycle_id: cycleId,
      error: err?.message || String(err)
    });
  }
}

function normalizeLockOptions(
  maybe: string | CycleLockOptions | undefined
): Required<Pick<CycleLockOptions, "storageDir" | "ownerId" | "acquire_timeout_ms">> & {
  lockConfig?: RunnerConfig["locks"];
} {
  if (typeof maybe === "string") {
    return {
      storageDir: maybe,
      ownerId: `pid-${process.pid}-${randomBytes(6).toString("hex")}`,
      acquire_timeout_ms: LOCK_WAIT_MS
    };
  }

  return {
    storageDir: maybe?.storageDir || DEFAULT_STORAGE_DIR,
    ownerId: maybe?.ownerId || `pid-${process.pid}-${randomBytes(6).toString("hex")}`,
    acquire_timeout_ms: maybe?.acquire_timeout_ms || LOCK_WAIT_MS,
    lockConfig: maybe?.lockConfig
  };
}

async function heartbeatLock(lockPath: string, cycleId: string, ownerId: string, ttlMs: number): Promise<void> {
  const existing = await readLockFile(lockPath, cycleId);
  if (!existing) {
    throw synapseError("LOCK_HEARTBEAT_FAILED", "Lock disappeared during heartbeat", {
      cycle_id: cycleId,
      owner_id: ownerId
    });
  }
  if (existing.owner_id !== ownerId) {
    throw synapseError("LOCK_HEARTBEAT_FAILED", "Lock ownership changed during heartbeat", {
      cycle_id: cycleId,
      owner_id: ownerId,
      current_owner: existing.owner_id
    });
  }

  const updated = toLockState(cycleId, ownerId, ttlMs, existing.created_at);
  await atomicWriteJson(lockPath, updated);
}

export async function withCycleLock<T>(
  repoRoot: string,
  cycleId: string,
  fn: () => Promise<T>,
  optionsOrStorageDir?: string | CycleLockOptions
): Promise<T> {
  const opts = normalizeLockOptions(optionsOrStorageDir);
  const paths = await ensureSynapseStore(repoRoot, opts.storageDir);
  const lockPath = path.join(paths.locksDir, `${cycleId}.lock`);

  const config = opts.lockConfig || (await loadRunnerConfig(repoRoot, opts.storageDir)).locks;
  const acquireTimeoutMs = opts.acquire_timeout_ms;
  const start = Date.now();

  while (true) {
    const lockState = toLockState(cycleId, opts.ownerId, config.ttl_ms);
    const acquired = await acquireNewLock(lockPath, lockState);
    if (acquired) {
      break;
    }

    let existing: CycleLockState | null = null;
    try {
      existing = await readLockFile(lockPath, cycleId);
    } catch (err: any) {
      if (err?.code === "LOCK_CORRUPT") {
        await quarantineCorruptLock(lockPath);
        continue;
      }
      throw err;
    }
    if (existing && isStale(existing, config.takeover_grace_ms)) {
      const stolen = await stealStaleLock(lockPath, cycleId);
      if (stolen) {
        continue;
      }
    }

    if (Date.now() - start > acquireTimeoutMs) {
      throw synapseError("LOCK_HELD", `lock timeout for cycle ${cycleId}`, {
        cycle_id: cycleId,
        waited_ms: Date.now() - start
      });
    }

    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }

  let heartbeatError: Error | null = null;
  const interval = setInterval(async () => {
    if (heartbeatError) {
      return;
    }
    try {
      await heartbeatLock(lockPath, cycleId, opts.ownerId, config.ttl_ms);
    } catch (err: any) {
      heartbeatError = err;
    }
  }, config.heartbeat_ms);

  try {
    const result = await fn();
    if (heartbeatError) {
      throw heartbeatError;
    }
    return result;
  } finally {
    clearInterval(interval);

    try {
      const existing = await readLockFile(lockPath, cycleId);
      if (existing?.owner_id === opts.ownerId) {
        await fs.unlink(lockPath).catch(() => {});
      }
    } catch {
      // noop: lock release best effort
    }
  }
}
