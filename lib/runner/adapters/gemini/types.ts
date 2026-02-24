import type { z } from "zod";
import { geminiAdapterOutputSchema } from "../../../synapse/schemas.js";

export type GeminiStructuredOutput = z.infer<typeof geminiAdapterOutputSchema>;

export type ParseSource = "block_marker" | "line_marker" | "json_scan";

export interface GeminiParseResult {
  payload: GeminiStructuredOutput;
  parseSource: ParseSource;
}

export interface GeminiCommandAttempt {
  command: string;
  stdout: string;
  stderr: string;
}

export interface GeminiWorkerContextMetrics {
  suggested_start_files_count: number;
  seed_file_snippets_count: number;
  worker_memory_hints_used: number;
  repo_index_suggestions_used: number;
}

export interface GeminiOutputHooks {
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
  onWorkerContext?: (meta: GeminiWorkerContextMetrics) => void | Promise<void>;
}
