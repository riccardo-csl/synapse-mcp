import { nowIso } from "../core/time.js";
import { synapseError } from "../synapse/errors.js";
import {
  addLog,
  cancelCycle,
  claimCurrentPhase,
  markClaimedPhaseRunning,
  markPhaseDone,
  markPhaseFailed
} from "../synapse/stateMachine.js";
import { listCycles, loadRunnerConfig, readCycle, withCycleLock, writeCycle } from "../synapse/store.js";
import type { CycleSpec, PhaseExecutionResult, PhaseSpec, RunnerConfig } from "../synapse/types.js";
import { listChangedFiles, runShellCommand, tail } from "./command.js";
import { runGeminiPhase } from "./adapters/gemini.js";
import { runCodexBackendPhase } from "./adapters/codexExec.js";

export interface ClaimedPhase {
  cycle_id: string;
  phase_index: number;
  phase_id: string;
  claim_token: string;
}

const RETRY_BACKOFF_MS = 250;

function uniq(items: string[]): string[] {
  return Array.from(new Set(items));
}

function toErrorShape(err: any): { code: string; message: string; details: Record<string, unknown> } {
  return {
    code: err?.code || "PHASE_FAILED",
    message: err?.message || "Unknown phase failure",
    details: err?.details || {}
  };
}

