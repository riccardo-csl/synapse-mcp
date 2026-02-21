import * as path from "node:path";
import {
  PHASE_COMPLETE,
  PHASE_FRONTEND,
  PHASE_FRONTEND_REFINE,
  ROLE_GEMINI
} from "../../core/constants.js";
import { brokerError } from "../../core/errors.js";
import { ensureActiveCycle } from "../../core/guards.js";
import { randomToken, slugifyFeature } from "../../core/ids.js";
import { nowIso, timestampId } from "../../core/time.js";
import {
  atomicWriteJson,
  readJson,
  readJsonIfExists,
  safeUnlink,
  statMtimeIso
} from "../../storage/files.js";
import { pathsFor } from "../../storage/paths.js";
import { loadLock, loadState } from "../../storage/state-store.js";
import { ensureAuthConfig, loadConfig } from "../config/service.js";
import { ensureLock } from "../lock/service.js";
import { unlockedState } from "../lock/model.js";
import { validateSession } from "../session/service.js";
import { idleState } from "./model.js";

export async function cycleStart({ feature, mode }, baseDir) {
  const config = await loadConfig(baseDir);
  ensureAuthConfig(config);

  if (typeof feature !== "string" || feature.trim() === "") {
    throw brokerError("SCHEMA_INVALID", "feature must be a non-empty string", { label: "feature" });
  }

  const paths = pathsFor(baseDir);
  const state = await loadState(paths, config, idleState);
  if (state.active === true) {
    throw brokerError("CYCLE_ALREADY_ACTIVE", "Active cycle exists. Archive or complete before starting a new cycle.");
  }

  const slug = slugifyFeature(feature);
  if (!slug) {
    throw brokerError("SCHEMA_INVALID", "feature is invalid after slugify");
  }

  const createdAt = nowIso();
  const cycleId = `${timestampId()}_${slug}`;
  const lockToken = randomToken();

  const newState = {
    active: true,
    cycle_id: cycleId,
    feature: feature.trim(),
    phase: PHASE_FRONTEND,
    active_role: ROLE_GEMINI,
    mode: mode || config.mode,
    created_at: createdAt,
    updated_at: createdAt,
    handoff_status: {
      codex: "empty",
      gemini: "empty"
    }
  };

  const newLock = {
    locked: true,
    role: ROLE_GEMINI,
    lock_token: lockToken,
    cycle_id: cycleId,
    acquired_at: createdAt,
    expires_at: null
  };

  await atomicWriteJson(paths.statePath, newState);
  await atomicWriteJson(paths.lockPath, newLock);
  await safeUnlink(paths.handoffCodex);
  await safeUnlink(paths.handoffGemini);

  return {
    cycle_id: cycleId,
    phase: PHASE_FRONTEND,
    active_role: ROLE_GEMINI,
    lock_token: lockToken
  };
}

export async function cycleStatus(baseDir) {
  const config = await loadConfig(baseDir);
  const paths = pathsFor(baseDir);
  const state = await loadState(paths, config, idleState);
  const lock = await loadLock(paths, unlockedState);
  const codexUpdated = await statMtimeIso(paths.handoffCodex);
  const geminiUpdated = await statMtimeIso(paths.handoffGemini);

  return {
    cycle_id: state.cycle_id,
    feature: state.feature,
    phase: state.phase,
    active_role: state.active_role,
    mode: state.mode,
    handoffs: {
      codex: {
        status: codexUpdated ? "present" : "empty",
        updated_at: codexUpdated
      },
      gemini: {
        status: geminiUpdated ? "present" : "empty",
        updated_at: geminiUpdated
      }
    },
    lock: {
      locked: lock.locked,
      role: lock.role
    }
  };
}

export async function cycleComplete({ lock_token, session_token }, baseDir) {
  const config = await loadConfig(baseDir);
  ensureAuthConfig(config);
  const paths = pathsFor(baseDir);
  const state = await loadState(paths, config, idleState);
  const lock = await loadLock(paths, unlockedState);
  const sessionRole = await validateSession(paths, session_token);
  ensureActiveCycle(state);

  if (state.phase !== PHASE_FRONTEND_REFINE) {
    throw brokerError("INVALID_PHASE", "cycle.complete is only allowed in frontend_refine phase", {
      phase: state.phase
    });
  }
  if (lock.role !== ROLE_GEMINI) {
    throw brokerError("LOCK_DENIED", "lock role must be gemini", {
      lockRole: lock.role
    });
  }
  if (sessionRole !== ROLE_GEMINI) {
    throw brokerError("LOCK_DENIED", "session role must be gemini");
  }
  ensureLock(lock, lock_token);

  const now = nowIso();
  const updatedState = {
    ...state,
    phase: PHASE_COMPLETE,
    active_role: ROLE_GEMINI,
    updated_at: now
  };
  const updatedLock = {
    ...lock,
    locked: true,
    role: ROLE_GEMINI
  };

  await atomicWriteJson(paths.statePath, updatedState);
  await atomicWriteJson(paths.lockPath, updatedLock);

  return {
    ok: true,
    phase: updatedState.phase,
    active_role: updatedState.active_role
  };
}

export async function cycleArchive({ lock_token, session_token }, baseDir) {
  const config = await loadConfig(baseDir);
  ensureAuthConfig(config);
  const paths = pathsFor(baseDir);
  const state = await loadState(paths, config, idleState);
  const lock = await loadLock(paths, unlockedState);
  const sessionRole = await validateSession(paths, session_token);

  if (state.phase !== PHASE_COMPLETE) {
    throw brokerError("ARCHIVE_NOT_ALLOWED", "cycle.archive is only allowed when phase=complete", {
      phase: state.phase
    });
  }
  if (lock.role !== ROLE_GEMINI || !lock.locked) {
    throw brokerError("LOCK_DENIED", "lock must be held by gemini for archive", {
      lockRole: lock.role,
      locked: lock.locked
    });
  }
  if (sessionRole !== ROLE_GEMINI) {
    throw brokerError("LOCK_DENIED", "session role must be gemini");
  }
  ensureLock(lock, lock_token);

  const archivePath = path.join(paths.archiveDir, state.cycle_id);
  const configData = await readJson(paths.configPath);
  const stateData = await readJson(paths.statePath);
  const lockData = await readJson(paths.lockPath);
  const codexPayload = await readJsonIfExists(paths.handoffCodex);
  const geminiPayload = await readJsonIfExists(paths.handoffGemini);

  await atomicWriteJson(path.join(archivePath, "config.json"), configData);
  await atomicWriteJson(path.join(archivePath, "state.json"), stateData);
  await atomicWriteJson(path.join(archivePath, "lock.json"), lockData);
  if (codexPayload) {
    await atomicWriteJson(path.join(archivePath, "handoff.codex.json"), codexPayload);
  }
  if (geminiPayload) {
    await atomicWriteJson(path.join(archivePath, "handoff.gemini.json"), geminiPayload);
  }

  const archivedAt = nowIso();
  await atomicWriteJson(path.join(archivePath, "manifest.json"), {
    cycle_id: state.cycle_id,
    feature: state.feature,
    created_at: state.created_at,
    completed_at: state.updated_at,
    archived_at: archivedAt
  });

  await safeUnlink(paths.handoffCodex);
  await safeUnlink(paths.handoffGemini);

  const resetState = idleState(config, archivedAt);
  const resetLock = unlockedState();
  await atomicWriteJson(paths.statePath, resetState);
  await atomicWriteJson(paths.lockPath, resetLock);

  return {
    ok: true,
    archived_at: archivedAt,
    cycle_id: state.cycle_id
  };
}
