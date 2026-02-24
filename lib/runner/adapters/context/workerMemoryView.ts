import type { WorkerMemoryFile } from "../workerMemory.js";

export function summarizeWorkerMemory(memory: WorkerMemoryFile | null): Record<string, unknown> | null {
  if (!memory) {
    return null;
  }
  return {
    updated_at: memory.updated_at,
    file_hints: (memory.file_hints || []).slice(0, 12).map((hint) => ({
      path: hint.path,
      source: hint.source,
      ...(hint.reason ? { reason: hint.reason } : {})
    })),
    recent_attempts: (memory.phase_attempts || []).slice(-5).map((attempt) => ({
      phase_id: attempt.phase_id,
      phase_type: attempt.phase_type,
      attempt: attempt.attempt,
      outcome: attempt.outcome,
      ...(attempt.error_code ? { error_code: attempt.error_code } : {}),
      ...(attempt.report_summary ? { report_summary: attempt.report_summary } : {}),
      ...(attempt.candidate_files?.length ? { candidate_files: attempt.candidate_files.slice(0, 8) } : {})
    }))
  };
}
