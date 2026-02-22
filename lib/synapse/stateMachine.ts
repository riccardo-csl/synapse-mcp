import { randomBytes } from "node:crypto";
import { nowIso } from "../core/time.js";
import { synapseError } from "./errors.js";
import type {
  CycleSpec,
  LogEntry,
  OrchestrateInput,
  PhaseExecutionResult,
  PhaseSpec,
  PhaseStatus,
  PhaseSummary,
  PhaseType
} from "./types.js";

const DEFAULT_PHASE_ORDER: PhaseType[] = ["FRONTEND", "BACKEND", "FRONTEND_TWEAK"];

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 40) || "cycle";
}

function defaultTimeout(type: PhaseType): number {
  if (type === "FRONTEND") {
    return 15 * 60 * 1000;
  }
  if (type === "BACKEND") {
    return 15 * 60 * 1000;
  }
  return 10 * 60 * 1000;
}

function defaultMaxAttempts(type: PhaseType): number {
  if (type === "BACKEND") {
    return 2;
  }
  return 2;
}

export function buildPhases(phaseTypes?: PhaseType[]): PhaseSpec[] {
  const types = phaseTypes?.length ? phaseTypes : DEFAULT_PHASE_ORDER;
  return types.map((type, index) => ({
    id: `phase_${index + 1}_${type.toLowerCase()}`,
    type,
    status: "PENDING",
    input: {},
    output: null,
    started_at: null,
    finished_at: null,
    attempt_count: 0,
    max_attempts: defaultMaxAttempts(type),
    timeout_ms: defaultTimeout(type),
    claim_token: null,
    claimed_by: null
  }));
}

export function summarizePhases(phases: PhaseSpec[]): PhaseSummary[] {
  return phases.map((phase) => ({
    id: phase.id,
    type: phase.type,
    status: phase.status,
    attempt_count: phase.attempt_count,
    max_attempts: phase.max_attempts
  }));
}

export function createCycleSpec(input: Required<Pick<OrchestrateInput, "request" | "repo_root">> & {
  constraints: string[];
  phases?: PhaseType[];
}): CycleSpec {
  const createdAt = nowIso();
  const id = `${createdAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}_${slugify(input.request)}_${randomBytes(3).toString("hex")}`;
  const phases = buildPhases(input.phases);

  return {
    schema_version: 1,
    id,
    created_at: createdAt,
    updated_at: createdAt,
    request_text: input.request,
    repo_root: input.repo_root,
    constraints: input.constraints,
    phases,
    status: "QUEUED",
    current_phase_index: phases.length ? 0 : null,
    artifacts: {
      changed_files: [],
      commands_run: [],
      test_results: [],
      phase_durations_ms: {},
      attempt_history: []
    },
    logs: [
      {
        ts: createdAt,
        level: "INFO",
        message: "Cycle created"
      }
    ],
    last_error: null,
    canceled_reason: null
  };
}

export function addLog(
  cycle: CycleSpec,
  level: LogEntry["level"],
  message: string,
  meta?: Record<string, unknown>,
  phaseId?: string
): void {
  cycle.logs.push({
    ts: nowIso(),
    level,
    phase_id: phaseId,
    message,
    meta
  });
  cycle.updated_at = nowIso();
}

function isTerminal(status: string): boolean {
  return status === "DONE" || status === "FAILED" || status === "CANCELED";
}

export function nextPendingPhaseIndex(cycle: CycleSpec): number | null {
  for (let i = 0; i < cycle.phases.length; i += 1) {
    if (cycle.phases[i].status === "PENDING") {
      return i;
    }
  }
  return null;
}

function isStalePhaseClaim(phase: PhaseSpec, reclaimStaleMs: number): boolean {
  if (reclaimStaleMs <= 0) {
    return false;
  }
  const ts = phase.started_at ? Date.parse(phase.started_at) : NaN;
  if (Number.isFinite(ts)) {
    return Date.now() - ts > reclaimStaleMs;
  }
  return phase.status === "CLAIMED";
}

export function claimCurrentPhase(
  cycle: CycleSpec,
  runnerId: string,
  options: { reclaim_stale_ms?: number } = {}
): { phaseIndex: number; claimToken: string } | null {
  if (isTerminal(cycle.status)) {
    return null;
  }

  const idx = typeof cycle.current_phase_index === "number" ? cycle.current_phase_index : nextPendingPhaseIndex(cycle);
  if (idx === null) {
    cycle.status = "DONE";
    cycle.current_phase_index = null;
    cycle.updated_at = nowIso();
    return null;
  }

  const phase = cycle.phases[idx];
  if (
    (phase.status === "CLAIMED" || phase.status === "RUNNING")
    && isStalePhaseClaim(phase, options.reclaim_stale_ms || 0)
  ) {
    phase.status = "PENDING";
    phase.claim_token = null;
    phase.claimed_by = null;
    phase.started_at = null;
    addLog(cycle, "INFO", "Reclaimed stale phase claim", { phase_id: phase.id }, phase.id);
  }

  if (phase.status !== "PENDING") {
    return null;
  }

  const claimToken = randomBytes(12).toString("hex");
  phase.status = "CLAIMED";
  phase.claim_token = claimToken;
  phase.claimed_by = runnerId;
  cycle.status = "RUNNING";
  cycle.current_phase_index = idx;
  cycle.updated_at = nowIso();
  addLog(cycle, "INFO", `Phase claimed: ${phase.type}`, undefined, phase.id);

  return { phaseIndex: idx, claimToken };
}

