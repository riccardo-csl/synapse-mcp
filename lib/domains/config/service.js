import { brokerError } from "../../core/errors.js";
import { ensureStorage } from "../../storage/bootstrap.js";
import { atomicWriteJson, readJsonIfExists } from "../../storage/files.js";
import { pathsFor } from "../../storage/paths.js";
import { DEFAULT_CONFIG } from "./model.js";

export async function loadConfig(baseDir) {
  await ensureStorage(baseDir);
  const paths = pathsFor(baseDir);
  const config = await readJsonIfExists(paths.configPath);
  if (config) {
    return config;
  }
  await atomicWriteJson(paths.configPath, DEFAULT_CONFIG);
  return DEFAULT_CONFIG;
}

export function ensureAuthConfig(config) {
  const geminiPsk = config?.agents?.gemini?.psk;
  const codexPsk = config?.agents?.codex?.psk;
  if (typeof geminiPsk !== "string" || geminiPsk.trim() === "") {
    throw brokerError("CONFIG_INVALID", "Missing config.agents.gemini.psk");
  }
  if (typeof codexPsk !== "string" || codexPsk.trim() === "") {
    throw brokerError("CONFIG_INVALID", "Missing config.agents.codex.psk");
  }
}
