import * as path from "node:path";
import { promises as fs } from "node:fs";
import { ensureDir } from "../../storage/files.js";
import { synapseError } from "../../synapse/errors.js";
import { geminiAdapterOutputSchema } from "../../synapse/schemas.js";
import type { CycleSpec, PhaseExecutionResult, PhaseSpec, RunnerConfig } from "../../synapse/types.js";
import { runShellCommand, tail } from "../command.js";

type GeminiStructuredOutput = import("zod").infer<typeof geminiAdapterOutputSchema>;
const RESULT_MARKER = "SYNAPSE_RESULT_JSON:";
const RESULT_BEGIN = "SYNAPSE_RESULT_JSON_BEGIN";
const RESULT_END = "SYNAPSE_RESULT_JSON_END";
type ParseSource = "block_marker" | "line_marker" | "json_scan";

interface GeminiParseResult {
  payload: GeminiStructuredOutput;
  parseSource: ParseSource;
}

interface GeminiCommandAttempt {
  command: string;
  stdout: string;
  stderr: string;
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function classifyGeminiCommandFailure(command: string, code: number | null, stdout: string, stderr: string): Error {
  const combined = `${stderr}\n${stdout}`;
  const looksLikeCapacity = (
    /MODEL_CAPACITY_EXHAUSTED/i.test(combined)
    || /RESOURCE_EXHAUSTED/i.test(combined)
    || /rateLimitExceeded/i.test(combined)
    || /\bstatus\b[^0-9]{0,10}429\b/i.test(combined)
    || /Too Many Requests/i.test(combined)
  );

  if (looksLikeCapacity) {
    const modelMatch = combined.match(/"model"\s*:\s*"([^"]+)"/i) || combined.match(/model\s*[:=]\s*([A-Za-z0-9._-]+)/i);
    return synapseError("ADAPTER_CAPACITY_EXHAUSTED", "Gemini provider capacity exhausted", {
      command,
      code,
      model: modelMatch?.[1],
      hint: "Gemini provider returned a capacity/quota error. Retry later or switch to a different Gemini model.",
      recommended_action: "retry_later_or_switch_model",
      stderr: tail(stderr),
      stdout: tail(stdout)
    });
  }

  return synapseError("ADAPTER_FAILED", "Gemini command failed", {
    command,
    code,
    stderr: tail(stderr),
    stdout: tail(stdout)
  });
}

function extractJsonObjects(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return [trimmed];
  }

  const objects: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") {
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === "\\") {
        escaped = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          objects.push(text.slice(start, i + 1));
          start = i;
          break;
        }
      }
    }
  }

  return objects;
}

function normalizeRepoPath(repoRoot: string, inputPath: string): { absolutePath: string; normalizedRel: string } {
  const absolutePath = path.resolve(repoRoot, inputPath);
  const relSafe = path.relative(repoRoot, absolutePath);
  if (relSafe.startsWith("..") || path.isAbsolute(relSafe)) {
    throw synapseError("REPO_BOUNDARY", "file operation outside repo_root", { path: inputPath });
  }

  // Normalize separators for duplicate detection across platforms.
  const normalizedRel = relSafe.split(path.sep).join("/");
  return { absolutePath, normalizedRel };
}

function validateFileOpsSequence(repoRoot: string, fileOps: NonNullable<GeminiStructuredOutput["file_ops"]>): void {
  const seen = new Set<string>();
  for (const op of fileOps) {
    const { normalizedRel } = normalizeRepoPath(repoRoot, op.path);
    if (seen.has(normalizedRel)) {
      throw synapseError("ADAPTER_OUTPUT_INVALID", "duplicate file_ops entries for the same path are not allowed", {
        path: op.path,
        normalized_path: normalizedRel
      });
    }
    seen.add(normalizedRel);
  }
}

async function applyFileOps(repoRoot: string, fileOps: NonNullable<GeminiStructuredOutput["file_ops"]>): Promise<void> {
  validateFileOpsSequence(repoRoot, fileOps);
  for (const op of fileOps) {
    const { absolutePath } = normalizeRepoPath(repoRoot, op.path);

    if (op.action === "delete") {
      await fs.unlink(absolutePath).catch((err: any) => {
        if (err?.code !== "ENOENT") {
          throw err;
        }
      });
      continue;
    }

    if (op.action === "write") {
      await ensureDir(path.dirname(absolutePath));
      await fs.writeFile(absolutePath, op.content || "", "utf8");
      continue;
    }

    throw synapseError("ADAPTER_OUTPUT_INVALID", "unsupported file operation action", { action: op.action });
  }
}

