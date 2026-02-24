import { synapseError } from "../../../synapse/errors.js";
import type { RunnerConfig } from "../../../synapse/types.js";
import type { GeminiStructuredOutput } from "./types.js";

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function enforceGeminiOutputLimits(parsed: GeminiStructuredOutput, config: RunnerConfig): void {
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
