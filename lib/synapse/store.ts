import * as path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { ensureDir, atomicWriteJson, readJson, readJsonIfExists } from "../storage/files.js";
import { nowIso } from "../core/time.js";
import { synapseError } from "./errors.js";
import type { CycleSpec, CycleStatus, RunnerConfig } from "./types.js";

const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 50;

export const DEFAULT_STORAGE_DIR = ".synapse";

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
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
  denylist_substrings: ["rm -rf /", "git reset --hard", "git clean -fdx"]
};

export interface SynapsePaths {
  rootDir: string;
  cyclesDir: string;
  locksDir: string;
  configPath: string;
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

export async function loadRunnerConfig(repoRoot: string, storageDir = DEFAULT_STORAGE_DIR): Promise<RunnerConfig> {
  const paths = await ensureSynapseStore(repoRoot, storageDir);
  const current = await readJsonIfExists(paths.configPath);
  if (!current) {
    await atomicWriteJson(paths.configPath, DEFAULT_RUNNER_CONFIG);
    return DEFAULT_RUNNER_CONFIG;
  }
  return {
    ...DEFAULT_RUNNER_CONFIG,
    ...current,
    checks: {
      ...DEFAULT_RUNNER_CONFIG.checks,
      ...(current.checks || {})
    },
    require_changes: {
      ...DEFAULT_RUNNER_CONFIG.require_changes,
      ...(current.require_changes || {})
    },
    adapters: {
      gemini: {
        ...DEFAULT_RUNNER_CONFIG.adapters.gemini,
        ...(current.adapters?.gemini || {})
      },
      codexExec: {
        ...DEFAULT_RUNNER_CONFIG.adapters.codexExec,
        ...(current.adapters?.codexExec || {})
      }
    },
    denylist_substrings: Array.isArray(current.denylist_substrings)
      ? current.denylist_substrings
      : DEFAULT_RUNNER_CONFIG.denylist_substrings
  };
}

export async function writeCycle(repoRoot: string, cycle: CycleSpec, storageDir = DEFAULT_STORAGE_DIR): Promise<void> {
  const paths = await ensureSynapseStore(repoRoot, storageDir);
  const filePath = path.join(paths.cyclesDir, `${cycle.id}.json`);
  await atomicWriteJson(filePath, cycle);
}

export async function readCycle(repoRoot: string, cycleId: string, storageDir = DEFAULT_STORAGE_DIR): Promise<CycleSpec> {
  const paths = await ensureSynapseStore(repoRoot, storageDir);
  const filePath = path.join(paths.cyclesDir, `${cycleId}.json`);
  const cycle = await readJsonIfExists(filePath);
  if (!cycle) {
    throw synapseError("CYCLE_NOT_FOUND", `cycle not found: ${cycleId}`, { cycle_id: cycleId });
  }
  return cycle as CycleSpec;
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
    const cycle = (await readJson(filePath)) as CycleSpec;
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

export async function withCycleLock<T>(
  repoRoot: string,
  cycleId: string,
  fn: () => Promise<T>,
  storageDir = DEFAULT_STORAGE_DIR
): Promise<T> {
  const paths = await ensureSynapseStore(repoRoot, storageDir);
  const lockPath = path.join(paths.locksDir, `${cycleId}.lock`);
  const start = Date.now();
  let handle: fs.FileHandle | null = null;

  while (!handle) {
    try {
      handle = await fs.open(lockPath, "wx");
      await handle.writeFile(`${process.pid}:${randomBytes(8).toString("hex")}:${nowIso()}\n`, "utf8");
    } catch (err: any) {
      if (err?.code !== "EEXIST") {
        throw err;
      }
      if (Date.now() - start > LOCK_WAIT_MS) {
        throw synapseError("LOCK_TIMEOUT", `lock timeout for cycle ${cycleId}`, { cycle_id: cycleId });
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }

  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(lockPath).catch(() => {});
  }
}
