import type { CycleSpec, PhaseSpec, RunnerConfig } from "../../../synapse/types.js";
import { tail } from "../../command.js";
import { buildWorkerPhaseContextBlock } from "../promptContext.js";

export async function buildGeminiPrompt(
  cycle: CycleSpec,
  phase: PhaseSpec,
  config: RunnerConfig,
  mode: "initial" | "repair",
  context?: { previous_stdout: string; previous_stderr: string; last_error: { code?: string; message?: string } }
): Promise<string> {
  const requireMarker = config.adapters.gemini.require_marker;
  const workerContextBlock = await buildWorkerPhaseContextBlock(cycle, phase, { storageDir: config.storage_dir });
  const base = [
    `You are executing synapse phase ${phase.type}.`,
    `Request: ${cycle.request_text}`,
    `Constraints: ${(cycle.constraints || []).join("; ") || "none"}`,
    workerContextBlock,
    "Use the worker context to start from suggested files and recent phase outputs before broad repo scans.",
    requireMarker
      ? "Return ONLY structured output using one of the required marker formats at the end."
      : "Return ONLY JSON with exactly one content mode.",
    "Preferred (more reliable) format:",
    "SYNAPSE_RESULT_JSON_BEGIN",
    "{ ...json... }",
    "SYNAPSE_RESULT_JSON_END",
    "Alternative single-line final marker:",
    "SYNAPSE_RESULT_JSON: { ... }",
    "1) {\"patch\":\"...unified diff...\",\"report\":{...},\"frontend_tweak_required\":false}",
    "2) {\"file_ops\":[{\"path\":\"...\",\"action\":\"write|delete\",\"content\":\"...\"}],\"report\":{...},\"frontend_tweak_required\":false}",
    `Hard limits: max_output_bytes=${config.adapters.gemini.max_output_bytes}, max_patch_bytes=${config.adapters.gemini.max_patch_bytes}, max_file_ops=${config.adapters.gemini.max_file_ops}, max_file_op_bytes=${config.adapters.gemini.max_file_op_bytes}`
  ];

  if (mode === "repair" && context) {
    base.push(
      "Previous output failed Synapse validation. Repair the response and return ONLY one valid structured payload.",
      `Previous error code: ${context.last_error.code || "unknown"}`,
      `Previous error message: ${context.last_error.message || "unknown"}`,
      "Do not repeat explanations or logs. Output only the corrected structured payload.",
      `Previous stdout tail (for repair context):\n${tail(context.previous_stdout, 1500)}`,
      `Previous stderr tail (for repair context):\n${tail(context.previous_stderr, 800)}`
    );
  }

  return base.join("\n");
}
