import type { GeminiWorkerContextMetrics } from "./types.js";

export function parseWorkerContextMetricsFromBlock(block: string): GeminiWorkerContextMetrics {
  const begin = "SYNAPSE_PHASE_CONTEXT_BEGIN";
  const end = "SYNAPSE_PHASE_CONTEXT_END";
  const beginIdx = block.indexOf(begin);
  const endIdx = block.indexOf(end);
  if (beginIdx < 0 || endIdx < 0 || endIdx <= beginIdx) {
    return {
      suggested_start_files_count: 0,
      seed_file_snippets_count: 0,
      worker_memory_hints_used: 0,
      repo_index_suggestions_used: 0
    };
  }

  try {
    const raw = block.slice(beginIdx + begin.length, endIdx).trim();
    const parsed = JSON.parse(raw) as any;
    return {
      suggested_start_files_count: Array.isArray(parsed?.suggested_start_files) ? parsed.suggested_start_files.length : 0,
      seed_file_snippets_count: Array.isArray(parsed?.seed_file_snippets) ? parsed.seed_file_snippets.length : 0,
      worker_memory_hints_used: Array.isArray(parsed?.worker_memory?.file_hints) ? parsed.worker_memory.file_hints.length : 0,
      repo_index_suggestions_used: Array.isArray(parsed?.repo_index_suggestions) ? parsed.repo_index_suggestions.length : 0
    };
  } catch {
    return {
      suggested_start_files_count: 0,
      seed_file_snippets_count: 0,
      worker_memory_hints_used: 0,
      repo_index_suggestions_used: 0
    };
  }
}
