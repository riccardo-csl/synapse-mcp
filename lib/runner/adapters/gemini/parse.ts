import { synapseError } from "../../../synapse/errors.js";
import { geminiAdapterOutputSchema } from "../../../synapse/schemas.js";
import { tail } from "../../command.js";
import type { GeminiParseResult } from "./types.js";

const RESULT_MARKER = "SYNAPSE_RESULT_JSON:";
const RESULT_BEGIN = "SYNAPSE_RESULT_JSON_BEGIN";
const RESULT_END = "SYNAPSE_RESULT_JSON_END";

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
      if (ch === "\"") {
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
  const raw = stdout.slice(beginIdx + RESULT_BEGIN.length, endIdx).trim();
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

export function parseGeminiOutput(stdout: string, requireMarker: boolean): GeminiParseResult {
  const blockPayload = extractLastMarkedBlock(stdout);
  const markerLineCandidates = extractMarkerLineCandidates(stdout);
  const hasAnyMarker = blockPayload !== null || markerLineCandidates.length > 0;

  let parseSource: GeminiParseResult["parseSource"];
  let candidates: string[] = [];

  if (blockPayload !== null) {
    parseSource = "block_marker";
    candidates = [blockPayload];
  } else if (markerLineCandidates.length > 0) {
    parseSource = "line_marker";
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
    throw synapseError(
      "ADAPTER_OUTPUT_PARSE_FAILED",
      hasAnyMarker ? "Gemini structured marker JSON is malformed" : "Gemini JSON output is malformed",
      { stdout_tail: tail(stdout) }
    );
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
