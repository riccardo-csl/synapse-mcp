import path from "node:path";
import { nowIso } from "../core/time.js";
import { synapseError } from "./errors.js";
import {
  cancelCycle,
  completeManualPhase,
  createCycleSpec,
  failManualPhase,
  startManualPhase,
  summarizePhases
} from "./stateMachine.js";
import { listCycles, readCycle, withCycleLock, writeCycle } from "./store.js";
import type { PhaseExecutionResult } from "./types.js";
import {
  cancelInputSchema,
  cancelOutputSchema,
  listInputSchema,
  listOutputSchema,
  logsInputSchema,
  logsOutputSchema,
  manualPhaseCompleteInputSchema,
  manualPhaseCompleteOutputSchema,
  manualPhaseFailInputSchema,
  manualPhaseFailOutputSchema,
  manualPhaseStartInputSchema,
  manualPhaseStartOutputSchema,
  orchestrateInputSchema,
  orchestrateOutputSchema,
  parseOrSchemaError,
  renderPromptInputSchema,
  renderPromptOutputSchema,
  statusInputSchema,
  statusOutputSchema
} from "./schemas.js";

function resolveRepoRoot(repoRoot?: string): string {
  return path.resolve(repoRoot || process.cwd());
}

function uniqStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => typeof v === "string" && v.length > 0)));
}

function durationMs(startedAt: string | null, fallbackStartMs = Date.now()): number {
  if (startedAt) {
    const ts = Date.parse(startedAt);
    if (Number.isFinite(ts)) {
      return Math.max(0, Date.now() - ts);
    }
  }
  return Math.max(0, Date.now() - fallbackStartMs);
}

function nextPhaseIdFromCurrent(cycle: Awaited<ReturnType<typeof readCycle>>): string | null {
  if (typeof cycle.current_phase_index !== "number") {
    return null;
  }
  return cycle.phases[cycle.current_phase_index]?.id || null;
}

export async function synapseOrchestrate(args: unknown = {}) {
  const input = parseOrSchemaError(orchestrateInputSchema, args, "Invalid synapse.orchestrate input");
  const request = input.request.trim();
  const repo_root = resolveRepoRoot(input.repo_root);
  const constraints = input.constraints || [];
  const phases = input.plan?.phases;

  const cycle = createCycleSpec({
    request,
    repo_root,
    constraints,
    phases
  });

  await writeCycle(repo_root, cycle);

  return parseOrSchemaError(orchestrateOutputSchema, {
    cycle_id: cycle.id,
    status: cycle.status,
    phases: summarizePhases(cycle.phases)
  }, "Invalid synapse.orchestrate output");
}

export async function synapseStatus(args: unknown = {}) {
  const input = parseOrSchemaError(statusInputSchema, args, "Invalid synapse.status input");
  const cycle_id = input.cycle_id;
  const repo_root = resolveRepoRoot(input.repo_root);
  const cycle = await readCycle(repo_root, cycle_id);

  return parseOrSchemaError(statusOutputSchema, {
    cycle_id: cycle.id,
    status: cycle.status,
    current_phase_index: cycle.current_phase_index,
    phases: summarizePhases(cycle.phases),
    created_at: cycle.created_at,
    updated_at: cycle.updated_at,
    last_error: cycle.last_error,
    canceled_reason: cycle.canceled_reason,
    repo_root: cycle.repo_root,
    request: cycle.request_text,
    artifacts: cycle.artifacts
  }, "Invalid synapse.status output");
}

export async function synapseLogs(args: unknown = {}) {
  const input = parseOrSchemaError(logsInputSchema, args, "Invalid synapse.logs input");
  const cycle_id = input.cycle_id;
  const repo_root = resolveRepoRoot(input.repo_root);
  const cycle = await readCycle(repo_root, cycle_id);

  const tail = typeof input.tail === "number" && input.tail > 0 ? Math.floor(input.tail) : null;
  const entries = tail ? cycle.logs.slice(-tail) : cycle.logs;

  return parseOrSchemaError(logsOutputSchema, {
    cycle_id: cycle.id,
    entries
  }, "Invalid synapse.logs output");
}

export async function synapseCancel(args: unknown = {}) {
  const input = parseOrSchemaError(cancelInputSchema, args, "Invalid synapse.cancel input");
  const cycle_id = input.cycle_id;
  const repo_root = resolveRepoRoot(input.repo_root);
  const cycle = await readCycle(repo_root, cycle_id);

  cancelCycle(cycle, input.reason);
  cycle.updated_at = nowIso();
  await writeCycle(repo_root, cycle);

  return parseOrSchemaError(cancelOutputSchema, {
    cycle_id: cycle.id,
    status: cycle.status
  }, "Invalid synapse.cancel output");
}

export async function synapsePhaseStartManual(args: unknown = {}) {
  const input = parseOrSchemaError(manualPhaseStartInputSchema, args, "Invalid synapse.phase.start_manual input");
  const repo_root = resolveRepoRoot(input.repo_root);

  const result = await withCycleLock(repo_root, input.cycle_id, async () => {
    const cycle = await readCycle(repo_root, input.cycle_id);
    startManualPhase(cycle, input.phase_id, input.note);
    await writeCycle(repo_root, cycle);
    return {
      cycle_id: cycle.id,
      phase_id: input.phase_id,
      status: "RUNNING" as const
    };
  });

  return parseOrSchemaError(manualPhaseStartOutputSchema, result, "Invalid synapse.phase.start_manual output");
}

