import path from "node:path";
import { randomBytes } from "node:crypto";
import { claimNextRunnablePhase, claimPhaseForCycle, executeClaimedPhase } from "./service.js";
import { runShellCommand } from "./command.js";
import { ensureSynapseStore, listCycles, loadRunnerConfig, readCycle } from "../synapse/store.js";
import { detectMigrationStatus, migrateStore } from "../synapse/migrate.js";

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
  schema: {
    current: number;
    detected: {
      config_version: number | null;
      cycles_total: number;
      cycles_needs_migration: number;
      cycles_unsupported: number;
      locks_total: number;
      locks_needs_migration: number;
      locks_unsupported: number;
    };
    migration_needed: boolean;
  };
  config: {
    schema_version: number;
    storage_dir: string;
    lock_ttl_ms: number;
    lock_heartbeat_ms: number;
    lock_takeover_grace_ms: number;
    lock_pid_liveness_check: boolean;
    cancellation_term_grace_ms: number;
    gemini_require_marker: boolean;
    codex_require_marker: boolean;
  };
}> {
  const repoRoot = resolveRepoRoot(repoRootArg);
  const [codex, gemini, paths, config, cycles, migration] = await Promise.all([
    checkCommand("codex", repoRoot),
    checkCommand("gemini", repoRoot),
    ensureSynapseStore(repoRoot),
    loadRunnerConfig(repoRoot),
    listCycles(repoRoot, { limit: 10_000 }),
    detectMigrationStatus(repoRoot)
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
    schema: {
      current: migration.current_schema_version,
      detected: {
        config_version: migration.config_version,
        cycles_total: migration.cycles.total,
        cycles_needs_migration: migration.cycles.needs_migration,
        cycles_unsupported: migration.cycles.unsupported,
        locks_total: migration.locks.total,
        locks_needs_migration: migration.locks.needs_migration,
        locks_unsupported: migration.locks.unsupported
      },
      migration_needed: migration.migration_needed
    },
    config: {
      schema_version: config.schema_version,
      storage_dir: config.storage_dir,
      lock_ttl_ms: config.locks.ttl_ms,
      lock_heartbeat_ms: config.locks.heartbeat_ms,
      lock_takeover_grace_ms: config.locks.takeover_grace_ms,
      lock_pid_liveness_check: config.locks.pid_liveness_check,
      cancellation_term_grace_ms: config.cancellation.term_grace_ms,
      gemini_require_marker: config.adapters.gemini.require_marker,
      codex_require_marker: config.adapters.codexExec.require_marker
    }
  };
}

export async function migrate(repoRootArg?: string, dryRun = false): Promise<{
  repo_root: string;
  report: Awaited<ReturnType<typeof migrateStore>>;
}> {
  const repoRoot = resolveRepoRoot(repoRootArg);
  const report = await migrateStore(repoRoot, { dryRun });
  return {
    repo_root: repoRoot,
    report
  };
}

export async function report(cycleId: string, repoRootArg?: string): Promise<{
  cycle_id: string;
  status: string;
  current_phase_index: number | null;
  phases: Array<{ id: string; type: string; status: string; attempts: number; max_attempts: number; started_at: string | null; finished_at: string | null }>;
  artifacts: {
    changed_files_count: number;
    commands_run_count: number;
    test_results_count: number;
    phase_durations_ms: Record<string, number>;
    attempt_history: any[];
  };
  errors: {
    last_error: any;
    error_log_count: number;
  };
  events: Array<{ ts: string; level: string; phase_id?: string; event?: string; message: string }>;
}> {
  const repoRoot = resolveRepoRoot(repoRootArg);
  const cycle = await readCycle(repoRoot, cycleId);

  return {
    cycle_id: cycle.id,
    status: cycle.status,
    current_phase_index: cycle.current_phase_index,
    phases: cycle.phases.map((p) => ({
      id: p.id,
      type: p.type,
      status: p.status,
      attempts: p.attempt_count,
      max_attempts: p.max_attempts,
      started_at: p.started_at,
      finished_at: p.finished_at
    })),
    artifacts: {
      changed_files_count: cycle.artifacts.changed_files.length,
      commands_run_count: cycle.artifacts.commands_run.length,
      test_results_count: cycle.artifacts.test_results.length,
      phase_durations_ms: cycle.artifacts.phase_durations_ms,
      attempt_history: cycle.artifacts.attempt_history
    },
    errors: {
      last_error: cycle.last_error,
      error_log_count: cycle.logs.filter((l) => l.level === "ERROR").length
    },
    events: cycle.logs.map((l) => ({
      ts: l.ts,
      level: l.level,
      phase_id: l.phase_id,
      event: (l.meta as any)?.event,
      message: l.message
    }))
  };
}
