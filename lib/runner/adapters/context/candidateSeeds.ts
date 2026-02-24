import type { CycleSpec, PhaseSpec } from "../../../synapse/types.js";
import type { WorkerMemoryFile } from "../workerMemory.js";
import type { CandidateFileSeed, CompletedPhaseContext } from "./types.js";
import { suggestedStartFilesFromRecent } from "./completedPhase.js";
import { sanitizeRelPath, truncate } from "./utils.js";

export function collectCandidateFileSeeds(
  cycle: CycleSpec,
  phase: PhaseSpec,
  recentCompleted: CompletedPhaseContext[],
  retry?: Record<string, unknown>,
  workerMemory?: WorkerMemoryFile | null,
  repoIndexSuggestions: Array<{ path: string; score: number; matched_tokens: string[] }> = []
): CandidateFileSeed[] {
  const out: CandidateFileSeed[] = [];
  const seen = new Set<string>();

  const push = (filePath: string, source: string, reason?: string, matched_tokens?: string[]) => {
    const sanitized = sanitizeRelPath(cycle.repo_root, filePath);
    if (!sanitized || seen.has(sanitized)) {
      return;
    }
    seen.add(sanitized);
    out.push({
      path: sanitized,
      source,
      ...(reason ? { reason: truncate(reason, 140) } : {}),
      ...(matched_tokens?.length ? { matched_tokens: matched_tokens.slice(0, 6) } : {})
    });
  };

  for (const file of suggestedStartFilesFromRecent(recentCompleted)) {
    push(file, "recent_completed_phase", "Suggested from latest completed phase outputs");
  }

  const retryCandidates = retry && Array.isArray((retry as any).candidate_files)
    ? ((retry as any).candidate_files as unknown[])
    : [];
  for (const file of retryCandidates) {
    if (typeof file === "string") {
      push(file, "retry_context", "Seen in previous attempt error/output context");
    }
  }

  if (workerMemory) {
    for (const hint of workerMemory.file_hints || []) {
      push(hint.path, "worker_memory", hint.reason || `Remembered from previous ${phase.type} attempts`);
      if (out.length >= 12) {
        break;
      }
    }
  }

  for (const suggestion of repoIndexSuggestions) {
    push(
      suggestion.path,
      "repo_index",
      `Matched request/context tokens in repo index (score=${suggestion.score})`,
      suggestion.matched_tokens
    );
    if (out.length >= 12) {
      break;
    }
  }

  return out.slice(0, 12);
}
