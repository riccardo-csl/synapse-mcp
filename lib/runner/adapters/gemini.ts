import * as path from "node:path";
import { promises as fs } from "node:fs";
import { ensureDir } from "../../storage/files.js";
import { synapseError } from "../../synapse/errors.js";
import type { CycleSpec, PhaseExecutionResult, PhaseSpec, RunnerConfig } from "../../synapse/types.js";
import { runShellCommand, tail } from "../command.js";

interface GeminiStructuredOutput {
  patch?: string;
  file_ops?: Array<{ path: string; action: "write" | "delete"; content?: string }>;
  report?: Record<string, unknown>;
  frontend_tweak_required?: boolean;
}

function extractJsonObject(text: string): GeminiStructuredOutput | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
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
      if (typeof op.content !== "string") {
        throw synapseError("SCHEMA_INVALID", "file_ops write action requires content", { path: op.path });
      }
      await ensureDir(path.dirname(absolutePath));
      await fs.writeFile(absolutePath, op.content, "utf8");
      continue;
    }

    throw synapseError("SCHEMA_INVALID", "unsupported file operation action", { action: op.action });
  }
}

async function applyPatch(repoRoot: string, patch: string, config: RunnerConfig): Promise<void> {
  const synapseTmpDir = path.join(repoRoot, config.storage_dir, "tmp");
  await ensureDir(synapseTmpDir);
  const patchPath = path.join(synapseTmpDir, `gemini-${Date.now()}.patch`);
  await fs.writeFile(patchPath, patch, "utf8");

  const applyResult = await runShellCommand(`git apply ${JSON.stringify(patchPath)}`, repoRoot, 30_000, config.denylist_substrings);
  if (applyResult.code !== 0) {
    throw synapseError("PATCH_APPLY_FAILED", "Failed to apply Gemini patch", {
      stdout: tail(applyResult.stdout),
      stderr: tail(applyResult.stderr)
    });
  }
}

export async function runGeminiPhase(
  cycle: CycleSpec,
  phase: PhaseSpec,
  config: RunnerConfig
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
    "Return ONLY JSON with one of:",
    "1) {\"patch\":\"...unified diff...\",\"report\":{...}}",
    "2) {\"file_ops\":[{\"path\":\"...\",\"action\":\"write|delete\",\"content\":\"...\"}],\"report\":{...}}"
  ].join("\n");

  const command = `${config.adapters.gemini.command} ${JSON.stringify(prompt)}`;
  const result = await runShellCommand(command, cycle.repo_root, phase.timeout_ms, config.denylist_substrings);
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

  const parsed = extractJsonObject(result.stdout);
  if (!parsed) {
    throw synapseError("SCHEMA_INVALID", "Gemini output must be valid JSON payload", {
      stdout_tail: tail(result.stdout)
    });
  }
  if (!parsed.patch && !parsed.file_ops) {
    throw synapseError("SCHEMA_INVALID", "Gemini output must include patch or file_ops");
  }

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
