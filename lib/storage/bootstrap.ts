import * as path from "node:path";
import { ensureDir } from "./files.js";

export async function ensureStorage(baseDir) {
  await ensureDir(baseDir);
  await ensureDir(path.join(baseDir, "handoff"));
  await ensureDir(path.join(baseDir, "archive"));
}
