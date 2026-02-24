import { atomicWriteJson, readJsonIfExists } from "../../storage/files.js";
import { synapseError } from "../errors.js";
import { parseOrSchemaError, runnerConfigSchema } from "../schemas.js";
import type { RunnerConfig } from "../types.js";
import { CURRENT_SCHEMA_VERSION, DEFAULT_STORAGE_DIR } from "./constants.js";
import { ensureSynapseStore } from "./paths.js";

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  schema_version: CURRENT_SCHEMA_VERSION,
  storage_dir: DEFAULT_STORAGE_DIR,
  checks: {
    FRONTEND: [],
    BACKEND: [],
    FRONTEND_TWEAK: []
  },
  require_changes: {
    FRONTEND: false,
    BACKEND: true,
    FRONTEND_TWEAK: false
  },
  adapters: {
    gemini: {
      mode: "stub",
      command: "gemini",
      require_marker: false,
      max_output_bytes: 1_000_000,
      max_patch_bytes: 500_000,
      max_file_ops: 100,
      max_file_op_bytes: 300_000,
      repair_retry_on_invalid_output: false,
      max_repair_attempts: 1,
      stream_output_to_runner: false,
      stream_output_to_synapse_logs: false
    },
    codexExec: {
      command: "codex exec",
      require_marker: false
    }
  },
  locks: {
    ttl_ms: 20_000,
    heartbeat_ms: 5_000,
    takeover_grace_ms: 2_000,
    pid_liveness_check: true
  },
  cancellation: {
    term_grace_ms: 1_500
  },
  denylist_substrings: ["rm -rf /", "git reset --hard", "git clean -fdx"]
};

function mergeRunnerConfig(current: unknown): RunnerConfig {
  const source = (current || {}) as Record<string, any>;
  const version = typeof source.schema_version === "number" ? source.schema_version : 1;
  if (version > CURRENT_SCHEMA_VERSION) {
    throw synapseError("UNSUPPORTED_VERSION", `Config schema version ${version} is not supported`, {
      schema_version: version,
      supported_schema_version: CURRENT_SCHEMA_VERSION
    });
  }
  const merged: RunnerConfig = {
    ...DEFAULT_RUNNER_CONFIG,
    ...source,
    checks: {
      ...DEFAULT_RUNNER_CONFIG.checks,
      ...(source.checks || {})
    },
    require_changes: {
      ...DEFAULT_RUNNER_CONFIG.require_changes,
      ...(source.require_changes || {})
    },
    adapters: {
      gemini: {
        ...DEFAULT_RUNNER_CONFIG.adapters.gemini,
        ...(source.adapters?.gemini || {})
      },
      codexExec: {
        ...DEFAULT_RUNNER_CONFIG.adapters.codexExec,
        ...(source.adapters?.codexExec || {})
      }
    },
    locks: {
      ...DEFAULT_RUNNER_CONFIG.locks,
      ...(source.locks || {})
    },
    cancellation: {
      ...DEFAULT_RUNNER_CONFIG.cancellation,
      ...(source.cancellation || {})
    },
    denylist_substrings: Array.isArray(source.denylist_substrings)
      ? source.denylist_substrings
      : DEFAULT_RUNNER_CONFIG.denylist_substrings
  };

  return parseOrSchemaError(runnerConfigSchema, merged, "Invalid .synapse/config.json") as RunnerConfig;
}

export async function loadRunnerConfig(repoRoot: string, storageDir = DEFAULT_STORAGE_DIR): Promise<RunnerConfig> {
  const paths = await ensureSynapseStore(repoRoot, storageDir);
  let current: unknown;
  try {
    current = await readJsonIfExists(paths.configPath);
  } catch (err: any) {
    throw synapseError("CONFIG_INVALID", "Invalid .synapse/config.json (malformed JSON)", {
      error: err?.message || String(err)
    });
  }
  if (!current) {
    await atomicWriteJson(paths.configPath, DEFAULT_RUNNER_CONFIG);
    return DEFAULT_RUNNER_CONFIG;
  }

  try {
    return mergeRunnerConfig(current);
  } catch (err: any) {
    if (err?.code === "SCHEMA_INVALID") {
      throw synapseError("CONFIG_INVALID", err.message, err?.details || {});
    }
    throw err;
  }
}
