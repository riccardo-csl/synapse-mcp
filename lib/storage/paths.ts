import * as path from "node:path";

export function pathsFor(baseDir) {
  return {
    baseDir,
    configPath: path.join(baseDir, "config.json"),
    statePath: path.join(baseDir, "state.json"),
    lockPath: path.join(baseDir, "lock.json"),
    sessionsPath: path.join(baseDir, "sessions.json"),
    handoffDir: path.join(baseDir, "handoff"),
    handoffCodex: path.join(baseDir, "handoff", "codex.json"),
    handoffGemini: path.join(baseDir, "handoff", "gemini.json"),
    archiveDir: path.join(baseDir, "archive")
  };
}
