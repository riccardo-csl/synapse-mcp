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
  },
  {
    name: "synapse.render_backend_completion_template",
    description: "Render a ready-to-fill payload template for synapse.phase.complete_manual (manual BACKEND phase).",
    inputSchema: {
      type: "object",
      properties: {
        cycle_id: { type: "string" },
        phase_id: { type: "string" },
        repo_root: { type: "string" }
      },
      required: ["cycle_id"]
    }
  },
  {
    name: "synapse.phase.start_manual",
    description: "Start an orchestrator-controlled manual phase (currently BACKEND only).",
    inputSchema: {
      type: "object",
      properties: {
        cycle_id: { type: "string" },
        phase_id: { type: "string" },
        repo_root: { type: "string" },
        note: { type: "string" }
      },
      required: ["cycle_id", "phase_id"]
    }
  },
  {
    name: "synapse.phase.complete_manual",
    description: "Complete an orchestrator-controlled manual BACKEND phase with a rich output payload.",
    inputSchema: {
      type: "object",
      properties: {
        cycle_id: { type: "string" },
        phase_id: { type: "string" },
        repo_root: { type: "string" },
        output: {
          type: "object",
          properties: {
            report: {
              type: "object",
              properties: {
                summary: { type: "string" },
                files_modified: { type: "array", items: { type: "string" } },
                checks_run: { type: "array", items: { type: "string" } },
                checks_results: { type: "array", items: { type: "object" } },
                notes: { type: "array", items: { type: "string" } }
              },
              required: ["summary", "files_modified", "checks_run"]
            },
            changed_files: { type: "array", items: { type: "string" } },
            frontend_tweak_required: { type: "boolean" },
            api_contract: { type: "object" }
          },
          required: ["report", "changed_files", "frontend_tweak_required"]
        }
      },
      required: ["cycle_id", "phase_id", "output"]
    }
  },
  {
    name: "synapse.phase.fail_manual",
    description: "Fail an orchestrator-controlled manual BACKEND phase with a structured error.",
    inputSchema: {
      type: "object",
      properties: {
        cycle_id: { type: "string" },
        phase_id: { type: "string" },
        repo_root: { type: "string" },
        error: {
          type: "object",
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            details: { type: "object" }
          },
          required: ["code", "message"]
        }
      },
      required: ["cycle_id", "phase_id", "error"]
    }
  }
];
