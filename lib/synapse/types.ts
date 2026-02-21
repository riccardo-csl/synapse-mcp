export const CYCLE_STATUSES = ["QUEUED", "RUNNING", "DONE", "FAILED", "CANCELED"] as const;
export type CycleStatus = (typeof CYCLE_STATUSES)[number];

export const PHASE_STATUSES = ["PENDING", "CLAIMED", "RUNNING", "DONE", "FAILED", "SKIPPED"] as const;
export type PhaseStatus = (typeof PHASE_STATUSES)[number];

export const PHASE_TYPES = ["FRONTEND", "BACKEND", "FRONTEND_TWEAK"] as const;
export type PhaseType = (typeof PHASE_TYPES)[number];

export interface LogEntry {
  ts: string;
  level: "INFO" | "ERROR";
  phase_id?: string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface PhaseSpec {
  id: string;
  type: PhaseType;
  status: PhaseStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  started_at: string | null;
  finished_at: string | null;
  attempt_count: number;
  max_attempts: number;
  timeout_ms: number;
  claim_token: string | null;
  claimed_by: string | null;
}

export interface CycleArtifacts {
  changed_files: string[];
  commands_run: string[];
  test_results: Array<{ command: string; ok: boolean; code: number | null; stdout_tail: string; stderr_tail: string }>;
}

export interface CycleSpec {
  id: string;
  created_at: string;
  updated_at: string;
  request_text: string;
  repo_root: string;
  constraints: string[];
  phases: PhaseSpec[];
  status: CycleStatus;
  current_phase_index: number | null;
  artifacts: CycleArtifacts;
  logs: LogEntry[];
  last_error: { code: string; message: string; details?: Record<string, unknown> } | null;
  canceled_reason: string | null;
}

export interface OrchestrateInput {
  request: string;
  repo_root?: string;
  constraints?: string[];
  plan?: {
    phases?: PhaseType[];
    allow_gemini_for_backend?: boolean;
  };
}

export interface PhaseSummary {
  id: string;
  type: PhaseType;
  status: PhaseStatus;
  attempt_count: number;
  max_attempts: number;
}

export interface CycleSummary {
  id: string;
  status: CycleStatus;
  current_phase_index: number | null;
  created_at: string;
  updated_at: string;
  request_text: string;
  repo_root: string;
}

export interface RunnerConfig {
  storage_dir: string;
  checks: {
    FRONTEND: string[];
    BACKEND: string[];
    FRONTEND_TWEAK: string[];
  };
  require_changes: {
    FRONTEND: boolean;
    BACKEND: boolean;
    FRONTEND_TWEAK: boolean;
  };
  adapters: {
    gemini: {
      mode: "stub" | "cli";
      command: string;
    };
    codexExec: {
      command: string;
    };
  };
  denylist_substrings: string[];
}

export interface PhaseExecutionResult {
  report: Record<string, unknown>;
  commands_run: string[];
  frontend_tweak_required?: boolean;
}
