export const toolDefinitions = [
  {
    name: "cycle.start",
    description: "Start a new cycle and acquire the initial lock token.",
    inputSchema: {
      type: "object",
      properties: {
        feature: { type: "string" },
        mode: { type: "string" }
      },
      required: ["feature"]
    }
  },
  {
    name: "cycle.status",
    description: "Return current cycle status and lock state.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "handoff.read",
    description: "Read a handoff payload.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["codex", "gemini"] }
      },
      required: ["target"]
    }
  },
  {
    name: "session.open",
    description: "Open a role-bound session with PSK credentials.",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["codex", "gemini"] },
        psk: { type: "string" }
      },
      required: ["role", "psk"]
    }
  },
  {
    name: "lock.acquire",
    description: "Acquire the active role lock token for the current cycle.",
    inputSchema: {
      type: "object",
      properties: {
        session_token: { type: "string" }
      },
      required: ["session_token"]
    }
  },
  {
    name: "handoff.write",
    description: "Write a handoff payload with lock validation.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["codex", "gemini"] },
        payload: { type: "object" },
        lock_token: { type: "string" },
        session_token: { type: "string" }
      },
      required: ["target", "payload", "lock_token", "session_token"]
    }
  },
  {
    name: "cycle.complete",
    description: "Mark the cycle complete (frontend_refine only).",
    inputSchema: {
      type: "object",
      properties: {
        lock_token: { type: "string" },
        session_token: { type: "string" }
      },
      required: ["lock_token", "session_token"]
    }
  },
  {
    name: "cycle.archive",
    description: "Archive the completed cycle and reset state.",
    inputSchema: {
      type: "object",
      properties: {
        lock_token: { type: "string" },
        session_token: { type: "string" }
      },
      required: ["lock_token", "session_token"]
    }
  }
];
