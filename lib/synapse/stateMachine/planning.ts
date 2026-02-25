import type { CycleSpec, PhaseControlMode, PhaseSpec, PhaseStatus, PhaseSummary, PhaseType } from "../types.js";
import { synapseError } from "../errors.js";

const DEFAULT_PHASE_ORDER: PhaseType[] = ["FRONTEND", "BACKEND", "FRONTEND_TWEAK"];

export function phaseControlMode(phase: PhaseSpec): PhaseControlMode {
  const mode = phase.input?.control_mode;
  if (mode === "ORCHESTRATOR") {
    return "ORCHESTRATOR";
  }
  return "RUNNER";
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
    input: {
      control_mode: type === "BACKEND" ? "ORCHESTRATOR" : "RUNNER"
    },
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
    max_attempts: phase.max_attempts,
    control_mode: phaseControlMode(phase)
  }));
}

export function nextPendingPhaseIndex(cycle: CycleSpec): number | null {
  for (let i = 0; i < cycle.phases.length; i += 1) {
    if (cycle.phases[i].status === "PENDING") {
      return i;
    }
  }
  return null;
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
