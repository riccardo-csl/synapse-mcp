import {
  synapseCancel,
  synapseList,
  synapseLogs,
  synapseOrchestrate,
  synapseRenderPrompt,
  synapseStatus
} from "../synapse/service.js";

const TOOL_HANDLERS: Record<string, (args: any) => Promise<any>> = {
  "synapse.orchestrate": synapseOrchestrate,
  "synapse.status": synapseStatus,
  "synapse.logs": synapseLogs,
  "synapse.cancel": synapseCancel,
  "synapse.list": synapseList,
  "synapse.render_prompt": synapseRenderPrompt
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
