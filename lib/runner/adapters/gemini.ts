import { synapseError } from "../../synapse/errors.js";
import type { CycleSpec, PhaseExecutionResult, PhaseSpec, RunnerConfig } from "../../synapse/types.js";
import { tail } from "../command.js";
import { applyFileOps, applyPatch } from "./gemini/apply.js";
import { parseWorkerContextMetricsFromBlock } from "./gemini/contextMetrics.js";
import { executeGeminiCommand } from "./gemini/exec.js";
import { enforceGeminiOutputLimits } from "./gemini/limits.js";
import { parseGeminiOutput } from "./gemini/parse.js";
import { buildGeminiPrompt } from "./gemini/prompt.js";
import type { GeminiCommandAttempt, GeminiOutputHooks, GeminiStructuredOutput, ParseSource } from "./gemini/types.js";

export type { GeminiOutputHooks } from "./gemini/types.js";

export async function runGeminiPhase(
  cycle: CycleSpec,
  phase: PhaseSpec,
  config: RunnerConfig,
  signal?: AbortSignal,
  hooks: GeminiOutputHooks = {}
): Promise<PhaseExecutionResult> {
  if (config.adapters.gemini.mode === "stub") {
    return {
      report: {
        mode: "stub",
        message: "Gemini adapter in stub mode. Configure .synapse/config.json adapters.gemini.mode=cli to execute Gemini CLI."
      },
      commands_run: []
    };
  }

  const requireMarker = config.adapters.gemini.require_marker;
  const maxRepairAttempts = config.adapters.gemini.repair_retry_on_invalid_output
    ? Math.max(0, config.adapters.gemini.max_repair_attempts)
    : 0;

  const commandsRun: string[] = [];
  let attempt = 0;
  let lastAttempt: GeminiCommandAttempt | null = null;
  let lastOutputError: { code?: string; message?: string } = {};
  let parseSource: ParseSource = "json_scan";
  let parsed: GeminiStructuredOutput | null = null;

  while (true) {
    const prompt = attempt === 0
      ? await buildGeminiPrompt(cycle, phase, config, "initial")
      : await buildGeminiPrompt(cycle, phase, config, "repair", {
        previous_stdout: lastAttempt?.stdout || "",
        previous_stderr: lastAttempt?.stderr || "",
        last_error: lastOutputError
      });

    if (attempt === 0) {
      try {
        await hooks.onWorkerContext?.(parseWorkerContextMetricsFromBlock(prompt));
      } catch {
        // best-effort observability callback
      }
    }

    const executed = await executeGeminiCommand(prompt, cycle, phase, config, signal, hooks);
    commandsRun.push(executed.command);

    try {
      const parsedResult = parseGeminiOutput(executed.stdout, requireMarker);
      parsed = parsedResult.payload;
      parseSource = parsedResult.parseSource;
      enforceGeminiOutputLimits(parsed, config);
      lastAttempt = executed;
      break;
    } catch (err: any) {
      lastAttempt = executed;
      const isRecoverableOutputError = err?.code === "ADAPTER_OUTPUT_PARSE_FAILED" || err?.code === "ADAPTER_OUTPUT_INVALID";
      if (!isRecoverableOutputError || attempt >= maxRepairAttempts) {
        throw err;
      }
      lastOutputError = {
        code: err?.code,
        message: err?.message
      };
      attempt += 1;
      continue;
    }
  }

  if (!parsed || !lastAttempt) {
    throw synapseError("ADAPTER_FAILED", "Gemini phase ended without parsed output", { phase_id: phase.id });
  }

  if (parsed.file_ops) {
    await applyFileOps(cycle.repo_root, parsed.file_ops);
  }
  if (parsed.patch) {
    await applyPatch(cycle.repo_root, parsed.patch, config);
  }

  return {
    report: {
      ...(parsed.report || {}),
      adapter: "gemini",
      output_mode: parsed.patch ? "patch" : "file_ops",
      parse_source: parseSource,
      repair_attempts: attempt,
      stdout_tail: tail(lastAttempt.stdout),
      stderr_tail: tail(lastAttempt.stderr)
    },
    commands_run: commandsRun,
    frontend_tweak_required: parsed.frontend_tweak_required
  };
}
