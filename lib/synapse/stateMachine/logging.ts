import { nowIso } from "../../core/time.js";
import type { CycleSpec, LogEntry } from "../types.js";

export function addLog(
  cycle: CycleSpec,
  level: LogEntry["level"],
  message: string,
  meta?: Record<string, unknown>,
  phaseId?: string
): void {
  cycle.logs.push({
    ts: nowIso(),
    level,
    phase_id: phaseId,
    message,
    meta
  });
  cycle.updated_at = nowIso();
}

export function isTerminal(status: string): boolean {
  return status === "DONE" || status === "FAILED" || status === "CANCELED";
}
