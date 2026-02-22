import { z } from "zod";
import { schemaError } from "./errors.js";

export const cycleStatusSchema = z.enum(["QUEUED", "RUNNING", "DONE", "FAILED", "CANCELED"]);
export const phaseStatusSchema = z.enum(["PENDING", "CLAIMED", "RUNNING", "DONE", "FAILED", "SKIPPED"]);
export const phaseTypeSchema = z.enum(["FRONTEND", "BACKEND", "FRONTEND_TWEAK"]);

const isoDateSchema = z.string().datetime({ offset: true });

export const logEntrySchema = z.object({
  ts: isoDateSchema,
  level: z.enum(["INFO", "ERROR"]),
  phase_id: z.string().optional(),
  message: z.string(),
  meta: z.record(z.string(), z.unknown()).optional()
}).strict();

export const phaseSpecSchema = z.object({
  id: z.string().min(1),
  type: phaseTypeSchema,
  status: phaseStatusSchema,
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()).nullable(),
  started_at: isoDateSchema.nullable(),
  finished_at: isoDateSchema.nullable(),
  attempt_count: z.number().int().nonnegative(),
  max_attempts: z.number().int().positive(),
  timeout_ms: z.number().int().positive(),
  claim_token: z.string().nullable(),
  claimed_by: z.string().nullable()
}).strict();

export const cycleArtifactsSchema = z.object({
  changed_files: z.array(z.string()),
  commands_run: z.array(z.string()),
  test_results: z.array(
    z.object({
      command: z.string(),
      ok: z.boolean(),
      code: z.number().int().nullable(),
      stdout_tail: z.string(),
      stderr_tail: z.string()
    }).strict()
  ),
  phase_durations_ms: z.record(z.string(), z.number().nonnegative()),
  attempt_history: z.array(
    z.object({
      phase_id: z.string(),
      attempt: z.number().int().nonnegative(),
      started_at: isoDateSchema.nullable(),
      finished_at: isoDateSchema.nullable(),
      outcome: z.enum(["DONE", "FAILED", "RETRY"]),
      error_code: z.string().optional()
    }).strict()
  )
}).strict();

export const cycleSpecSchema = z.object({
  schema_version: z.number().int().positive().default(1),
  id: z.string().min(1),
  created_at: isoDateSchema,
  updated_at: isoDateSchema,
  request_text: z.string().min(1),
  repo_root: z.string().min(1),
  constraints: z.array(z.string()),
  phases: z.array(phaseSpecSchema),
  status: cycleStatusSchema,
  current_phase_index: z.number().int().nullable(),
  artifacts: cycleArtifactsSchema,
  logs: z.array(logEntrySchema),
  last_error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional()
  }).nullable(),
  canceled_reason: z.string().nullable()
}).strict();

export const runnerConfigSchema = z.object({
  schema_version: z.number().int().positive().default(1),
  storage_dir: z.string().min(1),
  checks: z.object({
    FRONTEND: z.array(z.string()),
    BACKEND: z.array(z.string()),
    FRONTEND_TWEAK: z.array(z.string())
  }).strict(),
  require_changes: z.object({
    FRONTEND: z.boolean(),
    BACKEND: z.boolean(),
    FRONTEND_TWEAK: z.boolean()
  }).strict(),
  adapters: z.object({
    gemini: z.object({
      mode: z.enum(["stub", "cli"]),
      command: z.string().min(1)
    }).strict(),
    codexExec: z.object({
      command: z.string().min(1)
    }).strict()
  }).strict(),
  locks: z.object({
    ttl_ms: z.number().int().positive(),
    heartbeat_ms: z.number().int().positive(),
    takeover_grace_ms: z.number().int().nonnegative()
  }).strict(),
  denylist_substrings: z.array(z.string())
}).strict();

export const cycleLockSchema = z.object({
  schema_version: z.number().int().positive().default(1),
  lock_version: z.literal(1),
  cycle_id: z.string().min(1),
  owner_id: z.string().min(1),
  pid: z.number().int().nonnegative(),
  created_at: isoDateSchema,
  heartbeat_at: isoDateSchema,
  expires_at: isoDateSchema
}).strict();

