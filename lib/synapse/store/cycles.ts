import * as path from "node:path";
import { promises as fs } from "node:fs";
import { atomicWriteJson, readJson, readJsonIfExists } from "../../storage/files.js";
import { synapseError } from "../errors.js";
import { cycleSpecSchema, parseOrSchemaError } from "../schemas.js";
import type { CycleSpec, CycleStatus } from "../types.js";
import { DEFAULT_STORAGE_DIR } from "./constants.js";
import { parseCycleOrThrow } from "./parsers.js";
import { ensureSynapseStore } from "./paths.js";

export async function writeCycle(repoRoot: string, cycle: CycleSpec, storageDir = DEFAULT_STORAGE_DIR): Promise<void> {
  const paths = await ensureSynapseStore(repoRoot, storageDir);
  const validated = parseOrSchemaError(cycleSpecSchema, cycle, `Refusing to write invalid cycle ${cycle.id}`) as CycleSpec;
  const filePath = path.join(paths.cyclesDir, `${validated.id}.json`);
  await atomicWriteJson(filePath, validated);
}

export async function readCycle(repoRoot: string, cycleId: string, storageDir = DEFAULT_STORAGE_DIR): Promise<CycleSpec> {
  const paths = await ensureSynapseStore(repoRoot, storageDir);
  const filePath = path.join(paths.cyclesDir, `${cycleId}.json`);
  let cycle: unknown;
  try {
    cycle = await readJsonIfExists(filePath);
  } catch (err: any) {
    throw synapseError("CYCLE_CORRUPT", `Cycle file is malformed JSON: ${cycleId}`, {
      cycle_id: cycleId,
      error: err?.message || String(err)
    });
  }
  if (!cycle) {
    throw synapseError("CYCLE_NOT_FOUND", `cycle not found: ${cycleId}`, { cycle_id: cycleId });
  }
  return parseCycleOrThrow(cycle, cycleId);
}

export async function listCycles(
  repoRoot: string,
  {
    limit,
    status,
    storageDir = DEFAULT_STORAGE_DIR
  }: { limit?: number; status?: CycleStatus; storageDir?: string } = {}
): Promise<CycleSpec[]> {
  const paths = await ensureSynapseStore(repoRoot, storageDir);
  const entries = await fs.readdir(paths.cyclesDir);
  const cycles: CycleSpec[] = [];

  for (const name of entries) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(paths.cyclesDir, name);
    let raw: unknown;
    try {
      raw = await readJson(filePath);
    } catch (err: any) {
      throw synapseError("CYCLE_CORRUPT", `Cycle file is malformed JSON: ${name}`, {
        cycle_id: name.replace(/\.json$/, ""),
        error: err?.message || String(err)
      });
    }
    const cycle = parseCycleOrThrow(raw, name.replace(/\.json$/, ""));
    if (status && cycle.status !== status) {
      continue;
    }
    cycles.push(cycle);
  }

  cycles.sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (typeof limit === "number" && limit > 0) {
    return cycles.slice(0, limit);
  }
  return cycles;
}