function isRetryableError(code: string): boolean {
  switch (code) {
    case "PHASE_TIMEOUT":
    case "LOCK_HELD":
    case "CHECK_FAILED":
    case "ADAPTER_FAILED":
      return true;
    case "SCHEMA_INVALID":
    case "ADAPTER_OUTPUT_PARSE_FAILED":
    case "ADAPTER_OUTPUT_INVALID":
    case "PATCH_INVALID":
    case "PATCH_APPLY_FAILED":
    case "REPO_BOUNDARY":
    case "COMMAND_BLOCKED":
    case "CONFIG_INVALID":
    case "CYCLE_CORRUPT":
      return false;
    default:
      return true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function durationMs(startedAt: string | null, fallbackStartMs: number): number {
  if (!startedAt) {
    return Math.max(0, Date.now() - fallbackStartMs);
  }
  const parsed = Date.parse(startedAt);
  if (!Number.isFinite(parsed)) {
    return Math.max(0, Date.now() - fallbackStartMs);
  }
  return Math.max(0, Date.now() - parsed);
}

async function runPhaseAdapter(
  cycle: CycleSpec,
  phase: PhaseSpec,
  config: RunnerConfig,
  signal?: AbortSignal
): Promise<PhaseExecutionResult> {
  if (phase.type === "BACKEND") {
    return runCodexBackendPhase(cycle, phase, config, signal);
  }
  if (phase.type === "FRONTEND" || phase.type === "FRONTEND_TWEAK") {
    return runGeminiPhase(cycle, phase, config, signal);
  }
  throw synapseError("INVALID_PHASE", "Unsupported phase type", { type: phase.type });
}

async function runPhaseChecks(
  cycle: CycleSpec,
  phase: PhaseSpec,
  config: RunnerConfig,
  commandsRun: string[],
  signal?: AbortSignal
): Promise<Array<{ command: string; ok: boolean; code: number | null; stdout_tail: string; stderr_tail: string }>> {
  const checks = config.checks[phase.type] || [];
  const results: Array<{ command: string; ok: boolean; code: number | null; stdout_tail: string; stderr_tail: string }> = [];

  for (const cmd of checks) {
    const result = await runShellCommand(cmd, cycle.repo_root, phase.timeout_ms, config.denylist_substrings, { signal });
    if (result.canceled) {
      throw synapseError("PHASE_CANCELED", "Phase checks canceled", { phase_id: phase.id, command: cmd });
    }
    commandsRun.push(cmd);
    const entry = {
      command: cmd,
      ok: result.code === 0 && !result.timedOut,
      code: result.code,
      stdout_tail: tail(result.stdout),
      stderr_tail: tail(result.stderr)
    };
    results.push(entry);

    if (!entry.ok) {
      throw synapseError("CHECK_FAILED", "Post-phase check failed", {
        phase: phase.type,
        command: cmd,
        code: result.code,
        timedOut: result.timedOut,
        stderr: entry.stderr_tail
      });
    }
  }

  return results;
}

export async function claimNextRunnablePhase(repoRoot: string, runnerId: string): Promise<ClaimedPhase | null> {
  const config = await loadRunnerConfig(repoRoot);
  const reclaimStaleMs = config.locks.ttl_ms + config.locks.takeover_grace_ms + (config.locks.heartbeat_ms * 2);
  const cycles = await listCycles(repoRoot, { limit: 200 });

  for (const cycleSummary of cycles) {
    if (cycleSummary.status === "DONE" || cycleSummary.status === "FAILED" || cycleSummary.status === "CANCELED") {
      continue;
    }

    const claimed = await withCycleLock(repoRoot, cycleSummary.id, async () => {
      const cycle = await readCycle(repoRoot, cycleSummary.id);
      const claim = claimCurrentPhase(cycle, runnerId, { reclaim_stale_ms: reclaimStaleMs });
      if (!claim) {
        return null;
      }
      await writeCycle(repoRoot, cycle);
      return {
        cycle_id: cycle.id,
        phase_index: claim.phaseIndex,
        phase_id: cycle.phases[claim.phaseIndex].id,
        claim_token: claim.claimToken
      };
    }, { ownerId: runnerId, lockConfig: config.locks });

    if (claimed) {
      return claimed;
    }
  }

  return null;
}

export async function claimPhaseForCycle(
  repoRoot: string,
  cycleId: string,
  runnerId: string
): Promise<ClaimedPhase | null> {
  const config = await loadRunnerConfig(repoRoot);
  const reclaimStaleMs = config.locks.ttl_ms + config.locks.takeover_grace_ms + (config.locks.heartbeat_ms * 2);
  return withCycleLock(repoRoot, cycleId, async () => {
    const cycle = await readCycle(repoRoot, cycleId);
    if (cycle.status === "DONE" || cycle.status === "FAILED" || cycle.status === "CANCELED") {
      return null;
    }
    const claim = claimCurrentPhase(cycle, runnerId, { reclaim_stale_ms: reclaimStaleMs });
    if (!claim) {
      return null;
    }
    await writeCycle(repoRoot, cycle);
    return {
      cycle_id: cycle.id,
      phase_index: claim.phaseIndex,
      phase_id: cycle.phases[claim.phaseIndex].id,
      claim_token: claim.claimToken
    };
  }, { ownerId: runnerId, lockConfig: config.locks });
}

export async function executeClaimedPhase(repoRoot: string, claimed: ClaimedPhase, runnerId: string): Promise<void> {
  const config = await loadRunnerConfig(repoRoot);
  let didScheduleRetry = false;

  await withCycleLock(repoRoot, claimed.cycle_id, async () => {
    const cycle = await readCycle(repoRoot, claimed.cycle_id);
    markClaimedPhaseRunning(cycle, claimed.phase_index, claimed.claim_token);
    addLog(cycle, "INFO", `Runner ${runnerId} executing phase`, { runner: runnerId }, claimed.phase_id);
    await writeCycle(repoRoot, cycle);

    const phaseForRun = cycle.phases[claimed.phase_index];
    const beforeChanged = await listChangedFiles(cycle.repo_root);
    const commandsRun: string[] = [];
    const runStartedMs = Date.now();
    const cancelController = new AbortController();
    let watcherStopped = false;
    let watchBusy = false;
    const cancelWatch = setInterval(async () => {
      if (watcherStopped || watchBusy || cancelController.signal.aborted) {
        return;
      }
      watchBusy = true;
      try {
        const latest = await readCycle(repoRoot, claimed.cycle_id);
        if (latest.status === "CANCELED") {
          cancelController.abort();
        }
      } catch {
        // ignore transient read failures
      } finally {
        watchBusy = false;
      }
    }, 200);

    try {
      const execResult = await runPhaseAdapter(cycle, phaseForRun, config, cancelController.signal);
      commandsRun.push(...execResult.commands_run);

      const checkResults = await runPhaseChecks(cycle, phaseForRun, config, commandsRun, cancelController.signal);
      const latestCycle = await readCycle(repoRoot, claimed.cycle_id);
      if (latestCycle.status === "CANCELED") {
        throw synapseError("PHASE_CANCELED", "Cycle canceled during phase execution", {
          phase_id: claimed.phase_id
        });
      }

      const afterChanged = await listChangedFiles(cycle.repo_root);
      const changedFiles = uniq([...beforeChanged, ...afterChanged]);

      if (config.require_changes[phaseForRun.type] && changedFiles.length === 0) {
        throw synapseError("NO_CHANGES", "Phase completed without file changes", {
          phase: phaseForRun.type
        });
      }

      const phase = cycle.phases[claimed.phase_index];
      cycle.artifacts.changed_files = uniq([...cycle.artifacts.changed_files, ...changedFiles]);
      cycle.artifacts.commands_run = uniq([...cycle.artifacts.commands_run, ...commandsRun]);
      cycle.artifacts.test_results.push(...checkResults);

      const phaseDurationMs = durationMs(phase?.started_at || null, runStartedMs);
      cycle.artifacts.phase_durations_ms[claimed.phase_id] =
        (cycle.artifacts.phase_durations_ms[claimed.phase_id] || 0) + phaseDurationMs;

      markPhaseDone(
        cycle,
        claimed.phase_index,
        claimed.claim_token,
        {
          report: execResult.report,
          completed_at: nowIso(),
          changed_files: changedFiles
        },
        execResult
      );

      cycle.artifacts.attempt_history.push({
        phase_id: claimed.phase_id,
        attempt: phase?.attempt_count || 0,
        started_at: phase?.started_at || null,
        finished_at: phase?.finished_at || nowIso(),
        outcome: "DONE"
      });

      await writeCycle(repoRoot, cycle);
    } catch (err: any) {
      const shape = toErrorShape(err);
      const phase = cycle.phases[claimed.phase_index];
      const retryable = isRetryableError(shape.code);

      cycle.artifacts.commands_run = uniq([...cycle.artifacts.commands_run, ...commandsRun]);
      const phaseDurationMs = durationMs(phase?.started_at || null, runStartedMs);
      cycle.artifacts.phase_durations_ms[claimed.phase_id] =
        (cycle.artifacts.phase_durations_ms[claimed.phase_id] || 0) + phaseDurationMs;

      if (shape.code === "PHASE_CANCELED") {
        if (phase && phase.claim_token === claimed.claim_token) {
          phase.status = "FAILED";
          phase.finished_at = nowIso();
          phase.claim_token = null;
          phase.claimed_by = null;
        }
        cancelCycle(cycle, "Canceled during phase execution");
      } else {
        markPhaseFailed(cycle, claimed.phase_index, claimed.claim_token, shape, {
          forceTerminal: !retryable
        });
      }

      didScheduleRetry = cycle.phases[claimed.phase_index]?.status === "PENDING";
      cycle.artifacts.attempt_history.push({
        phase_id: claimed.phase_id,
        attempt: phase?.attempt_count || 0,
        started_at: phase?.started_at || null,
        finished_at: phase?.finished_at || nowIso(),
        outcome: didScheduleRetry ? "RETRY" : "FAILED",
        error_code: shape.code
      });

      await writeCycle(repoRoot, cycle);
    } finally {
      watcherStopped = true;
      clearInterval(cancelWatch);
    }
  }, { ownerId: runnerId, lockConfig: config.locks });

  if (didScheduleRetry) {
    await sleep(RETRY_BACKOFF_MS);
  }
}
