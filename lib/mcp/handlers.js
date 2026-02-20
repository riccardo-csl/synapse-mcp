import {
  cycleArchive,
  cycleComplete,
  cycleStart,
  cycleStatus,
  handoffRead,
  handoffWrite,
  lockAcquire,
  sessionOpen
} from "../index.js";

const TOOL_HANDLERS = {
  "cycle.start": cycleStart,
  "cycle.status": () => cycleStatus(),
  "handoff.read": handoffRead,
  "session.open": sessionOpen,
  "lock.acquire": lockAcquire,
  "handoff.write": handoffWrite,
  "cycle.complete": cycleComplete,
  "cycle.archive": cycleArchive
};

export async function executeTool(name, args = {}) {
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
  } catch (err) {
    return {
      ok: false,
      error: {
        code: err.code || "INTERNAL_ERROR",
        message: err.message || "Unknown error",
        details: err.details || {}
      }
    };
  }
}