export const orchestrateInputSchema = z.object({
  request: z.string().min(1),
  repo_root: z.string().optional(),
  constraints: z.array(z.string()).optional(),
  plan: z.object({
    phases: z.array(phaseTypeSchema).optional(),
    allow_gemini_for_backend: z.boolean().optional()
  }).strict().optional()
}).strict();

export const statusInputSchema = z.object({
  cycle_id: z.string().min(1),
  repo_root: z.string().optional()
}).strict();

export const logsInputSchema = z.object({
  cycle_id: z.string().min(1),
  tail: z.number().int().positive().optional(),
  repo_root: z.string().optional()
}).strict();

export const cancelInputSchema = z.object({
  cycle_id: z.string().min(1),
  reason: z.string().optional(),
  repo_root: z.string().optional()
}).strict();

export const listInputSchema = z.object({
  limit: z.number().int().positive().optional(),
  status: cycleStatusSchema.optional(),
  repo_root: z.string().optional()
}).strict();

export const renderPromptInputSchema = z.object({
  request: z.string().optional()
}).strict();

export const phaseSummarySchema = z.object({
  id: z.string(),
  type: phaseTypeSchema,
  status: phaseStatusSchema,
  attempt_count: z.number().int().nonnegative(),
  max_attempts: z.number().int().positive()
}).strict();

export const orchestrateOutputSchema = z.object({
  cycle_id: z.string().min(1),
  status: cycleStatusSchema,
  phases: z.array(phaseSummarySchema)
}).strict();

export const statusOutputSchema = z.object({
  cycle_id: z.string(),
  status: cycleStatusSchema,
  current_phase_index: z.number().int().nullable(),
  phases: z.array(phaseSummarySchema),
  created_at: isoDateSchema,
  updated_at: isoDateSchema,
  last_error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional()
  }).nullable(),
  canceled_reason: z.string().nullable(),
  repo_root: z.string(),
  request: z.string(),
  artifacts: cycleArtifactsSchema
}).strict();

export const logsOutputSchema = z.object({
  cycle_id: z.string(),
  entries: z.array(logEntrySchema)
}).strict();

export const cancelOutputSchema = z.object({
  cycle_id: z.string(),
  status: cycleStatusSchema
}).strict();

export const listOutputSchema = z.object({
  cycles: z.array(z.object({
    id: z.string(),
    status: cycleStatusSchema,
    current_phase_index: z.number().int().nullable(),
    created_at: isoDateSchema,
    updated_at: isoDateSchema,
    request_text: z.string(),
    repo_root: z.string()
  }).strict())
}).strict();

export const renderPromptOutputSchema = z.object({
  snippet: z.string().min(1)
}).strict();

export const geminiFileOpSchema = z.object({
  path: z.string().min(1),
  action: z.enum(["write", "delete"]),
  content: z.string().optional()
}).strict();

export const geminiAdapterOutputSchema = z.object({
  patch: z.string().optional(),
  file_ops: z.array(geminiFileOpSchema).optional(),
  report: z.record(z.string(), z.unknown()).optional(),
  frontend_tweak_required: z.boolean().optional()
}).strict().superRefine((value, ctx) => {
  if (!value.patch && !value.file_ops) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Either patch or file_ops must be provided"
    });
  }
  if (value.patch && value.file_ops) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "patch and file_ops are mutually exclusive"
    });
  }
  if (value.file_ops) {
    for (const op of value.file_ops) {
      if (op.action === "write" && typeof op.content !== "string") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `file_ops write action requires content for path ${op.path}`
        });
      }
    }
  }
});

export const codexStructuredOutputSchema = z.object({
  frontend_tweak_required: z.boolean().optional(),
  report: z.record(z.string(), z.unknown()).optional()
}).strict();

export function parseOrSchemaError<S extends z.ZodTypeAny>(schema: S, input: unknown, message: string): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw schemaError(
      message,
      parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
        code: issue.code
      }))
    );
  }
  return parsed.data;
}