async function applyPatch(repoRoot: string, patch: string, config: RunnerConfig): Promise<void> {
  const synapseTmpDir = path.join(repoRoot, config.storage_dir, "tmp");
  await ensureDir(synapseTmpDir);
  const patchPath = path.join(synapseTmpDir, `gemini-${Date.now()}.patch`);
  await fs.writeFile(patchPath, patch, "utf8");
  try {
    const checkResult = await runShellCommand(
      `git apply --check ${JSON.stringify(patchPath)}`,
      repoRoot,
      30_000,
      config.denylist_substrings,
      { termGraceMs: config.cancellation.term_grace_ms }
    );
    if (checkResult.code !== 0 || checkResult.timedOut) {
      throw synapseError("PATCH_INVALID", "Gemini patch failed git apply --check", {
        stdout: tail(checkResult.stdout),
        stderr: tail(checkResult.stderr)
      });
    }

    const applyResult = await runShellCommand(
      `git apply ${JSON.stringify(patchPath)}`,
      repoRoot,
      30_000,
      config.denylist_substrings,
      { termGraceMs: config.cancellation.term_grace_ms }
    );
    if (applyResult.code !== 0 || applyResult.timedOut) {
      throw synapseError("PATCH_APPLY_FAILED", "Failed to apply Gemini patch", {
        stdout: tail(applyResult.stdout),
        stderr: tail(applyResult.stderr)
      });
    }
  } finally {
    await fs.unlink(patchPath).catch(() => {});
  }
}

function extractLastMarkedBlock(stdout: string): string | null {
  const endIdx = stdout.lastIndexOf(RESULT_END);
  if (endIdx < 0) {
    return null;
  }
  const beginIdx = stdout.lastIndexOf(RESULT_BEGIN, endIdx);
  if (beginIdx < 0) {
    throw synapseError("ADAPTER_OUTPUT_PARSE_FAILED", "Gemini structured END marker found without BEGIN marker", {
      stdout_tail: tail(stdout)
    });
  }

  const raw = stdout
    .slice(beginIdx + RESULT_BEGIN.length, endIdx)
    .trim();
  if (!raw) {
    throw synapseError("ADAPTER_OUTPUT_PARSE_FAILED", "Gemini structured marker block is empty", {
      stdout_tail: tail(stdout)
    });
  }
  return raw;
}

function extractMarkerLineCandidates(stdout: string): string[] {
  const lines = stdout.split(/\r?\n/);
  const candidates: string[] = [];
  for (const line of lines) {
    const idx = line.indexOf(RESULT_MARKER);
    if (idx < 0) {
      continue;
    }
    const payload = line.slice(idx + RESULT_MARKER.length).trim();
    if (payload) {
      candidates.push(payload);
    }
  }
  return candidates;
}

function parseGeminiOutput(stdout: string, requireMarker: boolean): GeminiParseResult {
  const blockPayload = extractLastMarkedBlock(stdout);
  const markerLineCandidates = extractMarkerLineCandidates(stdout);
  const hasAnyMarker = blockPayload !== null || markerLineCandidates.length > 0;
  let parseSource: ParseSource;
  let candidates: string[] = [];

  if (blockPayload !== null) {
    parseSource = "block_marker";
    candidates = [blockPayload];
  } else if (markerLineCandidates.length > 0) {
    parseSource = "line_marker";
    // Use only the newest marker payload. If it is malformed, fail instead of
    // silently applying an earlier payload.
    candidates = [markerLineCandidates[markerLineCandidates.length - 1]];
  } else {
    if (requireMarker) {
      throw synapseError("ADAPTER_OUTPUT_PARSE_FAILED", "Gemini output missing required structured marker", {
        marker: RESULT_MARKER
      });
    }

    parseSource = "json_scan";
    candidates = extractJsonObjects(stdout);
    if (candidates.length === 0) {
      throw synapseError("ADAPTER_OUTPUT_PARSE_FAILED", "Gemini output does not contain a JSON object", {
        stdout_tail: tail(stdout)
      });
    }
  }

  const parsedObjects: unknown[] = [];
  for (const candidate of candidates) {
    try {
      parsedObjects.push(JSON.parse(candidate));
    } catch {
      if (hasAnyMarker) {
        continue;
      }
    }
  }

  if (parsedObjects.length === 0) {
    throw synapseError("ADAPTER_OUTPUT_PARSE_FAILED", hasAnyMarker
      ? "Gemini structured marker JSON is malformed"
      : "Gemini JSON output is malformed", {
      stdout_tail: tail(stdout)
    });
  }

  let lastSchemaError: any = null;
  for (let i = parsedObjects.length - 1; i >= 0; i -= 1) {
    const validated = geminiAdapterOutputSchema.safeParse(parsedObjects[i]);
    if (validated.success) {
      return {
        payload: validated.data,
        parseSource
      };
    }
    lastSchemaError = validated.error;
  }

  if (lastSchemaError) {
    throw synapseError("ADAPTER_OUTPUT_INVALID", "Gemini JSON output failed schema validation", {
      issues: lastSchemaError.issues.map((issue: any) => ({
        path: issue.path.join("."),
        message: issue.message,
        code: issue.code
      })),
      stdout_tail: tail(stdout)
    });
  }
  throw synapseError("ADAPTER_OUTPUT_PARSE_FAILED", "Gemini output could not be parsed", {
    stdout_tail: tail(stdout)
  });
}

