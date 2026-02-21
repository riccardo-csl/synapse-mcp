import path from "node:path";
import { nowIso } from "../core/time.js";
import { synapseError } from "./errors.js";
import {
  cancelCycle,
  createCycleSpec,
  summarizePhases,
  validatePlanPhases
} from "./stateMachine.js";
import { listCycles, readCycle, writeCycle } from "./store.js";
import type { CycleStatus, OrchestrateInput } from "./types.js";

function resolveRepoRoot(repoRoot?: string): string {
  return path.resolve(repoRoot || process.cwd());
}

function ensureString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw synapseError("SCHEMA_INVALID", `${label} must be a non-empty string`, { label });
  }
  return value.trim();
}

function ensureStringArray(value: unknown, label: string): string[] {
  if (typeof value === "undefined") {
    return [];
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw synapseError("SCHEMA_INVALID", `${label} must be an array of strings`, { label });
  }
  return value;
}

function ensureOptionalStatus(value: unknown): CycleStatus | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }
  if (value !== "QUEUED" && value !== "RUNNING" && value !== "DONE" && value !== "FAILED" && value !== "CANCELED") {
    throw synapseError("SCHEMA_INVALID", "status must be a valid CycleStatus");
  }
  return value;
}

export async function synapseOrchestrate(args: Partial<OrchestrateInput> = {}) {
  const request = ensureString(args.request, "request");
  const repo_root = resolveRepoRoot(args.repo_root);
  const constraints = ensureStringArray(args.constraints, "constraints");
  const phases = validatePlanPhases(args.plan?.phases);

  const cycle = createCycleSpec({
    request,
    repo_root,
    constraints,
    phases
  });

  await writeCycle(repo_root, cycle);

  return {
    cycle_id: cycle.id,
    status: cycle.status,
    phases: summarizePhases(cycle.phases)
  };
}

export async function synapseStatus(args: { cycle_id?: string; repo_root?: string } = {}) {
  const cycle_id = ensureString(args.cycle_id, "cycle_id");
  const repo_root = resolveRepoRoot(args.repo_root);
  const cycle = await readCycle(repo_root, cycle_id);

  return {
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
  };
}

export async function synapseLogs(args: { cycle_id?: string; tail?: number; repo_root?: string } = {}) {
  const cycle_id = ensureString(args.cycle_id, "cycle_id");
  const repo_root = resolveRepoRoot(args.repo_root);
  const cycle = await readCycle(repo_root, cycle_id);

  const tail = typeof args.tail === "number" && args.tail > 0 ? Math.floor(args.tail) : null;
  const entries = tail ? cycle.logs.slice(-tail) : cycle.logs;

  return {
    cycle_id: cycle.id,
    entries
  };
}

export async function synapseCancel(args: { cycle_id?: string; reason?: string; repo_root?: string } = {}) {
  const cycle_id = ensureString(args.cycle_id, "cycle_id");
  const repo_root = resolveRepoRoot(args.repo_root);
  const cycle = await readCycle(repo_root, cycle_id);

  cancelCycle(cycle, typeof args.reason === "string" ? args.reason : undefined);
  cycle.updated_at = nowIso();
  await writeCycle(repo_root, cycle);

  return {
    cycle_id: cycle.id,
    status: cycle.status
  };
}

export async function synapseList(args: { limit?: number; status?: CycleStatus; repo_root?: string } = {}) {
  const repo_root = resolveRepoRoot(args.repo_root);
  const status = ensureOptionalStatus(args.status);
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 20;
  const cycles = await listCycles(repo_root, { limit, status });

  return {
    cycles: cycles.map((cycle) => ({
      id: cycle.id,
      status: cycle.status,
      current_phase_index: cycle.current_phase_index,
      created_at: cycle.created_at,
      updated_at: cycle.updated_at,
      request_text: cycle.request_text,
      repo_root: cycle.repo_root
    }))
  };
}

export async function synapseRenderPrompt(args: { request?: string } = {}) {
  const request = typeof args.request === "string" && args.request.trim()
    ? args.request.trim()
    : "Implement the frontend for feature X";

  return {
    snippet: `${request}. Use synapse-mcp orchestration: call synapse.orchestrate with this request and follow synapse.status until DONE/FAILED.`
  };
}
