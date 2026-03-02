import path from "node:path";
import { randomBytes } from "node:crypto";
import { claimNextRunnablePhase, claimPhaseForCycle, executeClaimedPhase } from "./service.js";
import { runShellCommand } from "./command.js";
import { ensureSynapseStore, listCycles, loadRunnerConfig, readCycle } from "../synapse/store.js";
import type { LogEntry } from "../synapse/types.js";
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

function isTerminalCycleStatus(status: string): boolean {
  return status === "DONE" || status === "FAILED" || status === "CANCELED";
}

function phaseControlMode(phase: { input?: Record<string, unknown> | null } | undefined): "RUNNER" | "ORCHESTRATOR" | null {
  const mode = phase && phase.input && typeof phase.input === "object"
    ? (phase.input as Record<string, unknown>).control_mode
    : null;
  return mode === "RUNNER" || mode === "ORCHESTRATOR" ? mode : null;
}

function summarizeCurrentPhase(cycle: Awaited<ReturnType<typeof readCycle>>) {
  if (typeof cycle.current_phase_index !== "number") {
    return null;
  }
  const phase = cycle.phases[cycle.current_phase_index];
  if (!phase) {
    return null;
  }
  return {
    id: phase.id,
    type: phase.type,
    status: phase.status,
    attempt_count: phase.attempt_count,
    max_attempts: phase.max_attempts,
    control_mode: phaseControlMode(phase) || undefined,
    started_at: phase.started_at,
    finished_at: phase.finished_at
  };
}

