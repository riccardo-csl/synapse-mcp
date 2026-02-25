import { randomBytes } from "node:crypto";
import { nowIso } from "../../core/time.js";
import { synapseError } from "../errors.js";
import type { CycleSpec, PhaseExecutionResult, PhaseSpec } from "../types.js";
import { addLog, isTerminal } from "./logging.js";
import { nextPendingPhaseIndex, phaseControlMode } from "./planning.js";

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
    addLog(cycle, "INFO", "Reclaimed stale phase claim", {
      event: "phase.reclaimed",
      phase_id: phase.id
    }, phase.id);
  }

  if (phase.status !== "PENDING") {
    return null;
  }

  if (phaseControlMode(phase) === "ORCHESTRATOR") {
    return null;
  }

  const claimToken = randomBytes(12).toString("hex");
  phase.status = "CLAIMED";
  phase.claim_token = claimToken;
  phase.claimed_by = runnerId;
  cycle.status = "RUNNING";
  cycle.current_phase_index = idx;
  cycle.updated_at = nowIso();
  addLog(cycle, "INFO", `Phase claimed: ${phase.type}`, {
    event: "phase.claimed",
    phase_type: phase.type
  }, phase.id);

  return { phaseIndex: idx, claimToken };
}

function currentPhaseOrThrow(cycle: CycleSpec, phaseId: string): { phase: PhaseSpec; phaseIndex: number } {
  const idx = cycle.current_phase_index;
  if (idx === null) {
    throw synapseError("INVALID_PHASE", "cycle has no current phase", {
      cycle_id: cycle.id,
      phase_id: phaseId
    });
  }
  const phase = cycle.phases[idx];
  if (!phase || phase.id !== phaseId) {
    throw synapseError("INVALID_PHASE", "phase is not current", {
      cycle_id: cycle.id,
      phase_id: phaseId,
      current_phase_id: phase?.id || null
    });
  }
  return { phase, phaseIndex: idx };
}

function assertManualBackendPhase(cycle: CycleSpec, phaseId: string): { phase: PhaseSpec; phaseIndex: number } {
  if (isTerminal(cycle.status)) {
    throw synapseError("INVALID_PHASE", "cycle is terminal", {
      cycle_id: cycle.id,
      status: cycle.status
    });
  }
  const { phase, phaseIndex } = currentPhaseOrThrow(cycle, phaseId);
  if (phase.type !== "BACKEND") {
    throw synapseError("INVALID_PHASE", "manual phase tools only support BACKEND phases", {
      phase_id: phase.id,
      phase_type: phase.type
    });
  }
  if (phaseControlMode(phase) !== "ORCHESTRATOR") {
    throw synapseError("INVALID_PHASE", "phase is not orchestrator-controlled", {
      phase_id: phase.id,
      control_mode: phaseControlMode(phase)
    });
  }
  return { phase, phaseIndex };
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
  addLog(cycle, "INFO", `Phase running: ${phase.type}`, {
    event: "phase.running",
    attempt: phase.attempt_count
  }, phase.id);
}

export function startManualPhase(
  cycle: CycleSpec,
  phaseId: string,
  note?: string
): { phaseIndex: number; claimToken: string } {
  const { phase, phaseIndex } = assertManualBackendPhase(cycle, phaseId);
  if (phase.status !== "PENDING") {
    throw synapseError("INVALID_PHASE", "manual phase must be pending before start", {
      phase_id: phase.id,
      status: phase.status
    });
  }

  const claimToken = randomBytes(12).toString("hex");
  phase.status = "RUNNING";
  phase.claim_token = claimToken;
  phase.claimed_by = "orchestrator";
  phase.started_at = nowIso();
  phase.attempt_count += 1;
  cycle.status = "RUNNING";
  cycle.updated_at = nowIso();

  addLog(cycle, "INFO", `Manual phase started: ${phase.type}`, {
    event: "phase.manual.started",
    phase_type: phase.type,
    attempt: phase.attempt_count,
    ...(note ? { note } : {})
  }, phase.id);

  return { phaseIndex, claimToken };
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

  // Cancellation is terminal. If a cancel lands while the adapter/checks are finishing,
  // preserve the canceled cycle and only clean up the in-flight claim.
  if (cycle.status === "CANCELED") {
    if (phase.status === "CLAIMED" || phase.status === "RUNNING") {
      phase.status = "FAILED";
    }
    if (!phase.finished_at) {
      phase.finished_at = nowIso();
    }
    phase.claim_token = null;
    phase.claimed_by = null;
    cycle.updated_at = nowIso();
    return;
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
    addLog(cycle, "INFO", "Cycle completed successfully", {
      event: "cycle.completed"
    }, phase.id);
  } else {
    cycle.status = "RUNNING";
    addLog(cycle, "INFO", `Phase done: ${phase.type}`, {
      event: "phase.done",
      phase_type: phase.type
    }, phase.id);
  }
}

