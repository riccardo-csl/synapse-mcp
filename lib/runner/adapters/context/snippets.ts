import * as path from "node:path";
import { promises as fs } from "node:fs";
import type { CandidateFileSeed } from "./types.js";
import { truncate } from "./utils.js";

export async function readSeedFileSnippets(
  repoRoot: string,
  candidates: CandidateFileSeed[]
): Promise<Array<{ path: string; source: string; reason?: string; snippet: string }>> {
  const results: Array<{ path: string; source: string; reason?: string; snippet: string }> = [];

  for (const candidate of candidates) {
    if (results.length >= 6) {
      break;
    }
    const abs = path.join(repoRoot, candidate.path);
    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (!content || content.includes("\u0000")) {
      continue;
    }
    const snippet = content
      .split(/\r?\n/)
      .slice(0, 30)
      .join("\n");
    const normalized = truncate(snippet, 700);
    if (!normalized.trim()) {
      continue;
    }
    results.push({
      path: candidate.path,
      source: candidate.source,
      ...(candidate.reason ? { reason: candidate.reason } : {}),
      ...(candidate.matched_tokens?.length ? { matched_tokens: candidate.matched_tokens } : {}),
      snippet: normalized
    });
  }

  return results;
}
