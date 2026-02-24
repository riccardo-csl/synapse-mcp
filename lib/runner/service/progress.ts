const DEFAULT_PHASE_PROGRESS_LOG_MS = 15_000;

export function phaseProgressLogIntervalMs(): number {
  const raw = Number(process.env.SYNAPSE_PHASE_PROGRESS_LOG_MS || DEFAULT_PHASE_PROGRESS_LOG_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_PHASE_PROGRESS_LOG_MS;
  }
  return Math.floor(raw);
}

export function durationMs(startedAt: string | null, fallbackStartMs: number): number {
  if (!startedAt) {
    return Math.max(0, Date.now() - fallbackStartMs);
  }
  const parsed = Date.parse(startedAt);
  if (!Number.isFinite(parsed)) {
    return Math.max(0, Date.now() - fallbackStartMs);
  }
  return Math.max(0, Date.now() - parsed);
}
