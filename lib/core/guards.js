import { brokerError } from "./errors.js";

export function ensureActiveCycle(state) {
  if (!state || state.active !== true || !state.cycle_id || !state.phase) {
    throw brokerError("NO_ACTIVE_CYCLE", "No active cycle. Call cycle.start first.");
  }
}

export function ensureLock(lock, lockToken) {
  if (!lock || !lock.locked) {
    throw brokerError("LOCK_DENIED", "Lock is not held.");
  }
  if (!lockToken || lockToken !== lock.lock_token) {
    throw brokerError("LOCK_DENIED", "Invalid lock_token.");
  }
}
