import { ROLE_CODEX, ROLE_GEMINI } from "./constants.js";
import { brokerError } from "./errors.js";

export function ensureString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw brokerError("SCHEMA_INVALID", `${label} must be a non-empty string`, { label });
  }
}

export function ensureArray(value, label) {
  if (!Array.isArray(value)) {
    throw brokerError("SCHEMA_INVALID", `${label} must be an array`, { label });
  }
}

export function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function ensureValidRole(role) {
  if (role !== ROLE_CODEX && role !== ROLE_GEMINI) {
    throw brokerError("INVALID_ROLE", "role must be codex or gemini", { role });
  }
}
