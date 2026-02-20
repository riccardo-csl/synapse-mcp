import { ROLE_CODEX, ROLE_GEMINI } from "../../core/constants.js";
import { brokerError } from "../../core/errors.js";
import { ensureActiveCycle } from "../../core/guards.js";
import { randomToken } from "../../core/ids.js";
import { nowIso } from "../../core/time.js";
import { atomicWriteJson, readJsonIfExists } from "../../storage/files.js";
import { pathsFor } from "../../storage/paths.js";
import { loadLock, loadState } from "../../storage/state-store.js";
import { ensureAuthConfig, loadConfig } from "../config/service.js";
import { phaseForWrite } from "../cycle/fsm.js";
import { idleState } from "../cycle/model.js";
import { expectedActors, validatePayload } from "./schema.js";
import { unlockedState } from "../lock/model.js";
import { ensureLock } from "../lock/service.js";
import { validateSession } from "../session/service.js";

export async function handoffRead({ target }, baseDir) {
  const config = await loadConfig(baseDir);
  const paths = pathsFor(baseDir);
  await loadState(paths, config, idleState);

  if (target !== ROLE_CODEX && target !== ROLE_GEMINI) {
    throw brokerError("INVALID_TARGET", "target must be codex or gemini", { target });
  }
  const filePath = target === ROLE_CODEX ? paths.handoffCodex : paths.handoffGemini;
  const payload = await readJsonIfExists(filePath);
  return payload || {};
}

export async function handoffWrite({ target, payload, lock_token, session_token }, baseDir) {
  const config = await loadConfig(baseDir);
  ensureAuthConfig(config);
  const paths = pathsFor(baseDir);
  const state = await loadState(paths, config, idleState);
  const lock = await loadLock(paths, unlockedState);
  const sessionRole = await validateSession(paths, session_token);
  ensureActiveCycle(state);

  if (target !== ROLE_CODEX && target !== ROLE_GEMINI) {
    throw brokerError("INVALID_TARGET", "target must be codex or gemini", { target });
  }

  const transition = phaseForWrite(state.phase, target);
  if (!transition) {
    throw brokerError("INVALID_PHASE", "handoff.write not allowed for current phase/target", {
      phase: state.phase,
      target
    });
  }

  const producerRole = expectedActors(target).producer;
  if (sessionRole !== producerRole) {
    throw brokerError("LOCK_DENIED", "session role does not match handoff producer role", {
      sessionRole,
      producerRole,
      target
    });
  }
  if (sessionRole !== state.active_role) {
    throw brokerError("LOCK_DENIED", "session role is not active for current phase", {
      sessionRole,
      activeRole: state.active_role
    });
  }
  if (lock.role !== state.active_role) {
    throw brokerError("LOCK_DENIED", "lock role does not match active role", {
      lockRole: lock.role,
      activeRole: state.active_role
    });
  }
  ensureLock(lock, lock_token);

  validatePayload(payload, target, state);

  const now = nowIso();
  const filePath = target === ROLE_CODEX ? paths.handoffCodex : paths.handoffGemini;

  await atomicWriteJson(filePath, payload);

  const updatedState = {
    ...state,
    phase: transition.nextPhase,
    active_role: transition.nextRole,
    updated_at: now,
    handoff_status: {
      ...state.handoff_status,
      [target]: "present"
    }
  };

  let nextLock = lock;
  if (transition.rotate) {
    const nextLockToken = randomToken();
    nextLock = {
      locked: true,
      role: transition.nextRole,
      lock_token: nextLockToken,
      cycle_id: state.cycle_id,
      acquired_at: now,
      expires_at: null
    };
  }

  await atomicWriteJson(paths.statePath, updatedState);
  if (transition.rotate) {
    await atomicWriteJson(paths.lockPath, nextLock);
  }

  return {
    ok: true,
    phase: updatedState.phase,
    active_role: updatedState.active_role,
    next_step: transition.rotate
      ? `Provide lock_token to ${updatedState.active_role}`
      : "No phase change"
  };
}
