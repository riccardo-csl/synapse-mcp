import { synapseError } from "../errors.js";
import type { CycleLockState, CycleSpec } from "../types.js";
import { cycleLockSchema, cycleSpecSchema, parseOrSchemaError } from "../schemas.js";
import { CURRENT_SCHEMA_VERSION } from "./constants.js";

export function parseCycleOrThrow(raw: unknown, cycleId: string): CycleSpec {
  const version = (raw && typeof raw === "object" && typeof (raw as any).schema_version === "number")
    ? (raw as any).schema_version
    : 1;
  if (version > CURRENT_SCHEMA_VERSION) {
    throw synapseError("UNSUPPORTED_VERSION", `Cycle schema version ${version} is not supported`, {
      cycle_id: cycleId,
      schema_version: version,
      supported_schema_version: CURRENT_SCHEMA_VERSION
    });
  }

  try {
    return parseOrSchemaError(cycleSpecSchema, raw, `Invalid cycle JSON for ${cycleId}`) as CycleSpec;
  } catch (err: any) {
    if (err?.code === "SCHEMA_INVALID") {
      throw synapseError("CYCLE_CORRUPT", `Cycle file is invalid: ${cycleId}`, {
        cycle_id: cycleId,
        issues: err?.details?.issues || []
      });
    }
    throw err;
  }
}

export function parseLockOrThrow(raw: unknown, cycleId: string): CycleLockState {
  const schemaVersion = (raw && typeof raw === "object" && typeof (raw as any).schema_version === "number")
    ? (raw as any).schema_version
    : 1;
  const lockVersion = (raw && typeof raw === "object" && typeof (raw as any).lock_version === "number")
    ? (raw as any).lock_version
    : 1;
  if (schemaVersion > CURRENT_SCHEMA_VERSION || lockVersion > 1) {
    throw synapseError("UNSUPPORTED_VERSION", `Lock schema version is not supported for cycle ${cycleId}`, {
      cycle_id: cycleId,
      schema_version: schemaVersion,
      lock_version: lockVersion,
      supported_schema_version: CURRENT_SCHEMA_VERSION,
      supported_lock_version: 1
    });
  }

  try {
    return parseOrSchemaError(cycleLockSchema, raw, `Invalid lock JSON for ${cycleId}`) as CycleLockState;
  } catch (err: any) {
    if (err?.code === "SCHEMA_INVALID") {
      throw synapseError("LOCK_CORRUPT", `Lock file is invalid for cycle ${cycleId}`, {
        cycle_id: cycleId,
        issues: err?.details?.issues || []
      });
    }
    throw err;
  }
}
