import { ensureActiveCycle, ensureLock } from "../../core/guards.js";
import { brokerError } from "../../core/errors.js";
import { ensureAuthConfig, loadConfig } from "../config/service.js";
import { loadLock, loadState } from "../../storage/state-store.js";
import { pathsFor } from "../../storage/paths.js";
import { idleState } from "../cycle/model.js";
import { unlockedState } from "./model.js";
import { validateSession } from "../session/service.js";

export async function lockAcquire({ session_token }, baseDir) {
  const config = await loadConfig(baseDir);
  ensureAuthConfig(config);
  const paths = pathsFor(baseDir);
  const state = await loadState(paths, config, idleState);
  const lock = await loadLock(paths, unlockedState);
  const sessionRole = await validateSession(paths, session_token);
  ensureActiveCycle(state);

  if (state.active_role !== sessionRole) {
    throw brokerError("LOCK_DENIED", "role is not active for the current phase", {
      activeRole: state.active_role,
      requestedRole: sessionRole
    });
  }
  if (!lock.locked || lock.role !== sessionRole || !lock.lock_token) {
    throw brokerError("LOCK_DENIED", "lock is not held by requested role", {
      locked: lock.locked,
      lockRole: lock.role,
      requestedRole: sessionRole
    });
  }

  return {
    cycle_id: state.cycle_id,
    role: sessionRole,
    lock_token: lock.lock_token
  };
}

export { ensureLock };
