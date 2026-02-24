import { uniq } from "./utils.js";

const FILE_PATH_RE = /\b(?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|scss|md|yml|yaml)\b/g;

export function extractPathsFromText(text: string): string[] {
  if (!text) {
    return [];
  }
  const found = text.match(FILE_PATH_RE) || [];
  return uniq(found);
}
