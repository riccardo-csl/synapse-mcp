import { synapseError } from "../../synapse/errors.js";
import { codexStructuredOutputSchema } from "../../synapse/schemas.js";
import type { CycleSpec, PhaseExecutionResult, PhaseSpec, RunnerConfig } from "../../synapse/types.js";
import { runShellCommand, tail } from "../command.js";

function inferFrontendTweakRequired(stdout: string): boolean {
  return /frontend_tweak_required\s*[:=]\s*true/i.test(stdout);
}

function parseStructuredResult(stdout: string): { frontend_tweak_required?: boolean; report?: Record<string, unknown> } | null {
  const marker = "SYNAPSE_RESULT_JSON:";
  const idx = stdout.lastIndexOf(marker);
  if (idx < 0) {
    return null;
  }

  const raw = stdout.slice(idx + marker.length).trim();
  if (!raw) {
    throw synapseError("ADAPTER_OUTPUT_PARSE_FAILED", "Codex structured marker present but JSON missing", {
      stdout_tail: tail(stdout)
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw synapseError("ADAPTER_OUTPUT_PARSE_FAILED", "Codex structured JSON is malformed", {
      stdout_tail: tail(stdout)
    });
  }

  const validated = codexStructuredOutputSchema.safeParse(parsed);
  if (!validated.success) {
    throw synapseError("ADAPTER_OUTPUT_INVALID", "Codex structured JSON failed schema validation", {
      issues: validated.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
        code: issue.code
      }))
    });
  }

  return validated.data;
}

export async function runCodexBackendPhase(
  cycle: CycleSpec,
  phase: PhaseSpec,
  config: RunnerConfig,
  signal?: AbortSignal
): Promise<PhaseExecutionResult> {
  const prompt = [
    "You are executing a Synapse BACKEND phase.",
    `Request: ${cycle.request_text}`,
    `Constraints: ${(cycle.constraints || []).join("; ") || "none"}`,
    "Update backend implementation to satisfy frontend contract.",
    "If backend changes require frontend updates, print: frontend_tweak_required=true",
    "Optional structured output: print one final line only:",
    "SYNAPSE_RESULT_JSON: {\"frontend_tweak_required\": true|false, \"report\": {...}}"
  ].join("\n");

  const command = `${config.adapters.codexExec.command} ${JSON.stringify(prompt)}`;
  const result = await runShellCommand(command, cycle.repo_root, phase.timeout_ms, config.denylist_substrings, { signal });
  if (result.canceled) {
    throw synapseError("PHASE_CANCELED", "Codex backend phase canceled", { phase_id: phase.id });
  }

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

  const structured = parseStructuredResult(result.stdout);

  return {
    report: {
      adapter: "codexExec",
      stdout_tail: tail(result.stdout),
      stderr_tail: tail(result.stderr),
      ...(structured?.report || {})
    },
    commands_run: [command],
    frontend_tweak_required: typeof structured?.frontend_tweak_required === "boolean"
      ? structured.frontend_tweak_required
      : inferFrontendTweakRequired(result.stdout)
  };
}
