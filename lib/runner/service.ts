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
const DEFAULT_PHASE_PROGRESS_LOG_MS = 15_000;
const GEMINI_LOG_FLUSH_MS = 2_000;
const GEMINI_LOG_CHUNK_MAX_CHARS = 1200;

function uniq(items: string[]): string[] {
  return Array.from(new Set(items));
}

function reportFilesModified(report: Record<string, unknown> | undefined): string[] {
  const raw = report && Array.isArray((report as any).files_modified)
    ? (report as any).files_modified
    : null;
  if (!raw) {
    return [];
  }
  return uniq(raw.filter((item: unknown) => typeof item === "string" && item.trim()).map((item: string) => item.trim()));
}

function phaseChangedFilesForArtifacts(
  beforeChanged: string[],
  afterChanged: string[],
  execResult: PhaseExecutionResult
): string[] {
  const fromReport = reportFilesModified(execResult.report);
  if (fromReport.length > 0) {
    return fromReport;
  }

  const before = new Set(beforeChanged);
  return uniq(afterChanged.filter((file) => !before.has(file)));
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
    case "ADAPTER_CAPACITY_EXHAUSTED":
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

function phaseProgressLogIntervalMs(): number {
  const raw = Number(process.env.SYNAPSE_PHASE_PROGRESS_LOG_MS || DEFAULT_PHASE_PROGRESS_LOG_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_PHASE_PROGRESS_LOG_MS;
  }
  return Math.floor(raw);
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
  signal?: AbortSignal,
  hooks?: { onGeminiStdoutChunk?: (chunk: string) => void; onGeminiStderrChunk?: (chunk: string) => void }
): Promise<PhaseExecutionResult> {
  if (phase.type === "BACKEND") {
    return runCodexBackendPhase(cycle, phase, config, signal);
  }
  if (phase.type === "FRONTEND" || phase.type === "FRONTEND_TWEAK") {
    return runGeminiPhase(cycle, phase, config, signal, {
      onStdoutChunk: hooks?.onGeminiStdoutChunk,
      onStderrChunk: hooks?.onGeminiStderrChunk
    });
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
    const result = await runShellCommand(cmd, cycle.repo_root, phase.timeout_ms, config.denylist_substrings, {
      signal,
      termGraceMs: config.cancellation.term_grace_ms
    });
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
    let progressStage: "adapter" | "checks" = "adapter";
    let progressStopped = false;
    let progressBusy = false;
    let geminiLogStopped = false;
    let geminiLogBusy = false;
    let geminiStdoutBuffer = "";
    let geminiStderrBuffer = "";
    const geminiOutputToLogs = (
      (phaseForRun.type === "FRONTEND" || phaseForRun.type === "FRONTEND_TWEAK")
      && config.adapters.gemini.stream_output_to_synapse_logs
    );

    const appendGeminiChunk = (stream: "stdout" | "stderr", chunk: string) => {
      if (!geminiOutputToLogs || !chunk) {
        return;
      }
      if (stream === "stdout") {
        geminiStdoutBuffer += chunk;
        if (geminiStdoutBuffer.length > 10_000) {
          geminiStdoutBuffer = geminiStdoutBuffer.slice(-10_000);
        }
        return;
      }
      geminiStderrBuffer += chunk;
      if (geminiStderrBuffer.length > 10_000) {
        geminiStderrBuffer = geminiStderrBuffer.slice(-10_000);
      }
    };

    const flushGeminiOutputToCycleLogs = async () => {
      if (!geminiOutputToLogs) {
        return;
      }
      const phase = cycle.phases[claimed.phase_index];
      if (!phase || phase.status !== "RUNNING") {
        return;
      }

      const flushOne = (stream: "stdout" | "stderr", raw: string) => {
        const trimmed = raw.trim();
        if (!trimmed) {
          return;
        }
        const snippet = tail(trimmed, GEMINI_LOG_CHUNK_MAX_CHARS);
        addLog(cycle, "INFO", `Gemini ${stream}: ${snippet}`, {
          event: stream === "stdout" ? "adapter.stdout" : "adapter.stderr",
          adapter: "gemini",
          stream,
          truncated: trimmed.length > snippet.length
        }, claimed.phase_id);
      };

      flushOne("stdout", geminiStdoutBuffer);
      flushOne("stderr", geminiStderrBuffer);
      geminiStdoutBuffer = "";
      geminiStderrBuffer = "";
      await writeCycle(repoRoot, cycle);
    };
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
    const progressLogMs = phaseProgressLogIntervalMs();
    const progressWatch = setInterval(async () => {
      if (progressStopped || progressBusy || cancelController.signal.aborted) {
        return;
      }
      progressBusy = true;
      try {
        const phase = cycle.phases[claimed.phase_index];
        if (!phase || phase.status !== "RUNNING") {
          return;
        }
        const elapsed_ms = durationMs(phase.started_at, runStartedMs);
        addLog(cycle, "INFO", `Phase still running (${progressStage})`, {
          event: "phase.progress",
          phase_type: phase.type,
          stage: progressStage,
          attempt: phase.attempt_count,
          elapsed_ms
        }, claimed.phase_id);
        await writeCycle(repoRoot, cycle);
      } catch {
        // best-effort progress logging; do not fail phase execution
      } finally {
        progressBusy = false;
      }
    }, progressLogMs);
    const geminiOutputWatch = setInterval(async () => {
      if (!geminiOutputToLogs || geminiLogStopped || geminiLogBusy || cancelController.signal.aborted) {
        return;
      }
      if (!geminiStdoutBuffer.trim() && !geminiStderrBuffer.trim()) {
        return;
      }
      geminiLogBusy = true;
      try {
        await flushGeminiOutputToCycleLogs();
      } catch {
        // best-effort telemetry
      } finally {
        geminiLogBusy = false;
      }
    }, GEMINI_LOG_FLUSH_MS);

    try {
      const execResult = await runPhaseAdapter(cycle, phaseForRun, config, cancelController.signal, {
        onGeminiStdoutChunk: (chunk) => appendGeminiChunk("stdout", chunk),
        onGeminiStderrChunk: (chunk) => appendGeminiChunk("stderr", chunk)
      });
      commandsRun.push(...execResult.commands_run);
      await flushGeminiOutputToCycleLogs().catch(() => {});

      if (typeof execResult.report?.adapter === "string") {
        addLog(cycle, "INFO", `${execResult.report.adapter} structured output parsed`, {
          event: "adapter.output.parsed",
          adapter: execResult.report.adapter,
          parse_source: execResult.report.parse_source,
          output_mode: execResult.report.output_mode,
          repair_attempts: execResult.report.repair_attempts
        }, claimed.phase_id);
        await writeCycle(repoRoot, cycle);
      }

      progressStage = "checks";
      const checkResults = await runPhaseChecks(cycle, phaseForRun, config, commandsRun, cancelController.signal);
      const latestCycle = await readCycle(repoRoot, claimed.cycle_id);
      if (latestCycle.status === "CANCELED") {
        throw synapseError("PHASE_CANCELED", "Cycle canceled during phase execution", {
          phase_id: claimed.phase_id
        });
      }

      const afterChanged = await listChangedFiles(cycle.repo_root);
      const changedFiles = phaseChangedFilesForArtifacts(beforeChanged, afterChanged, execResult);

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
      await flushGeminiOutputToCycleLogs().catch(() => {});
      const shape = toErrorShape(err);
      const phase = cycle.phases[claimed.phase_index];
      const retryable = isRetryableError(shape.code);

      cycle.artifacts.commands_run = uniq([...cycle.artifacts.commands_run, ...commandsRun]);
      const phaseDurationMs = durationMs(phase?.started_at || null, runStartedMs);
      cycle.artifacts.phase_durations_ms[claimed.phase_id] =
        (cycle.artifacts.phase_durations_ms[claimed.phase_id] || 0) + phaseDurationMs;

      if (shape.code === "PHASE_CANCELED") {
        addLog(cycle, "INFO", "Phase execution canceled", {
          event: "phase.canceled",
          phase_id: claimed.phase_id
        }, claimed.phase_id);
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
      progressStopped = true;
      geminiLogStopped = true;
      clearInterval(cancelWatch);
      clearInterval(progressWatch);
      clearInterval(geminiOutputWatch);
    }
  }, { ownerId: runnerId, lockConfig: config.locks });

  if (didScheduleRetry) {
    await sleep(RETRY_BACKOFF_MS);
  }
}
