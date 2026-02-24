import { synapseError } from "../../../synapse/errors.js";
import type { CycleSpec, PhaseSpec, RunnerConfig } from "../../../synapse/types.js";
import { runShellCommand } from "../../command.js";
import { classifyGeminiCommandFailure } from "./failures.js";
import { utf8ByteLength } from "./limits.js";
import type { GeminiCommandAttempt, GeminiOutputHooks } from "./types.js";

function shellEscapeSingleArg(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export async function executeGeminiCommand(
  prompt: string,
  cycle: CycleSpec,
  phase: PhaseSpec,
  config: RunnerConfig,
  signal?: AbortSignal,
  hooks: GeminiOutputHooks = {}
): Promise<GeminiCommandAttempt> {
  const streamToRunner = config.adapters.gemini.stream_output_to_runner
    || process.env.SYNAPSE_GEMINI_STREAM_OUTPUT_TO_RUNNER === "1";
  const command = `${config.adapters.gemini.command} ${shellEscapeSingleArg(prompt)}`;
  const result = await runShellCommand(command, cycle.repo_root, phase.timeout_ms, config.denylist_substrings, {
    signal,
    termGraceMs: config.cancellation.term_grace_ms,
    onStdoutChunk: streamToRunner
      ? (chunk) => {
        process.stdout.write(chunk);
        hooks.onStdoutChunk?.(chunk);
      }
      : hooks.onStdoutChunk,
    onStderrChunk: streamToRunner
      ? (chunk) => {
        process.stderr.write(chunk);
        hooks.onStderrChunk?.(chunk);
      }
      : hooks.onStderrChunk
  });

  if (result.canceled) {
    throw synapseError("PHASE_CANCELED", "Gemini phase canceled", { phase_id: phase.id });
  }
  if (result.timedOut) {
    throw synapseError("PHASE_TIMEOUT", "Gemini phase timed out", { phase_id: phase.id });
  }
  if (result.code !== 0) {
    throw classifyGeminiCommandFailure(command, result.code, result.stdout, result.stderr);
  }

  const stdoutBytes = utf8ByteLength(result.stdout);
  if (stdoutBytes > config.adapters.gemini.max_output_bytes) {
    throw synapseError("ADAPTER_OUTPUT_INVALID", "Gemini stdout exceeds configured size limit", {
      stdout_bytes: stdoutBytes,
      max_output_bytes: config.adapters.gemini.max_output_bytes
    });
  }

  return {
    command,
    stdout: result.stdout,
    stderr: result.stderr
  };
}
