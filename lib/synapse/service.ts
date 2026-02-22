import path from "node:path";
import { nowIso } from "../core/time.js";
import { synapseError } from "./errors.js";
import {
  cancelCycle,
  createCycleSpec,
  summarizePhases
} from "./stateMachine.js";
import { listCycles, readCycle, writeCycle } from "./store.js";
import {
  cancelInputSchema,
  cancelOutputSchema,
  listInputSchema,
  listOutputSchema,
  logsInputSchema,
  logsOutputSchema,
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
