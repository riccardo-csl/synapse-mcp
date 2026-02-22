import path from "node:path";
import { randomBytes } from "node:crypto";
import { claimNextRunnablePhase, claimPhaseForCycle, executeClaimedPhase } from "./service.js";
import { runShellCommand } from "./command.js";
import { ensureSynapseStore, listCycles, loadRunnerConfig } from "../synapse/store.js";

export interface RunnerStartOptions {
  repoRoot?: string;
  once?: boolean;
  pollMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveRepoRoot(repoRoot?: string): string {
  return path.resolve(repoRoot || process.cwd());
}

export async function startRunner(options: RunnerStartOptions = {}): Promise<void> {
  const repoRoot = resolveRepoRoot(options.repoRoot);
  const once = Boolean(options.once);
  const pollMs = typeof options.pollMs === "number" && options.pollMs > 0 ? options.pollMs : 500;
  const runnerId = `runner-${process.pid}-${randomBytes(4).toString("hex")}`;

  while (true) {
    const claimed = await claimNextRunnablePhase(repoRoot, runnerId);
    if (!claimed) {
      if (once) {
        return;
      }
      await sleep(pollMs);
      continue;
    }
    await executeClaimedPhase(repoRoot, claimed, runnerId);
  }
}

export async function runCycle(cycleId: string, repoRootArg?: string): Promise<void> {
  const repoRoot = resolveRepoRoot(repoRootArg);
  const runnerId = `runner-${process.pid}-${randomBytes(4).toString("hex")}`;

  while (true) {
    const claimed = await claimPhaseForCycle(repoRoot, cycleId, runnerId);
    if (!claimed) {
      return;
    }
    await executeClaimedPhase(repoRoot, claimed, runnerId);
  }
}

async function checkCommand(cmd: string, cwd: string): Promise<boolean> {
  const result = await runShellCommand(`command -v ${cmd}`, cwd, 10_000, []);
  return result.code === 0;
}

export async function health(repoRootArg?: string): Promise<{
  runner_id: string;
  pid: number;
  node: string;
  uptime_s: number;
  repo_root: string;
}> {
  const repoRoot = resolveRepoRoot(repoRootArg);
  return {
    runner_id: `runner-${process.pid}`,
    pid: process.pid,
    node: process.version,
    uptime_s: Math.floor(process.uptime()),
    repo_root: repoRoot
  };
}

export async function doctor(repoRootArg?: string): Promise<{
  node: string;
  codex: boolean;
  gemini: boolean;
  repo_root: string;
  storage: {
    root_dir: string;
    cycles_dir: string;
    locks_dir: string;
    cycle_count: number;
  };
  config: {
    storage_dir: string;
    lock_ttl_ms: number;
    lock_heartbeat_ms: number;
    lock_takeover_grace_ms: number;
  };
}> {
  const repoRoot = resolveRepoRoot(repoRootArg);
  const [codex, gemini, paths, config, cycles] = await Promise.all([
    checkCommand("codex", repoRoot),
    checkCommand("gemini", repoRoot),
    ensureSynapseStore(repoRoot),
    loadRunnerConfig(repoRoot),
    listCycles(repoRoot, { limit: 10_000 })
  ]);

  return {
    node: process.version,
    codex,
    gemini,
    repo_root: repoRoot,
    storage: {
      root_dir: paths.rootDir,
      cycles_dir: paths.cyclesDir,
      locks_dir: paths.locksDir,
      cycle_count: cycles.length
    },
    config: {
      storage_dir: config.storage_dir,
      lock_ttl_ms: config.locks.ttl_ms,
      lock_heartbeat_ms: config.locks.heartbeat_ms,
      lock_takeover_grace_ms: config.locks.takeover_grace_ms
    }
  };
}
