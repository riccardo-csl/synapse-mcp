import * as path from "node:path";
import { ensureDir, atomicWriteJson, readJsonIfExists } from "../../storage/files.js";
import { nowIso } from "../../core/time.js";
import type { CycleSpec, PhaseExecutionResult, PhaseSpec, RunnerConfig } from "../../synapse/types.js";

export interface WorkerMemoryFile {
  schema_version: 1;
  cycle_id: string;
  updated_at: string;
  file_hints: Array<{
    path: string;
    reason?: string;
    source: string;
    last_seen_at: string;
  }>;
  phase_attempts: Array<{
    phase_id: string;
    phase_type: string;
    attempt: number;
    ts: string;
    outcome: "DONE" | "FAILED";
    error_code?: string;
    report_summary?: string;
    candidate_files?: string[];
  }>;
}

const MEMORY_SCHEMA_VERSION = 1;
const MAX_HINTS = 80;
const MAX_ATTEMPTS = 30;
const FILE_PATH_RE = /\b(?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|scss|md|yml|yaml)\b/g;

function memoryPath(repoRoot: string, storageDir: string, cycleId: string): string {
  return path.join(repoRoot, storageDir, "context", `${cycleId}.json`);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean);
}

function truncate(v: string, max = 240): string {
  return v.length <= max ? v : `${v.slice(0, max)}...`;
}

function normalizeRelPath(input: string): string | null {
  const trimmed = input.trim().replace(/^\.\//, "");
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("..")) {
    return null;
  }
  return trimmed;
}

function extractFilePathsFromText(text: string): string[] {
  if (!text) {
    return [];
  }
  const found = text.match(FILE_PATH_RE) || [];
  const out = new Set<string>();
  for (const f of found) {
    const normalized = normalizeRelPath(f);
    if (normalized) {
      out.add(normalized);
    }
  }
  return Array.from(out);
}

function extractRecentLogFileHints(cycle: CycleSpec, phaseId: string): string[] {
  const recent = cycle.logs.slice(-120);
  const files = new Set<string>();
  for (const entry of recent) {
    if (entry.phase_id !== phaseId) {
      continue;
    }
    const event = typeof entry.meta?.event === "string" ? entry.meta.event : undefined;
    if (event !== "adapter.stdout" && event !== "adapter.stderr") {
      continue;
    }
    for (const file of extractFilePathsFromText(entry.message || "")) {
      files.add(file);
    }
  }
  return Array.from(files);
}

function parseMemory(raw: unknown, cycleId: string): WorkerMemoryFile | null {
  const rec = asRecord(raw);
  if (!rec) {
    return null;
  }
  if (rec.cycle_id !== cycleId) {
    return null;
  }
  const file_hints = Array.isArray(rec.file_hints) ? rec.file_hints : [];
  const phase_attempts = Array.isArray(rec.phase_attempts) ? rec.phase_attempts : [];
  return {
    schema_version: MEMORY_SCHEMA_VERSION,
    cycle_id: cycleId,
    updated_at: typeof rec.updated_at === "string" ? rec.updated_at : nowIso(),
    file_hints: file_hints
      .map((x) => {
        const r = asRecord(x);
        if (!r) return null;
        const p = typeof r.path === "string" ? normalizeRelPath(r.path) : null;
        if (!p) return null;
        return {
          path: p,
          reason: typeof r.reason === "string" ? truncate(r.reason, 180) : undefined,
          source: typeof r.source === "string" ? r.source : "unknown",
          last_seen_at: typeof r.last_seen_at === "string" ? r.last_seen_at : nowIso()
        };
      })
      .filter(Boolean) as WorkerMemoryFile["file_hints"],
    phase_attempts: phase_attempts
      .map((x) => {
        const r = asRecord(x);
        if (!r) return null;
        if (typeof r.phase_id !== "string" || typeof r.phase_type !== "string") return null;
        return {
          phase_id: r.phase_id,
          phase_type: r.phase_type,
          attempt: typeof r.attempt === "number" ? r.attempt : 0,
          ts: typeof r.ts === "string" ? r.ts : nowIso(),
          outcome: r.outcome === "DONE" ? "DONE" : "FAILED",
          error_code: typeof r.error_code === "string" ? r.error_code : undefined,
          report_summary: typeof r.report_summary === "string" ? truncate(r.report_summary, 240) : undefined,
          candidate_files: asStrings(r.candidate_files).map((f) => normalizeRelPath(f)).filter(Boolean) as string[]
        };
      })
      .filter(Boolean) as WorkerMemoryFile["phase_attempts"]
  };
}

