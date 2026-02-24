import { synapseError } from "../../synapse/errors.js";
import type { CycleSpec, PhaseSpec, RunnerConfig } from "../../synapse/types.js";
import { runShellCommand, tail } from "../command.js";

export async function runPhaseChecks(
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
