import * as path from "node:path";
import { ensureDir } from "../../storage/files.js";
import { DEFAULT_STORAGE_DIR } from "./constants.js";

export interface SynapsePaths {
  rootDir: string;
  cyclesDir: string;
  locksDir: string;
  configPath: string;
}

export function synapsePaths(repoRoot: string, storageDir = DEFAULT_STORAGE_DIR): SynapsePaths {
  const rootDir = path.join(repoRoot, storageDir);
  return {
    rootDir,
    cyclesDir: path.join(rootDir, "cycles"),
    locksDir: path.join(rootDir, "locks"),
    configPath: path.join(rootDir, "config.json")
  };
}

export async function ensureSynapseStore(repoRoot: string, storageDir = DEFAULT_STORAGE_DIR): Promise<SynapsePaths> {
  const paths = synapsePaths(repoRoot, storageDir);
  await ensureDir(paths.rootDir);
  await ensureDir(paths.cyclesDir);
  await ensureDir(paths.locksDir);
  return paths;
}
