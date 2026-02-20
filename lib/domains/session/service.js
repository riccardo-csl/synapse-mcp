import { ensureValidRole, ensureString } from "../../core/validators.js";
import { randomSessionToken } from "../../core/ids.js";
import { nowIso } from "../../core/time.js";
import { brokerError } from "../../core/errors.js";
import { atomicWriteJson } from "../../storage/files.js";
import { pathsFor } from "../../storage/paths.js";
import { loadSessions } from "../../storage/state-store.js";
import { emptySessions } from "./model.js";
import { ensureAuthConfig, loadConfig } from "../config/service.js";

export async function sessionOpen({ role, psk }, baseDir) {
  ensureValidRole(role);
  ensureString(psk, "psk");

  const config = await loadConfig(baseDir);
  ensureAuthConfig(config);
  const paths = pathsFor(baseDir);
  const sessions = await loadSessions(paths, emptySessions);

  const expectedPsk = config.agents[role].psk;
  if (psk !== expectedPsk) {
    throw brokerError("AUTH_FAILED", "Invalid role credentials.", { role });
  }

  const createdAt = nowIso();
  const sessionToken = randomSessionToken();
  const next = {
    ...sessions,
    sessions: {
      ...sessions.sessions,
      [sessionToken]: {
        role,
        created_at: createdAt,
        last_seen: createdAt
      }
    }
  };
  await atomicWriteJson(paths.sessionsPath, next);

  return {
    session_token: sessionToken,
    role
  };
}

export async function validateSession(paths, sessionToken) {
  if (typeof sessionToken !== "string" || sessionToken.trim() === "") {
    throw brokerError("INVALID_SESSION", "Invalid session_token.");
  }
  const sessions = await loadSessions(paths, emptySessions);
  const record = sessions.sessions[sessionToken];
  if (!record || !record.role) {
    throw brokerError("INVALID_SESSION", "Invalid session_token.");
  }
  ensureValidRole(record.role);

  const next = {
    ...sessions,
    sessions: {
      ...sessions.sessions,
      [sessionToken]: {
        ...record,
        last_seen: nowIso()
      }
    }
  };
  await atomicWriteJson(paths.sessionsPath, next);
  return record.role;
}