function enforceGeminiOutputLimits(parsed: GeminiStructuredOutput, config: RunnerConfig): void {
  const limits = config.adapters.gemini;

  if (parsed.patch) {
    const patchBytes = utf8ByteLength(parsed.patch);
    if (patchBytes > limits.max_patch_bytes) {
      throw synapseError("PATCH_INVALID", "Gemini patch exceeds configured size limit", {
        patch_bytes: patchBytes,
        max_patch_bytes: limits.max_patch_bytes
      });
    }
  }

  if (parsed.file_ops) {
    if (parsed.file_ops.length > limits.max_file_ops) {
      throw synapseError("ADAPTER_OUTPUT_INVALID", "Gemini file_ops exceed configured count limit", {
        file_ops_count: parsed.file_ops.length,
        max_file_ops: limits.max_file_ops
      });
    }

    for (const op of parsed.file_ops) {
      if (op.action !== "write") {
        continue;
      }
      const contentBytes = utf8ByteLength(op.content || "");
      if (contentBytes > limits.max_file_op_bytes) {
        throw synapseError("ADAPTER_OUTPUT_INVALID", "Gemini file_ops write content exceeds configured size limit", {
          path: op.path,
          content_bytes: contentBytes,
          max_file_op_bytes: limits.max_file_op_bytes
        });
      }
    }
  }
}

function buildGeminiPrompt(
  cycle: CycleSpec,
  phase: PhaseSpec,
  config: RunnerConfig,
  mode: "initial" | "repair",
  context?: { previous_stdout: string; previous_stderr: string; last_error: { code?: string; message?: string } }
): string {
  const requireMarker = config.adapters.gemini.require_marker;
  const base = [
    `You are executing synapse phase ${phase.type}.`,
    `Request: ${cycle.request_text}`,
    `Constraints: ${(cycle.constraints || []).join("; ") || "none"}`,
    requireMarker
      ? "Return ONLY structured output using one of the required marker formats at the end."
      : "Return ONLY JSON with exactly one content mode.",
    "Preferred (more reliable) format:",
    "SYNAPSE_RESULT_JSON_BEGIN",
    "{ ...json... }",
    "SYNAPSE_RESULT_JSON_END",
    "Alternative single-line final marker:",
    "SYNAPSE_RESULT_JSON: { ... }",
    "1) {\"patch\":\"...unified diff...\",\"report\":{...},\"frontend_tweak_required\":false}",
    "2) {\"file_ops\":[{\"path\":\"...\",\"action\":\"write|delete\",\"content\":\"...\"}],\"report\":{...},\"frontend_tweak_required\":false}",
    `Hard limits: max_output_bytes=${config.adapters.gemini.max_output_bytes}, max_patch_bytes=${config.adapters.gemini.max_patch_bytes}, max_file_ops=${config.adapters.gemini.max_file_ops}, max_file_op_bytes=${config.adapters.gemini.max_file_op_bytes}`
  ];

  if (mode === "repair" && context) {
    base.push(
      "Previous output failed Synapse validation. Repair the response and return ONLY one valid structured payload.",
      `Previous error code: ${context.last_error.code || "unknown"}`,
      `Previous error message: ${context.last_error.message || "unknown"}`,
      "Do not repeat explanations or logs. Output only the corrected structured payload.",
      `Previous stdout tail (for repair context):\n${tail(context.previous_stdout, 1500)}`,
      `Previous stderr tail (for repair context):\n${tail(context.previous_stderr, 800)}`
    );
  }

  return base.join("\n");
}

