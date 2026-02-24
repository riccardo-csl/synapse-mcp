import * as path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { atomicWriteJson, readJsonIfExists } from "../../storage/files.js";
import { nowIso } from "../../core/time.js";
import { synapseError } from "../errors.js";
import type { CycleLockState, RunnerConfig } from "../types.js";
import { CURRENT_SCHEMA_VERSION, DEFAULT_STORAGE_DIR, LOCK_POLL_MS, LOCK_WAIT_MS } from "./constants.js";
import { parseLockOrThrow } from "./parsers.js";
import { ensureSynapseStore } from "./paths.js";
import { loadRunnerConfig } from "./config.js";

export interface CycleLockOptions {
  storageDir?: string;
  ownerId?: string;
  acquire_timeout_ms?: number;
  lockConfig?: RunnerConfig["locks"];
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

function isPidLikelyAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err?.code === "EPERM") return true;
    if (err?.code === "ESRCH") return false;
    return false;
  }
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
): Required<Pick<CycleLockOptions, "storageDir" | "ownerId" | "acquire_timeout_ms">> & { lockConfig?: RunnerConfig["locks"] } {
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
      if (config.pid_liveness_check && isPidLikelyAlive(existing.pid)) {
        // Process still appears alive; avoid false stale takeovers.
      } else {
        const stolen = await stealStaleLock(lockPath, cycleId);
        if (stolen) {
          continue;
        }
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
    if (heartbeatError) return;
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
      // best effort
    }
  }
}
