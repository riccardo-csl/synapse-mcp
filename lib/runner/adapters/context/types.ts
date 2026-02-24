export interface CompletedPhaseContext {
  id: string;
  type: string;
  completed_at: string | null;
  summary?: string;
  files_modified?: string[];
  changed_files?: string[];
  frontend_tweak_required?: boolean;
}

export interface CandidateFileSeed {
  path: string;
  source: string;
  reason?: string;
  matched_tokens?: string[];
}
