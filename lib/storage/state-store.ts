import { nowIso } from "../core/time.js";
import { atomicWriteJson, readJsonIfExists } from "./files.js";

export async function loadState(paths, config, idleStateFactory) {
  const state = await readJsonIfExists(paths.statePath);
  if (state) {
    if (typeof state.active === "boolean") {
      return state;
    }
    const normalizedState = {
      ...state,
      active: Boolean(state.cycle_id && state.phase)
    };
    await atomicWriteJson(paths.statePath, normalizedState);
    return normalizedState;
  }
  const idle = idleStateFactory(config, nowIso());
  await atomicWriteJson(paths.statePath, idle);
  return idle;
}

export async function loadLock(paths, unlockedStateFactory) {
  const lock = await readJsonIfExists(paths.lockPath);
  if (lock) {
    return lock;
  }
  const unlocked = unlockedStateFactory();
  await atomicWriteJson(paths.lockPath, unlocked);
  return unlocked;
}

export async function loadSessions(paths, emptySessionsFactory) {
  const sessions = await readJsonIfExists(paths.sessionsPath);
  if (sessions && sessions.sessions && typeof sessions.sessions === "object") {
    return sessions;
  }
  const next = emptySessionsFactory();
  await atomicWriteJson(paths.sessionsPath, next);
  return next;
}
