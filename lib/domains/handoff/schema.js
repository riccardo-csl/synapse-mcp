import { ROLE_CODEX, ROLE_GEMINI } from "../../core/constants.js";
import { brokerError } from "../../core/errors.js";
import { ensureArray, ensureString, isObject } from "../../core/validators.js";

export function expectedActors(target) {
  if (target === ROLE_CODEX) {
    return { producer: ROLE_GEMINI, consumer: ROLE_CODEX };
  }
  if (target === ROLE_GEMINI) {
    return { producer: ROLE_CODEX, consumer: ROLE_GEMINI };
  }
  throw brokerError("INVALID_TARGET", `Invalid target: ${target}`, { target });
}

function validateEndpoints(endpoints) {
  ensureArray(endpoints, "endpoints");
  for (const entry of endpoints) {
    if (!isObject(entry)) {
      throw brokerError("SCHEMA_INVALID", "endpoints entries must be objects");
    }
    ensureString(entry.method, "endpoints.method");
    ensureString(entry.path, "endpoints.path");
  }
}

export function validatePayload(payload, target, state) {
  if (!isObject(payload)) {
    throw brokerError("SCHEMA_INVALID", "payload must be an object");
  }
  ensureString(payload.feature, "feature");
  ensureString(payload.cycle_id, "cycle_id");
  if (payload.feature !== state.feature) {
    throw brokerError("SCHEMA_INVALID", "payload.feature does not match current feature");
  }
  if (payload.cycle_id !== state.cycle_id) {
    throw brokerError("SCHEMA_INVALID", "payload.cycle_id does not match current cycle_id");
  }

  const actors = expectedActors(target);
  if (payload.producer !== actors.producer) {
    throw brokerError("SCHEMA_INVALID", "payload.producer does not match target");
  }
  if (payload.consumer !== actors.consumer) {
    throw brokerError("SCHEMA_INVALID", "payload.consumer does not match target");
  }

  ensureArray(payload.files_modified, "files_modified");
  ensureArray(payload.assumptions, "assumptions");
  ensureArray(payload.todos, "todos");
  ensureArray(payload.notes, "notes");
  ensureArray(payload.data_shapes, "data_shapes");
  validateEndpoints(payload.endpoints);

  if (payload.extras && !isObject(payload.extras)) {
    throw brokerError("SCHEMA_INVALID", "extras must be an object if provided");
  }
}
