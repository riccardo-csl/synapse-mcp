import type { CycleSpec, PhaseSpec } from "../../../synapse/types.js";
import { extractPathsFromText } from "./extractPaths.js";
import { asRecord, asString, asStringArray, truncate, uniq } from "./utils.js";

export function buildRetryContext(cycle: CycleSpec, phase: PhaseSpec): Record<string, unknown> | undefined {
  if (phase.attempt_count <= 1 || !cycle.last_error) {
    return undefined;
  }

  const details = asRecord(cycle.last_error.details);
  const stdoutTail = asString(details?.stdout) || asString(details?.stdout_tail);
  const stderrTail = asString(details?.stderr) || asString(details?.stderr_tail);
  const candidateFiles = uniq([
    ...asStringArray(details?.candidate_files),
    ...extractPathsFromText(stdoutTail || ""),
    ...extractPathsFromText(stderrTail || "")
  ]).slice(0, 12);

  return {
    attempt: phase.attempt_count,
    max_attempts: phase.max_attempts,
    last_error: {
      code: cycle.last_error.code,
      message: truncate(cycle.last_error.message || "", 240)
    },
    ...(candidateFiles.length ? { candidate_files: candidateFiles } : {}),
    ...(stdoutTail ? { stdout_tail: truncate(stdoutTail, 500) } : {}),
    ...(stderrTail ? { stderr_tail: truncate(stderrTail, 400) } : {})
  };
}