async function executeGeminiCommand(
  prompt: string,
  cycle: CycleSpec,
  phase: PhaseSpec,
  config: RunnerConfig,
  signal?: AbortSignal
): Promise<GeminiCommandAttempt> {
  const command = `${config.adapters.gemini.command} ${JSON.stringify(prompt)}`;
  const result = await runShellCommand(command, cycle.repo_root, phase.timeout_ms, config.denylist_substrings, {
    signal,
    termGraceMs: config.cancellation.term_grace_ms
  });
  if (result.canceled) {
    throw synapseError("PHASE_CANCELED", "Gemini phase canceled", { phase_id: phase.id });
  }
  if (result.timedOut) {
    throw synapseError("PHASE_TIMEOUT", "Gemini phase timed out", { phase_id: phase.id });
  }
  if (result.code !== 0) {
    throw classifyGeminiCommandFailure(command, result.code, result.stdout, result.stderr);
  }

  const stdoutBytes = utf8ByteLength(result.stdout);
  if (stdoutBytes > config.adapters.gemini.max_output_bytes) {
    throw synapseError("ADAPTER_OUTPUT_INVALID", "Gemini stdout exceeds configured size limit", {
      stdout_bytes: stdoutBytes,
      max_output_bytes: config.adapters.gemini.max_output_bytes
    });
  }

  return {
    command,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

export async function runGeminiPhase(
  cycle: CycleSpec,
  phase: PhaseSpec,
  config: RunnerConfig,
  signal?: AbortSignal
): Promise<PhaseExecutionResult> {
  if (config.adapters.gemini.mode === "stub") {
    return {
      report: {
        mode: "stub",
        message: "Gemini adapter in stub mode. Configure .synapse/config.json adapters.gemini.mode=cli to execute Gemini CLI."
      },
      commands_run: []
    };
  }

  const requireMarker = config.adapters.gemini.require_marker;
  const maxRepairAttempts = config.adapters.gemini.repair_retry_on_invalid_output
    ? Math.max(0, config.adapters.gemini.max_repair_attempts)
    : 0;

  const commandsRun: string[] = [];
  let attempt = 0;
  let lastAttempt: GeminiCommandAttempt | null = null;
  let lastOutputError: { code?: string; message?: string } = {};
  let parseSource: ParseSource = "json_scan";
  let parsed: GeminiStructuredOutput | null = null;

  while (true) {
    const prompt = attempt === 0
      ? buildGeminiPrompt(cycle, phase, config, "initial")
      : buildGeminiPrompt(cycle, phase, config, "repair", {
        previous_stdout: lastAttempt?.stdout || "",
        previous_stderr: lastAttempt?.stderr || "",
        last_error: lastOutputError
      });

    const executed = await executeGeminiCommand(prompt, cycle, phase, config, signal);
    commandsRun.push(executed.command);

    try {
      const parsedResult = parseGeminiOutput(executed.stdout, requireMarker);
      parsed = parsedResult.payload;
      parseSource = parsedResult.parseSource;
      enforceGeminiOutputLimits(parsed, config);
      lastAttempt = executed;
      break;
    } catch (err: any) {
      lastAttempt = executed;
      const isRecoverableOutputError = err?.code === "ADAPTER_OUTPUT_PARSE_FAILED" || err?.code === "ADAPTER_OUTPUT_INVALID";
      if (!isRecoverableOutputError || attempt >= maxRepairAttempts) {
        throw err;
      }
      lastOutputError = {
        code: err?.code,
        message: err?.message
      };
      attempt += 1;
      continue;
    }
  }

  if (!parsed || !lastAttempt) {
    throw synapseError("ADAPTER_FAILED", "Gemini phase ended without parsed output", { phase_id: phase.id });
  }

  if (parsed.file_ops) {
    await applyFileOps(cycle.repo_root, parsed.file_ops);
  }
  if (parsed.patch) {
    await applyPatch(cycle.repo_root, parsed.patch, config);
  }

  return {
    report: {
      ...(parsed.report || {}),
      adapter: "gemini",
      output_mode: parsed.patch ? "patch" : "file_ops",
      parse_source: parseSource,
      repair_attempts: attempt,
      stdout_tail: tail(lastAttempt.stdout),
      stderr_tail: tail(lastAttempt.stderr)
    },
    commands_run: commandsRun,
    frontend_tweak_required: parsed.frontend_tweak_required
  };
}