export async function readWorkerMemory(repoRoot: string, storageDir: string, cycleId: string): Promise<WorkerMemoryFile | null> {
  const raw = await readJsonIfExists(memoryPath(repoRoot, storageDir, cycleId));
  if (!raw) {
    return null;
  }
  return parseMemory(raw, cycleId);
}

interface UpdateWorkerMemoryInput {
  cycle: CycleSpec;
  phase: PhaseSpec;
  config: RunnerConfig;
  outcome: "DONE" | "FAILED";
  execResult?: PhaseExecutionResult;
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
  changedFiles?: string[];
}

function reportSummary(execResult?: PhaseExecutionResult): string | undefined {
  const report = (execResult?.report || {}) as Record<string, unknown>;
  const summary = typeof report.summary === "string"
    ? report.summary
    : (typeof report.message === "string" ? report.message : undefined);
  return summary ? truncate(summary, 240) : undefined;
}

function reportFiles(execResult?: PhaseExecutionResult): string[] {
  const report = (execResult?.report || {}) as Record<string, unknown>;
  const files = asStrings(report.files_modified);
  return files.map((f) => normalizeRelPath(f)).filter(Boolean) as string[];
}

function filesFromError(error?: UpdateWorkerMemoryInput["error"]): string[] {
  const details = (error?.details || {}) as Record<string, unknown>;
  const out = new Set<string>();
  for (const key of ["stdout", "stderr", "stdout_tail", "stderr_tail", "message"] as const) {
    const value = typeof details[key] === "string" ? details[key] : (key === "message" ? error?.message : undefined);
    if (!value) continue;
    for (const file of extractFilePathsFromText(value)) {
      out.add(file);
    }
  }
  return Array.from(out);
}

export async function updateWorkerMemory(input: UpdateWorkerMemoryInput): Promise<void> {
  const { cycle, phase, config, outcome, execResult, error } = input;
  const storageDir = config.storage_dir;
  const ts = nowIso();
  const existing = await readWorkerMemory(cycle.repo_root, storageDir, cycle.id);
  const memory: WorkerMemoryFile = existing || {
    schema_version: MEMORY_SCHEMA_VERSION,
    cycle_id: cycle.id,
    updated_at: ts,
    file_hints: [],
    phase_attempts: []
  };

  const candidateFiles = new Set<string>();
  for (const f of input.changedFiles || []) {
    const n = normalizeRelPath(f);
    if (n) candidateFiles.add(n);
  }
  for (const f of reportFiles(execResult)) {
    candidateFiles.add(f);
  }
  for (const f of filesFromError(error)) {
    candidateFiles.add(f);
  }
  for (const f of extractRecentLogFileHints(cycle, phase.id)) {
    candidateFiles.add(f);
  }

  const summary = reportSummary(execResult);
  const reason = summary || (error?.message ? truncate(error.message, 180) : undefined) || `${phase.type} phase context`;
  const source = outcome === "DONE" ? "phase_result" : "phase_error";

  const byPath = new Map(memory.file_hints.map((h) => [h.path, h] as const));
  for (const file of candidateFiles) {
    byPath.set(file, {
      path: file,
      reason,
      source,
      last_seen_at: ts
    });
  }
  memory.file_hints = Array.from(byPath.values())
    .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at))
    .slice(0, MAX_HINTS);

  memory.phase_attempts.push({
    phase_id: phase.id,
    phase_type: phase.type,
    attempt: phase.attempt_count,
    ts,
    outcome,
    ...(error?.code ? { error_code: error.code } : {}),
    ...(summary ? { report_summary: summary } : {}),
    ...(candidateFiles.size ? { candidate_files: Array.from(candidateFiles).slice(0, 20) } : {})
  });
  memory.phase_attempts = memory.phase_attempts.slice(-MAX_ATTEMPTS);
  memory.updated_at = ts;

  const filePath = memoryPath(cycle.repo_root, storageDir, cycle.id);
  await ensureDir(path.dirname(filePath));
  await atomicWriteJson(filePath, memory);
}
