export const toolDefinitions = [
  {
    name: "synapse.orchestrate",
    description: "Create a new orchestration cycle and queue phases.",
    inputSchema: {
      type: "object",
      properties: {
        request: { type: "string" },
        repo_root: { type: "string" },
        constraints: {
          type: "array",
          items: { type: "string" }
        },
        plan: {
          type: "object",
          properties: {
            phases: {
              type: "array",
              items: { type: "string", enum: ["FRONTEND", "BACKEND", "FRONTEND_TWEAK"] }
            },
            allow_gemini_for_backend: { type: "boolean" }
          }
        }
      },
      required: ["request"]
    }
  },
  {
    name: "synapse.status",
    description: "Read status for a cycle.",
    inputSchema: {
      type: "object",
      properties: {
        cycle_id: { type: "string" },
        repo_root: { type: "string" }
      },
      required: ["cycle_id"]
    }
  },
  {
    name: "synapse.logs",
    description: "Read cycle logs, optionally tailed.",
    inputSchema: {
      type: "object",
      properties: {
        cycle_id: { type: "string" },
        tail: { type: "number" },
        repo_root: { type: "string" }
      },
      required: ["cycle_id"]
    }
  },
  {
    name: "synapse.cancel",
    description: "Cancel a running/queued cycle.",
    inputSchema: {
      type: "object",
      properties: {
        cycle_id: { type: "string" },
        reason: { type: "string" },
        repo_root: { type: "string" }
      },
      required: ["cycle_id"]
    }
  },
  {
    name: "synapse.list",
    description: "List recent cycles.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
        status: { type: "string", enum: ["QUEUED", "RUNNING", "DONE", "FAILED", "CANCELED"] },
        repo_root: { type: "string" }
      }
    }
  },
  {
    name: "synapse.render_prompt",
    description: "Render a user-facing snippet that tells Codex to use Synapse orchestration.",
    inputSchema: {
      type: "object",
      properties: {
        request: { type: "string" }
      }
    }
  }
];