export function markClaimedPhaseRunning(cycle: CycleSpec, phaseIndex: number, claimToken: string): void {
  const phase = cycle.phases[phaseIndex];
  if (!phase) {
    throw synapseError("INVALID_PHASE", "phase index out of range", { phaseIndex });
  }
  if (phase.status !== "CLAIMED" || phase.claim_token !== claimToken) {
    throw synapseError("CLAIM_INVALID", "phase claim token mismatch", {
      phaseIndex,
      status: phase.status
    });
  }

  phase.status = "RUNNING";
  phase.started_at = nowIso();
  phase.attempt_count += 1;
  cycle.updated_at = nowIso();
  addLog(cycle, "INFO", `Phase running: ${phase.type}`, { attempt: phase.attempt_count }, phase.id);
}

function maybeSkipFrontendTweak(cycle: CycleSpec, backendResult: PhaseExecutionResult | null): void {
  const currentIdx = cycle.current_phase_index;
  if (currentIdx === null) {
    return;
  }
  const current = cycle.phases[currentIdx];
  if (!current || current.type !== "BACKEND") {
    return;
  }

  const next = cycle.phases[currentIdx + 1];
  if (!next || next.type !== "FRONTEND_TWEAK" || next.status !== "PENDING") {
    return;
  }

  if (backendResult?.frontend_tweak_required) {
    addLog(cycle, "INFO", "Frontend tweak required by backend output", undefined, next.id);
    return;
  }

  next.status = "SKIPPED";
  next.finished_at = nowIso();
  addLog(cycle, "INFO", "Frontend tweak skipped (not required)", undefined, next.id);
}

export function markPhaseDone(
  cycle: CycleSpec,
  phaseIndex: number,
  claimToken: string,
  output: Record<string, unknown> | null,
  execResult: PhaseExecutionResult | null
): void {
  const phase = cycle.phases[phaseIndex];
  if (!phase) {
    throw synapseError("INVALID_PHASE", "phase index out of range", { phaseIndex });
  }
  if (phase.claim_token !== claimToken) {
    throw synapseError("CLAIM_INVALID", "phase claim token mismatch", { phaseIndex });
  }

  phase.status = "DONE";
  phase.output = output;
  phase.finished_at = nowIso();
  phase.claim_token = null;
  phase.claimed_by = null;

  maybeSkipFrontendTweak(cycle, execResult);

  const nextIdx = nextPendingPhaseIndex(cycle);
  cycle.current_phase_index = nextIdx;
  cycle.updated_at = nowIso();
  cycle.last_error = null;

  if (nextIdx === null) {
    cycle.status = "DONE";
    addLog(cycle, "INFO", "Cycle completed successfully", undefined, phase.id);
  } else {
    cycle.status = "RUNNING";
    addLog(cycle, "INFO", `Phase done: ${phase.type}`, undefined, phase.id);
  }
}

export function markPhaseFailed(
  cycle: CycleSpec,
  phaseIndex: number,
  claimToken: string,
  error: { code: string; message: string; details?: Record<string, unknown> },
  options: { forceTerminal?: boolean } = {}
): void {
  const phase = cycle.phases[phaseIndex];
  if (!phase) {
    throw synapseError("INVALID_PHASE", "phase index out of range", { phaseIndex });
  }
  if (phase.claim_token !== claimToken) {
    throw synapseError("CLAIM_INVALID", "phase claim token mismatch", { phaseIndex });
  }

  phase.claim_token = null;
  phase.claimed_by = null;

  const forceTerminal = options.forceTerminal === true;

  if (!forceTerminal && phase.attempt_count < phase.max_attempts) {
    phase.status = "PENDING";
    phase.finished_at = null;
    cycle.status = "RUNNING";
    cycle.current_phase_index = phaseIndex;
    cycle.last_error = error;
    addLog(cycle, "ERROR", `Phase failed; retrying (${phase.attempt_count}/${phase.max_attempts})`, error.details, phase.id);
  } else {
    phase.status = "FAILED";
    phase.finished_at = nowIso();
    cycle.status = "FAILED";
    cycle.current_phase_index = null;
    cycle.last_error = error;
    addLog(cycle, "ERROR", `Phase failed permanently: ${error.message}`, error.details, phase.id);
  }

  cycle.updated_at = nowIso();
}

export function cancelCycle(cycle: CycleSpec, reason?: string): void {
  if (isTerminal(cycle.status)) {
    return;
  }
  cycle.status = "CANCELED";
  cycle.current_phase_index = null;
  cycle.canceled_reason = reason || null;
  cycle.updated_at = nowIso();
  addLog(cycle, "INFO", "Cycle canceled", reason ? { reason } : undefined);
}

export function validatePlanPhases(phases: unknown): PhaseType[] | undefined {
  if (typeof phases === "undefined") {
    return undefined;
  }
  if (!Array.isArray(phases)) {
    throw synapseError("SCHEMA_INVALID", "plan.phases must be an array");
  }
  const valid: PhaseType[] = [];
  for (const phase of phases) {
    if (phase !== "FRONTEND" && phase !== "BACKEND" && phase !== "FRONTEND_TWEAK") {
      throw synapseError("SCHEMA_INVALID", "Invalid phase type in plan.phases", { phase });
    }
    valid.push(phase);
  }
  return valid;
}

export function ensureCycleHasRunnablePhase(cycle: CycleSpec): void {
  const idx = nextPendingPhaseIndex(cycle);
  if (idx === null) {
    throw synapseError("NO_RUNNABLE_PHASE", "No runnable phase in cycle", { cycle_id: cycle.id });
  }
}

export function isPhaseRunnableStatus(status: PhaseStatus): boolean {
  return status === "PENDING";
}