export function completeManualPhase(
  cycle: CycleSpec,
  phaseId: string,
  output: Record<string, unknown> | null,
  execResult: PhaseExecutionResult | null
): void {
  const { phase, phaseIndex } = assertManualBackendPhase(cycle, phaseId);
  if (phase.status !== "RUNNING") {
    throw synapseError("INVALID_PHASE", "manual phase must be RUNNING before completion", {
      phase_id: phase.id,
      status: phase.status
    });
  }
  if (phase.claimed_by !== "orchestrator" || !phase.claim_token) {
    throw synapseError("CLAIM_INVALID", "manual phase is not claimed by orchestrator", {
      phase_id: phase.id,
      claimed_by: phase.claimed_by
    });
  }
  markPhaseDone(cycle, phaseIndex, phase.claim_token, output, execResult);
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

  if (cycle.status === "CANCELED") {
    if (phase.status === "CLAIMED" || phase.status === "RUNNING") {
      phase.status = "FAILED";
    }
    if (!phase.finished_at) {
      phase.finished_at = nowIso();
    }
    phase.claim_token = null;
    phase.claimed_by = null;
    cycle.updated_at = nowIso();
    return;
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
    addLog(cycle, "ERROR", `Phase failed; retrying (${phase.attempt_count}/${phase.max_attempts})`, {
      ...(error.details || {}),
      event: "phase.retrying"
    }, phase.id);
  } else {
    phase.status = "FAILED";
    phase.finished_at = nowIso();
    cycle.status = "FAILED";
    cycle.current_phase_index = null;
    cycle.last_error = error;
    addLog(cycle, "ERROR", `Phase failed permanently: ${error.message}`, {
      ...(error.details || {}),
      event: "phase.failed"
    }, phase.id);
  }

  cycle.updated_at = nowIso();
}

export function failManualPhase(
  cycle: CycleSpec,
  phaseId: string,
  error: { code: string; message: string; details?: Record<string, unknown> }
): void {
  const { phase, phaseIndex } = assertManualBackendPhase(cycle, phaseId);
  if (phase.status !== "RUNNING") {
    throw synapseError("INVALID_PHASE", "manual phase must be RUNNING before failure", {
      phase_id: phase.id,
      status: phase.status
    });
  }
  if (phase.claimed_by !== "orchestrator" || !phase.claim_token) {
    throw synapseError("CLAIM_INVALID", "manual phase is not claimed by orchestrator", {
      phase_id: phase.id,
      claimed_by: phase.claimed_by
    });
  }
  markPhaseFailed(cycle, phaseIndex, phase.claim_token, error, { forceTerminal: true });
}

export function cancelCycle(cycle: CycleSpec, reason?: string): void {
  if (isTerminal(cycle.status)) {
    return;
  }
  cycle.status = "CANCELED";
  cycle.current_phase_index = null;
  cycle.canceled_reason = reason || null;
  cycle.updated_at = nowIso();
  addLog(cycle, "INFO", "Cycle canceled", {
    event: "cycle.canceled",
    ...(reason ? { reason } : {})
  });
}
