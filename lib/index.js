import { DEFAULT_STORAGE } from "./core/constants.js";
import { ensureStorage as ensureStorageInternal } from "./storage/bootstrap.js";
import { toolDefinitions } from "./mcp/tools.js";
import { cycleArchive, cycleComplete, cycleStart, cycleStatus } from "./domains/cycle/service.js";
import { handoffRead, handoffWrite } from "./domains/handoff/service.js";
import { lockAcquire } from "./domains/lock/service.js";
import { loadConfig as loadConfigInternal } from "./domains/config/service.js";
import { sessionOpen } from "./domains/session/service.js";

export { toolDefinitions };

export async function ensureStorage(baseDir = DEFAULT_STORAGE) {
  return ensureStorageInternal(baseDir);
}

export async function loadConfig(baseDir = DEFAULT_STORAGE) {
  return loadConfigInternal(baseDir);
}

export async function cycleStartEntry(args, baseDir = DEFAULT_STORAGE) {
  return cycleStart(args, baseDir);
}

export async function cycleStatusEntry(baseDir = DEFAULT_STORAGE) {
  return cycleStatus(baseDir);
}

export async function handoffReadEntry(args, baseDir = DEFAULT_STORAGE) {
  return handoffRead(args, baseDir);
}

export async function sessionOpenEntry(args, baseDir = DEFAULT_STORAGE) {
  return sessionOpen(args, baseDir);
}

export async function lockAcquireEntry(args, baseDir = DEFAULT_STORAGE) {
  return lockAcquire(args, baseDir);
}

export async function handoffWriteEntry(args, baseDir = DEFAULT_STORAGE) {
  return handoffWrite(args, baseDir);
}

export async function cycleCompleteEntry(args, baseDir = DEFAULT_STORAGE) {
  return cycleComplete(args, baseDir);
}

export async function cycleArchiveEntry(args, baseDir = DEFAULT_STORAGE) {
  return cycleArchive(args, baseDir);
}

// Backward-compatible named exports used by existing callers.
export {
  cycleStartEntry as cycleStart,
  cycleStatusEntry as cycleStatus,
  handoffReadEntry as handoffRead,
  sessionOpenEntry as sessionOpen,
  lockAcquireEntry as lockAcquire,
  handoffWriteEntry as handoffWrite,
  cycleCompleteEntry as cycleComplete,
  cycleArchiveEntry as cycleArchive
};
