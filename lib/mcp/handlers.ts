import {
  synapseCancel,
  synapseList,
  synapseLogs,
  synapseOrchestrate,
  synapsePhaseCompleteManual,
  synapsePhaseFailManual,
  synapsePhaseStartManual,
  synapseRenderBackendCompletionTemplate,
  synapseRenderPrompt,
  synapseStatus
} from "../synapse/service.js";

const TOOL_HANDLERS: Record<string, (args: any) => Promise<any>> = {
  "synapse.orchestrate": synapseOrchestrate,
  "synapse.status": synapseStatus,
  "synapse.logs": synapseLogs,
  "synapse.cancel": synapseCancel,
  "synapse.list": synapseList,
  "synapse.render_prompt": synapseRenderPrompt,
  "synapse.render_backend_completion_template": synapseRenderBackendCompletionTemplate,
  "synapse.phase.start_manual": synapsePhaseStartManual,
  "synapse.phase.complete_manual": synapsePhaseCompleteManual,
  "synapse.phase.fail_manual": synapsePhaseFailManual
};

export async function executeTool(name: string, args: Record<string, unknown> = {}) {
  const fn = TOOL_HANDLERS[name];
  if (!fn) {
    return {
      ok: false,
      error: {
        code: "INVALID_TOOL",
        message: `Unknown tool: ${name}`,
        details: { name }
      }
    };
  }

  try {
    const data = await fn(args);
    return { ok: true, data };
  } catch (err: any) {
    return {
      ok: false,
      error: {
        code: err?.code || "INTERNAL_ERROR",
        message: err?.message || "Unknown error",
        details: err?.details || {}
      }
    };
  }
}
