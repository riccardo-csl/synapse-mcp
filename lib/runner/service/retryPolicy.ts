export const RETRY_BACKOFF_MS = 250;

export function toErrorShape(err: any): { code: string; message: string; details: Record<string, unknown> } {
  return {
    code: err?.code || "PHASE_FAILED",
    message: err?.message || "Unknown phase failure",
    details: err?.details || {}
  };
}

export function isRetryableError(code: string): boolean {
  switch (code) {
    case "PHASE_TIMEOUT":
    case "LOCK_HELD":
    case "CHECK_FAILED":
    case "ADAPTER_FAILED":
      return true;
    case "SCHEMA_INVALID":
    case "ADAPTER_OUTPUT_PARSE_FAILED":
    case "ADAPTER_OUTPUT_INVALID":
    case "ADAPTER_CAPACITY_EXHAUSTED":
    case "PATCH_INVALID":
    case "PATCH_APPLY_FAILED":
    case "REPO_BOUNDARY":
    case "COMMAND_BLOCKED":
    case "CONFIG_INVALID":
    case "CYCLE_CORRUPT":
      return false;
    default:
      return true;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
