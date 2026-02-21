import os from "os";
import path from "path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";

export const GEMINI_PSK = "GEMINI_SECRET";
export const CODEX_PSK = "CODEX_SECRET";

export async function createSandbox(prefix = "mcp-broker-test-") {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function cleanupSandbox(baseDir) {
  if (!baseDir) {
    return;
  }
  await rm(baseDir, { recursive: true, force: true });
}

export async function writeConfig(
  baseDir,
  {
    geminiPsk = GEMINI_PSK,
    codexPsk = CODEX_PSK
  } = {}
) {
  await mkdir(baseDir, { recursive: true });
  const config = {
    version: "0.1",
    mode: "approval",
    validation: "basic",
    storage_path: baseDir,
    agents: {
      gemini: { psk: geminiPsk },
      codex: { psk: codexPsk }
    }
  };
  await writeFile(path.join(baseDir, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
}

export async function readLockFile(baseDir) {
  const raw = await readFile(path.join(baseDir, "lock.json"), "utf8");
  return JSON.parse(raw);
}

export function geminiPayload(cycleId, feature = "featureX") {
  return {
    cycle_id: cycleId,
    feature,
    producer: "gemini",
    consumer: "codex",
    files_modified: ["web/components/FeatureX.tsx"],
    endpoints: [{ method: "GET", path: "/api/feature-x" }],
    data_shapes: [],
    assumptions: [],
    todos: [],
    notes: [],
    extras: {}
  };
}

export function codexPayload(cycleId, feature = "featureX") {
  return {
    cycle_id: cycleId,
    feature,
    producer: "codex",
    consumer: "gemini",
    files_modified: ["api/feature-x.ts"],
    endpoints: [{ method: "GET", path: "/api/feature-x" }],
    data_shapes: [],
    assumptions: [],
    todos: [],
    notes: [],
    extras: {}
  };
}
