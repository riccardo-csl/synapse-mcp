import * as path from "node:path";
import { promises as fs } from "node:fs";
import { ensureDir } from "../../storage/files.js";
import { synapseError } from "../../synapse/errors.js";
import { geminiAdapterOutputSchema } from "../../synapse/schemas.js";
import type { CycleSpec, PhaseExecutionResult, PhaseSpec, RunnerConfig } from "../../synapse/types.js";
import { runShellCommand, tail } from "../command.js";

type GeminiStructuredOutput = import("zod").infer<typeof geminiAdapterOutputSchema>;
const RESULT_MARKER = "SYNAPSE_RESULT_JSON:";

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

async function applyFileOps(repoRoot: string, fileOps: NonNullable<GeminiStructuredOutput["file_ops"]>): Promise<void> {
  for (const op of fileOps) {
    const absolutePath = path.resolve(repoRoot, op.path);
    const relSafe = path.relative(repoRoot, absolutePath);
    if (relSafe.startsWith("..") || path.isAbsolute(relSafe)) {
      throw synapseError("REPO_BOUNDARY", "file operation outside repo_root", { path: op.path });
    }

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

  const checkResult = await runShellCommand(`git apply --check ${JSON.stringify(patchPath)}`, repoRoot, 30_000, config.denylist_substrings);
  if (checkResult.code !== 0 || checkResult.timedOut) {
    throw synapseError("PATCH_INVALID", "Gemini patch failed git apply --check", {
      stdout: tail(checkResult.stdout),
      stderr: tail(checkResult.stderr)
    });
  }

  const applyResult = await runShellCommand(`git apply ${JSON.stringify(patchPath)}`, repoRoot, 30_000, config.denylist_substrings);
  if (applyResult.code !== 0 || applyResult.timedOut) {
    throw synapseError("PATCH_APPLY_FAILED", "Failed to apply Gemini patch", {
      stdout: tail(applyResult.stdout),
      stderr: tail(applyResult.stderr)
    });
  }
}

function parseGeminiOutput(stdout: string): GeminiStructuredOutput {
  const markerIdx = stdout.lastIndexOf(RESULT_MARKER);
  let candidates: string[] = [];

  if (markerIdx >= 0) {
    const markerPayload = stdout.slice(markerIdx + RESULT_MARKER.length).trim();
    if (!markerPayload) {
      throw synapseError("ADAPTER_OUTPUT_PARSE_FAILED", "Gemini marker present but JSON payload is missing", {
        stdout_tail: tail(stdout)
      });
    }
    candidates = [markerPayload];
  } else {
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
      if (markerIdx >= 0) {
        throw synapseError("ADAPTER_OUTPUT_PARSE_FAILED", "Gemini marker JSON is malformed", {
          stdout_tail: tail(stdout)
        });
      }
    }
  }

  if (parsedObjects.length === 0) {
    throw synapseError("ADAPTER_OUTPUT_PARSE_FAILED", "Gemini JSON output is malformed", {
      stdout_tail: tail(stdout)
    });
  }

  let lastSchemaError: any = null;
  for (let i = parsedObjects.length - 1; i >= 0; i -= 1) {
    const validated = geminiAdapterOutputSchema.safeParse(parsedObjects[i]);
    if (validated.success) {
      return validated.data;
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

  const prompt = [
    `You are executing synapse phase ${phase.type}.`,
    `Request: ${cycle.request_text}`,
    `Constraints: ${(cycle.constraints || []).join("; ") || "none"}`,
    "Return ONLY JSON with exactly one content mode.",
    "If you include any additional logs, the FINAL line must be:",
    "SYNAPSE_RESULT_JSON: { ... }",
    "1) {\"patch\":\"...unified diff...\",\"report\":{...},\"frontend_tweak_required\":false}",
    "2) {\"file_ops\":[{\"path\":\"...\",\"action\":\"write|delete\",\"content\":\"...\"}],\"report\":{...},\"frontend_tweak_required\":false}"
  ].join("\n");

  const command = `${config.adapters.gemini.command} ${JSON.stringify(prompt)}`;
  const result = await runShellCommand(command, cycle.repo_root, phase.timeout_ms, config.denylist_substrings, { signal });
  if (result.canceled) {
    throw synapseError("PHASE_CANCELED", "Gemini phase canceled", { phase_id: phase.id });
  }
  if (result.timedOut) {
    throw synapseError("PHASE_TIMEOUT", "Gemini phase timed out", { phase_id: phase.id });
  }
  if (result.code !== 0) {
    throw synapseError("ADAPTER_FAILED", "Gemini command failed", {
      command,
      code: result.code,
      stderr: tail(result.stderr),
      stdout: tail(result.stdout)
    });
  }

  const parsed = parseGeminiOutput(result.stdout);

  if (parsed.file_ops) {
    await applyFileOps(cycle.repo_root, parsed.file_ops);
  }
  if (parsed.patch) {
    await applyPatch(cycle.repo_root, parsed.patch, config);
  }

  return {
    report: parsed.report || {
      message: "Gemini phase executed",
      stdout_tail: tail(result.stdout)
    },
    commands_run: [command],
    frontend_tweak_required: parsed.frontend_tweak_required
  };
}
