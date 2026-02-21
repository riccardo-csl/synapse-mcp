import { synapseError } from "../../synapse/errors.js";
import type { CycleSpec, PhaseExecutionResult, PhaseSpec, RunnerConfig } from "../../synapse/types.js";
import { runShellCommand, tail } from "../command.js";

function inferFrontendTweakRequired(stdout: string): boolean {
  return /frontend_tweak_required\s*[:=]\s*true/i.test(stdout);
}

export async function runCodexBackendPhase(
  cycle: CycleSpec,
  phase: PhaseSpec,
  config: RunnerConfig
): Promise<PhaseExecutionResult> {
  const prompt = [
    "You are executing a Synapse BACKEND phase.",
    `Request: ${cycle.request_text}`,
    `Constraints: ${(cycle.constraints || []).join("; ") || "none"}`,
    "Update backend implementation to satisfy frontend contract.",
    "If backend changes require frontend updates, print: frontend_tweak_required=true"
  ].join("\n");

  const command = `${config.adapters.codexExec.command} ${JSON.stringify(prompt)}`;
  const result = await runShellCommand(command, cycle.repo_root, phase.timeout_ms, config.denylist_substrings);

  if (result.timedOut) {
    throw synapseError("PHASE_TIMEOUT", "Codex backend phase timed out", { phase_id: phase.id });
  }

  if (result.code !== 0) {
    throw synapseError("ADAPTER_FAILED", "codex exec failed", {
      command,
      code: result.code,
      stdout: tail(result.stdout),
      stderr: tail(result.stderr)
    });
  }

  return {
    report: {
      adapter: "codexExec",
      stdout_tail: tail(result.stdout),
      stderr_tail: tail(result.stderr)
    },
    commands_run: [command],
    frontend_tweak_required: inferFrontendTweakRequired(result.stdout)
  };
}
