import * as path from "node:path";

export function truncate(value: string, max = 400): string {
  if (!value) {
    return "";
  }
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function uniq(items: string[]): string[] {
  return Array.from(new Set(items));
}

export function sanitizeRelPath(repoRoot: string, relPath: string): string | null {
  const trimmed = relPath.trim().replace(/^\.\/+/, "");
  if (!trimmed) {
    return null;
  }
  const abs = path.resolve(repoRoot, trimmed);
  const rel = path.relative(repoRoot, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return rel.split(path.sep).join("/");
}
