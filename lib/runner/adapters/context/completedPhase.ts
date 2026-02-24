import type { CycleSpec, PhaseSpec } from "../../../synapse/types.js";
import type { CompletedPhaseContext } from "./types.js";
import { asRecord, asString, asStringArray, truncate, uniq } from "./utils.js";

function phaseIndex(cycle: CycleSpec, phase: PhaseSpec): number {
  return cycle.phases.findIndex((p) => p.id === phase.id);
}

function extractCompletedPhaseContext(phase: PhaseSpec): CompletedPhaseContext {
  const output = asRecord(phase.output);
  const report = asRecord(output?.report);
  const summary = asString(report?.summary) || asString(report?.message);
  const filesModified = asStringArray(report?.files_modified).slice(0, 20);
  const changedFiles = asStringArray(output?.changed_files).slice(0, 20);
  const frontendTweakRequired = typeof output?.frontend_tweak_required === "boolean"
    ? output.frontend_tweak_required
    : undefined;

  return {
    id: phase.id,
    type: phase.type,
    completed_at: phase.finished_at,
    ...(summary ? { summary: truncate(summary, 300) } : {}),
    ...(filesModified.length ? { files_modified: filesModified } : {}),
    ...(changedFiles.length ? { changed_files: changedFiles } : {}),
    ...(typeof frontendTweakRequired === "boolean" ? { frontend_tweak_required: frontendTweakRequired } : {})
  };
}

export function recentCompletedPhases(cycle: CycleSpec, phase: PhaseSpec): CompletedPhaseContext[] {
  const idx = phaseIndex(cycle, phase);
  const candidates = cycle.phases
    .filter((p, i) => p.status === "DONE" && (idx < 0 || i < idx))
    .map(extractCompletedPhaseContext);

  return candidates.slice(-3);
}

export function suggestedStartFilesFromRecent(recent: CompletedPhaseContext[]): string[] {
  const latest = recent[recent.length - 1];
  if (!latest) {
    return [];
  }

  const fromLatest = [
    ...(latest.files_modified || []),
    ...(latest.changed_files || [])
  ];

  return uniq(fromLatest).slice(0, 12);
}