function summarizeManualBackend(cycle: Awaited<ReturnType<typeof readCycle>>) {
  const backend = cycle.phases.find((phase) => phase.type === "BACKEND" && phaseControlMode(phase) === "ORCHESTRATOR");
  if (!backend) {
    return null;
  }
  const output = (backend.output && typeof backend.output === "object") ? backend.output as Record<string, unknown> : null;
  const report = output && typeof output.report === "object" ? output.report as Record<string, unknown> : null;
  const filesModified = Array.isArray(report?.files_modified) ? report?.files_modified as unknown[] : [];
  const checksRun = Array.isArray(report?.checks_run) ? report?.checks_run as unknown[] : [];
  const changedFiles = Array.isArray(output?.changed_files) ? output?.changed_files as unknown[] : [];
  const summary = typeof report?.summary === "string" ? report.summary : null;
  const frontendTweakRequired = typeof output?.frontend_tweak_required === "boolean"
    ? output.frontend_tweak_required
    : null;

  return {
    phase_id: backend.id,
    status: backend.status,
    control_mode: "ORCHESTRATOR" as const,
    attempt_count: backend.attempt_count,
    started_at: backend.started_at,
    finished_at: backend.finished_at,
    summary,
    frontend_tweak_required: frontendTweakRequired,
    files_modified_count: filesModified.length,
    checks_run_count: checksRun.length,
    changed_files_count: changedFiles.length
  };
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
  };
}> {
  const repoRoot = resolveRepoRoot(repoRootArg);
  const [gemini, paths, config, cycles, migration] = await Promise.all([
    checkCommand("gemini", repoRoot),
    ensureSynapseStore(repoRoot),
    loadRunnerConfig(repoRoot),
    listCycles(repoRoot, { limit: 10_000 }),
    detectMigrationStatus(repoRoot)
  ]);

  return {
    node: process.version,
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
      gemini_require_marker: config.adapters.gemini.require_marker
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
  phases: Array<{ id: string; type: string; status: string; attempts: number; max_attempts: number; started_at: string | null; finished_at: string | null; control_mode?: "RUNNER" | "ORCHESTRATOR" }>;
  current_phase?: {
    id: string;
    type: string;
    status: string;
    attempt_count: number;
    max_attempts: number;
    control_mode?: "RUNNER" | "ORCHESTRATOR";
    started_at: string | null;
    finished_at: string | null;
  } | null;
  manual_backend?: {
    phase_id: string;
    status: string;
    control_mode?: "ORCHESTRATOR";
    attempt_count: number;
    started_at: string | null;
    finished_at: string | null;
    summary?: string | null;
    frontend_tweak_required?: boolean | null;
    files_modified_count?: number;
    checks_run_count?: number;
    changed_files_count?: number;
  } | null;
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
    recommended_action?: string;
    hint?: string;
  };
  events: Array<{ ts: string; level: string; phase_id?: string; event?: string; message: string }>;
}> {
  const repoRoot = resolveRepoRoot(repoRootArg);
  const cycle = await readCycle(repoRoot, cycleId);
  const lastErrorDetails = (cycle.last_error?.details && typeof cycle.last_error.details === "object")
    ? cycle.last_error.details as Record<string, unknown>
    : null;
  const recommendedAction = typeof lastErrorDetails?.recommended_action === "string"
    ? lastErrorDetails.recommended_action
    : undefined;
  const hint = typeof lastErrorDetails?.hint === "string"
    ? lastErrorDetails.hint
    : undefined;

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
      control_mode: phaseControlMode(p) || undefined,
      started_at: p.started_at,
      finished_at: p.finished_at
    })),
    current_phase: summarizeCurrentPhase(cycle),
    manual_backend: summarizeManualBackend(cycle),
    artifacts: {
      changed_files_count: cycle.artifacts.changed_files.length,
      commands_run_count: cycle.artifacts.commands_run.length,
      test_results_count: cycle.artifacts.test_results.length,
      phase_durations_ms: cycle.artifacts.phase_durations_ms,
      attempt_history: cycle.artifacts.attempt_history
    },
    errors: {
      last_error: cycle.last_error,
      error_log_count: cycle.logs.filter((l) => l.level === "ERROR").length,
      recommended_action: recommendedAction,
      hint
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

export async function logs(
  cycleId: string,
  repoRootArg?: string,
  tailArg?: number
): Promise<{
  cycle_id: string;
  status: string;
  entries: LogEntry[];
}> {
  const repoRoot = resolveRepoRoot(repoRootArg);
  const cycle = await readCycle(repoRoot, cycleId);
  const tail = typeof tailArg === "number" && tailArg > 0 ? Math.floor(tailArg) : null;
  const entries = tail ? cycle.logs.slice(-tail) : cycle.logs;

  return {
    cycle_id: cycle.id,
    status: cycle.status,
    entries
  };
}

export interface FollowLogsOptions {
  repoRoot?: string;
  tail?: number;
  pollMs?: number;
  onEntry?: (entry: LogEntry, index: number) => void;
}

export async function followLogs(
  cycleId: string,
  options: FollowLogsOptions = {}
): Promise<{
  cycle_id: string;
  status: string;
  entries_emitted: number;
}> {
  const repoRoot = resolveRepoRoot(options.repoRoot);
  const pollMs = typeof options.pollMs === "number" && options.pollMs > 0 ? Math.floor(options.pollMs) : 1000;
  const tail = typeof options.tail === "number" && options.tail > 0 ? Math.floor(options.tail) : null;
  const onEntry = options.onEntry || (() => {});

  let emitted = 0;
  let cursor = 0;
  let cycle = await readCycle(repoRoot, cycleId);

  if (tail) {
    cursor = Math.max(0, cycle.logs.length - tail);
  }

  while (true) {
    for (let i = cursor; i < cycle.logs.length; i += 1) {
      onEntry(cycle.logs[i], i);
      emitted += 1;
    }
    cursor = cycle.logs.length;

    if (isTerminalCycleStatus(cycle.status)) {
      return {
        cycle_id: cycle.id,
        status: cycle.status,
        entries_emitted: emitted
      };
    }

    await sleep(pollMs);
    cycle = await readCycle(repoRoot, cycleId);
  }
}
