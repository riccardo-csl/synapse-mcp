import { synapseError } from "../../../synapse/errors.js";
import { tail } from "../../command.js";

export function classifyGeminiCommandFailure(command: string, code: number | null, stdout: string, stderr: string): Error {
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
