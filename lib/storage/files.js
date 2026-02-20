import path from "path";
import { promises as fs } from "fs";

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
}

export async function readJsonIfExists(filePath) {
  if (!(await fileExists(filePath))) {
    return null;
  }
  return readJson(filePath);
}

export async function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const json = JSON.stringify(data, null, 2) + "\n";
  await fs.writeFile(tmpPath, json, "utf8");
  await fs.rename(tmpPath, filePath);
}

export async function safeUnlink(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
}

export async function statMtimeIso(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.mtime.toISOString();
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}
