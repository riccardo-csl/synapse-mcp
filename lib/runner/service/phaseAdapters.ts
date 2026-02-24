import { synapseError } from "../../synapse/errors.js";
import type { CycleSpec, PhaseExecutionResult, PhaseSpec, RunnerConfig } from "../../synapse/types.js";
import { runCodexBackendPhase } from "../adapters/codexExec.js";
import { runGeminiPhase } from "../adapters/gemini.js";

export async function runPhaseAdapter(
  cycle: CycleSpec,
  phase: PhaseSpec,
  config: RunnerConfig,
  signal?: AbortSignal,
  hooks?: {
    onGeminiStdoutChunk?: (chunk: string) => void;
    onGeminiStderrChunk?: (chunk: string) => void;
    onWorkerContext?: (meta: {
      adapter: "gemini" | "codexExec";
      suggested_start_files_count: number;
      seed_file_snippets_count: number;
      worker_memory_hints_used: number;
      repo_index_suggestions_used: number;
    }) => void | Promise<void>;
  }
): Promise<PhaseExecutionResult> {
  if (phase.type === "BACKEND") {
    return runCodexBackendPhase(cycle, phase, config, signal, {
      onWorkerContext: (meta) => hooks?.onWorkerContext?.({ adapter: "codexExec", ...meta })
    });
  }
  if (phase.type === "FRONTEND" || phase.type === "FRONTEND_TWEAK") {
    return runGeminiPhase(cycle, phase, config, signal, {
      onStdoutChunk: hooks?.onGeminiStdoutChunk,
      onStderrChunk: hooks?.onGeminiStderrChunk,
      onWorkerContext: (meta) => hooks?.onWorkerContext?.({ adapter: "gemini", ...meta })
    });
  }
  throw synapseError("INVALID_PHASE", "Unsupported phase type", { type: phase.type });
}
