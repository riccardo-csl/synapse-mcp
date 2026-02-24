import { synapseError } from "../../synapse/errors.js";
import { codexStructuredOutputSchema } from "../../synapse/schemas.js";
import type { CycleSpec, PhaseExecutionResult, PhaseSpec, RunnerConfig } from "../../synapse/types.js";
import { runShellCommand, tail } from "../command.js";
import { buildWorkerPhaseContextBlock } from "./promptContext.js";

export interface CodexBackendHooks {
  onWorkerContext?: (meta: {
    suggested_start_files_count: number;
    seed_file_snippets_count: number;
    worker_memory_hints_used: number;
    repo_index_suggestions_used: number;
  }) => void | Promise<void>;
}

function shellEscapeSingleArg(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function parseWorkerContextMetricsFromBlock(block: string): {
  suggested_start_files_count: number;
  seed_file_snippets_count: number;
  worker_memory_hints_used: number;
  repo_index_suggestions_used: number;
} {
  const begin = "SYNAPSE_PHASE_CONTEXT_BEGIN";
  const end = "SYNAPSE_PHASE_CONTEXT_END";
  const beginIdx = block.indexOf(begin);
  const endIdx = block.indexOf(end);
  if (beginIdx < 0 || endIdx < 0 || endIdx <= beginIdx) {
    return {
      suggested_start_files_count: 0,
      seed_file_snippets_count: 0,
      worker_memory_hints_used: 0,
      repo_index_suggestions_used: 0
    };
  }
  try {
    const raw = block.slice(beginIdx + begin.length, endIdx).trim();
    const parsed = JSON.parse(raw) as any;
    return {
      suggested_start_files_count: Array.isArray(parsed?.suggested_start_files) ? parsed.suggested_start_files.length : 0,
      seed_file_snippets_count: Array.isArray(parsed?.seed_file_snippets) ? parsed.seed_file_snippets.length : 0,
      worker_memory_hints_used: Array.isArray(parsed?.worker_memory?.file_hints) ? parsed.worker_memory.file_hints.length : 0,
      repo_index_suggestions_used: Array.isArray(parsed?.repo_index_suggestions) ? parsed.repo_index_suggestions.length : 0
    };
  } catch {
    return {
      suggested_start_files_count: 0,
      seed_file_snippets_count: 0,
      worker_memory_hints_used: 0,
      repo_index_suggestions_used: 0
    };
  }
}

function inferFrontendTweakRequired(stdout: string): boolean {
  return /frontend_tweak_required\s*[:=]\s*true/i.test(stdout);
}

function parseStructuredResult(
  stdout: string,
  requireMarker: boolean
): { frontend_tweak_required?: boolean; report?: Record<string, unknown> } | null {
  const marker = "SYNAPSE_RESULT_JSON:";
  const idx = stdout.lastIndexOf(marker);
  if (idx < 0) {
    if (requireMarker) {
      throw synapseError("ADAPTER_OUTPUT_PARSE_FAILED", "Codex output missing required structured marker", {
        marker
      });
    }
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
  signal?: AbortSignal,
  hooks: CodexBackendHooks = {}
): Promise<PhaseExecutionResult> {
  const requireMarker = config.adapters.codexExec.require_marker;
  const workerContextBlock = await buildWorkerPhaseContextBlock(cycle, phase, { storageDir: config.storage_dir });
  try {
    await hooks.onWorkerContext?.(parseWorkerContextMetricsFromBlock(workerContextBlock));
  } catch {
    // best-effort observability callback
  }
  const prompt = [
    "You are executing a Synapse BACKEND phase as a worker subprocess.",
    "The orchestration is already running outside this process.",
    "Your job is to implement backend code changes in the target repository for this phase.",
    "You MAY scan the repository code and tests as needed to understand existing patterns and make a correct backend change.",
    "Prefer targeted scans first (likely folders/files for the feature) before broad searches.",
    "Do NOT act as an orchestrator.",
    "Do NOT call any synapse.* MCP tools.",
    "Do NOT create, cancel, poll, or manage cycles.",
    "Do NOT inspect or manage MCP server configuration or .synapse runtime state.",
    "Ignore Synapse internals and focus on application backend code, tests, and integration points in the target repo.",
    `Phase ID: ${phase.id}`,
    `Phase Type: ${phase.type}`,
    `Repository Root: ${cycle.repo_root}`,
    `Request: ${cycle.request_text}`,
    `Constraints: ${(cycle.constraints || []).join("; ") || "none"}`,
    workerContextBlock,
    "Use the worker context first to focus your scan on likely files and recent phase outputs.",
    "Backend worker checklist:",
    "1) Inspect the relevant backend code and tests in the target repo.",
    "2) Implement the backend change required by the request.",
    "3) Keep changes scoped to the requested backend behavior.",
    "4) If backend changes require frontend updates, set frontend_tweak_required=true in the final structured trailer.",
    "If backend changes require frontend updates, print: frontend_tweak_required=true",
    requireMarker
      ? "Final output line is REQUIRED in this exact format:"
      : "Optional structured output: print one final line only:",
    "SYNAPSE_RESULT_JSON: {\"frontend_tweak_required\": true|false, \"report\": {...}}"
  ].join("\n");

  const command = `${config.adapters.codexExec.command} ${shellEscapeSingleArg(prompt)}`;
  const result = await runShellCommand(command, cycle.repo_root, phase.timeout_ms, config.denylist_substrings, {
    signal,
    termGraceMs: config.cancellation.term_grace_ms
  });
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

  const structured = parseStructuredResult(result.stdout, requireMarker);

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