export async function synapsePhaseCompleteManual(args: unknown = {}) {
  const input = parseOrSchemaError(manualPhaseCompleteInputSchema, args, "Invalid synapse.phase.complete_manual input");
  const repo_root = resolveRepoRoot(input.repo_root);

  const result = await withCycleLock(repo_root, input.cycle_id, async () => {
    const cycle = await readCycle(repo_root, input.cycle_id);
    const phaseIndex = cycle.current_phase_index;
    if (phaseIndex === null || cycle.phases[phaseIndex]?.id !== input.phase_id) {
      throw synapseError("INVALID_PHASE", "phase is not current", {
        cycle_id: cycle.id,
        phase_id: input.phase_id,
        current_phase_id: phaseIndex === null ? null : cycle.phases[phaseIndex]?.id || null
      });
    }
    const phase = cycle.phases[phaseIndex];

    const checksResults = (input.output.report.checks_results || []) as Array<{
      command: string;
      ok: boolean;
      code: number | null;
      stdout_tail: string;
      stderr_tail: string;
    }>;
    const checksRun = input.output.report.checks_run || [];
    const changedFiles = input.output.changed_files || [];

    cycle.artifacts.changed_files = uniqStrings([
      ...cycle.artifacts.changed_files,
      ...changedFiles
    ]);
    cycle.artifacts.commands_run = uniqStrings([
      ...cycle.artifacts.commands_run,
      ...checksRun
    ]);
    cycle.artifacts.test_results.push(...checksResults);

    const phaseDuration = durationMs(phase.started_at, Date.now());
    cycle.artifacts.phase_durations_ms[input.phase_id] =
      (cycle.artifacts.phase_durations_ms[input.phase_id] || 0) + phaseDuration;

    const execResult: PhaseExecutionResult = {
      report: input.output.report,
      commands_run: checksRun,
      frontend_tweak_required: input.output.frontend_tweak_required
    };

    completeManualPhase(cycle, input.phase_id, input.output as unknown as Record<string, unknown>, execResult);

    cycle.artifacts.attempt_history.push({
      phase_id: input.phase_id,
      attempt: phase.attempt_count || 0,
      started_at: phase.started_at || null,
      finished_at: phase.finished_at || nowIso(),
      outcome: "DONE"
    });

    await writeCycle(repo_root, cycle);

    return {
      cycle_id: cycle.id,
      phase_id: input.phase_id,
      phase_status: "DONE" as const,
      cycle_status: cycle.status,
      next_phase_id: nextPhaseIdFromCurrent(cycle)
    };
  });

  return parseOrSchemaError(manualPhaseCompleteOutputSchema, result, "Invalid synapse.phase.complete_manual output");
}

export async function synapsePhaseFailManual(args: unknown = {}) {
  const input = parseOrSchemaError(manualPhaseFailInputSchema, args, "Invalid synapse.phase.fail_manual input");
  const repo_root = resolveRepoRoot(input.repo_root);

  const result = await withCycleLock(repo_root, input.cycle_id, async () => {
    const cycle = await readCycle(repo_root, input.cycle_id);
    const phaseIndex = cycle.current_phase_index;
    if (phaseIndex === null || cycle.phases[phaseIndex]?.id !== input.phase_id) {
      throw synapseError("INVALID_PHASE", "phase is not current", {
        cycle_id: cycle.id,
        phase_id: input.phase_id,
        current_phase_id: phaseIndex === null ? null : cycle.phases[phaseIndex]?.id || null
      });
    }
    const phase = cycle.phases[phaseIndex];

    const phaseDuration = durationMs(phase.started_at, Date.now());
    cycle.artifacts.phase_durations_ms[input.phase_id] =
      (cycle.artifacts.phase_durations_ms[input.phase_id] || 0) + phaseDuration;

    failManualPhase(cycle, input.phase_id, {
      code: input.error.code,
      message: input.error.message,
      ...(input.error.details ? { details: input.error.details } : {})
    });

    cycle.artifacts.attempt_history.push({
      phase_id: input.phase_id,
      attempt: phase.attempt_count || 0,
      started_at: phase.started_at || null,
      finished_at: phase.finished_at || nowIso(),
      outcome: "FAILED",
      error_code: input.error.code
    });

    await writeCycle(repo_root, cycle);

    return {
      cycle_id: cycle.id,
      phase_id: input.phase_id,
      phase_status: "FAILED" as const,
      cycle_status: "FAILED" as const
    };
  });

  return parseOrSchemaError(manualPhaseFailOutputSchema, result, "Invalid synapse.phase.fail_manual output");
}

export async function synapseList(args: unknown = {}) {
  const input = parseOrSchemaError(listInputSchema, args, "Invalid synapse.list input");
  const repo_root = resolveRepoRoot(input.repo_root);
  const status = input.status;
  const limit = typeof input.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : 20;
  const cycles = await listCycles(repo_root, { limit, status });

  return parseOrSchemaError(listOutputSchema, {
    cycles: cycles.map((cycle) => ({
      id: cycle.id,
      status: cycle.status,
      current_phase_index: cycle.current_phase_index,
      created_at: cycle.created_at,
      updated_at: cycle.updated_at,
      request_text: cycle.request_text,
      repo_root: cycle.repo_root
    }))
  }, "Invalid synapse.list output");
}

export async function synapseRenderPrompt(args: unknown = {}) {
  const input = parseOrSchemaError(renderPromptInputSchema, args, "Invalid synapse.render_prompt input");
  const request = typeof input.request === "string" && input.request.trim()
    ? input.request.trim()
    : "Implement the frontend for feature X";

  return parseOrSchemaError(renderPromptOutputSchema, {
    snippet: `${request}. Use synapse-mcp orchestration: call synapse.orchestrate with this request and follow synapse.status until DONE/FAILED.`
  }, "Invalid synapse.render_prompt output");
}
