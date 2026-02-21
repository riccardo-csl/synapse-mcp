import { nowIso } from "../core/time.js";
import { synapseError } from "../synapse/errors.js";
import {
  addLog,
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

async function runPhaseAdapter(
  cycle: CycleSpec,
  phase: PhaseSpec,
  config: RunnerConfig
): Promise<PhaseExecutionResult> {
  if (phase.type === "BACKEND") {
    return runCodexBackendPhase(cycle, phase, config);
  }
  if (phase.type === "FRONTEND" || phase.type === "FRONTEND_TWEAK") {
    return runGeminiPhase(cycle, phase, config);
  }
  throw synapseError("INVALID_PHASE", "Unsupported phase type", { type: phase.type });
}

async function runPhaseChecks(
  cycle: CycleSpec,
  phase: PhaseSpec,
  config: RunnerConfig,
  commandsRun: string[]
): Promise<Array<{ command: string; ok: boolean; code: number | null; stdout_tail: string; stderr_tail: string }>> {
  const checks = config.checks[phase.type] || [];
  const results: Array<{ command: string; ok: boolean; code: number | null; stdout_tail: string; stderr_tail: string }> = [];

  for (const cmd of checks) {
    const result = await runShellCommand(cmd, cycle.repo_root, phase.timeout_ms, config.denylist_substrings);
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
  const cycles = await listCycles(repoRoot, { limit: 200 });

  for (const cycleSummary of cycles) {
    if (cycleSummary.status === "DONE" || cycleSummary.status === "FAILED" || cycleSummary.status === "CANCELED") {
      continue;
    }

    const claimed = await withCycleLock(repoRoot, cycleSummary.id, async () => {
      const cycle = await readCycle(repoRoot, cycleSummary.id);
      const claim = claimCurrentPhase(cycle, runnerId);
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
    });

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
  return withCycleLock(repoRoot, cycleId, async () => {
    const cycle = await readCycle(repoRoot, cycleId);
    if (cycle.status === "DONE" || cycle.status === "FAILED" || cycle.status === "CANCELED") {
      return null;
    }
    const claim = claimCurrentPhase(cycle, runnerId);
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
  });
}

export async function executeClaimedPhase(repoRoot: string, claimed: ClaimedPhase, runnerId: string): Promise<void> {
  const config = await loadRunnerConfig(repoRoot);

  await withCycleLock(repoRoot, claimed.cycle_id, async () => {
    const cycle = await readCycle(repoRoot, claimed.cycle_id);
    markClaimedPhaseRunning(cycle, claimed.phase_index, claimed.claim_token);
    addLog(cycle, "INFO", `Runner ${runnerId} executing phase`, { runner: runnerId }, claimed.phase_id);
    await writeCycle(repoRoot, cycle);
  });

  let cycleForRun: CycleSpec;
  let phaseForRun: PhaseSpec;

  {
    const cycle = await readCycle(repoRoot, claimed.cycle_id);
    cycleForRun = cycle;
    phaseForRun = cycle.phases[claimed.phase_index];
  }

  const beforeChanged = await listChangedFiles(cycleForRun.repo_root);
  const commandsRun: string[] = [];

  try {
    const execResult = await runPhaseAdapter(cycleForRun, phaseForRun, config);
    commandsRun.push(...execResult.commands_run);

    const checkResults = await runPhaseChecks(cycleForRun, phaseForRun, config, commandsRun);

    const afterChanged = await listChangedFiles(cycleForRun.repo_root);
    const changedFiles = uniq([...beforeChanged, ...afterChanged]);

    if (config.require_changes[phaseForRun.type] && changedFiles.length === 0) {
      throw synapseError("NO_CHANGES", "Phase completed without file changes", {
        phase: phaseForRun.type
      });
    }

    await withCycleLock(repoRoot, claimed.cycle_id, async () => {
      const cycle = await readCycle(repoRoot, claimed.cycle_id);

      cycle.artifacts.changed_files = uniq([...cycle.artifacts.changed_files, ...changedFiles]);
      cycle.artifacts.commands_run = uniq([...cycle.artifacts.commands_run, ...commandsRun]);
      cycle.artifacts.test_results.push(...checkResults);

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

      await writeCycle(repoRoot, cycle);
    });
  } catch (err: any) {
    const shape = toErrorShape(err);
    await withCycleLock(repoRoot, claimed.cycle_id, async () => {
      const cycle = await readCycle(repoRoot, claimed.cycle_id);
      cycle.artifacts.commands_run = uniq([...cycle.artifacts.commands_run, ...commandsRun]);
      markPhaseFailed(cycle, claimed.phase_index, claimed.claim_token, shape);
      await writeCycle(repoRoot, cycle);
    });
  }
}
