import type { PhaseExecutionResult } from "../../synapse/types.js";

function uniq(items: string[]): string[] {
  return Array.from(new Set(items));
}

function reportFilesModified(report: Record<string, unknown> | undefined): string[] {
  const raw = report && Array.isArray((report as any).files_modified)
    ? (report as any).files_modified
    : null;
  if (!raw) {
    return [];
  }
  return uniq(raw.filter((item: unknown) => typeof item === "string" && item.trim()).map((item: string) => item.trim()));
}

export function phaseChangedFilesForArtifacts(
  beforeChanged: string[],
  afterChanged: string[],
  execResult: PhaseExecutionResult
): string[] {
  const fromReport = reportFilesModified(execResult.report);
  if (fromReport.length > 0) {
    return fromReport;
  }
  const before = new Set(beforeChanged);
  return uniq(afterChanged.filter((file) => !before.has(file)));
}

export function uniqStrings(items: string[]): string[] {
  return uniq(items);
}
