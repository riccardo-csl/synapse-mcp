import * as path from "node:path";
import { promises as fs } from "node:fs";
import { ensureDir } from "../../../storage/files.js";
import { synapseError } from "../../../synapse/errors.js";
import type { RunnerConfig } from "../../../synapse/types.js";
import { runShellCommand, tail } from "../../command.js";
import type { GeminiStructuredOutput } from "./types.js";

function normalizeRepoPath(repoRoot: string, inputPath: string): { absolutePath: string; normalizedRel: string } {
  const absolutePath = path.resolve(repoRoot, inputPath);
  const relSafe = path.relative(repoRoot, absolutePath);
  if (relSafe.startsWith("..") || path.isAbsolute(relSafe)) {
    throw synapseError("REPO_BOUNDARY", "file operation outside repo_root", { path: inputPath });
  }
  return { absolutePath, normalizedRel: relSafe.split(path.sep).join("/") };
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

export async function applyFileOps(repoRoot: string, fileOps: NonNullable<GeminiStructuredOutput["file_ops"]>): Promise<void> {
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

export async function applyPatch(repoRoot: string, patch: string, config: RunnerConfig): Promise<void> {
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
