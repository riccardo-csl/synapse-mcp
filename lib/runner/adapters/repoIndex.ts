import * as path from "node:path";
import { promises as fs } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { ensureDir, atomicWriteJson, readJsonIfExists } from "../../storage/files.js";

export interface RepoIndexEntry {
  path: string;
  mtime_ms: number;
  size: number;
  tokens: string[];
}

export interface RepoIndexFile {
  schema_version: 1;
  repo_root: string;
  generated_at: string;
  ttl_ms: number;
  file_count: number;
  entries: RepoIndexEntry[];
}

const REPO_INDEX_SCHEMA_VERSION = 1;
const DEFAULT_INDEX_TTL_MS = 60_000;
const MAX_INDEX_FILES = 4000;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_FILE_READ_BYTES = 12 * 1024;
const MAX_TOKENS_PER_FILE = 40;
const INDEXABLE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".css", ".scss", ".md", ".yml", ".yaml"
]);
const IGNORE_DIRS = new Set([
  ".git", "node_modules", ".synapse", "dist", "build", "coverage", ".next", ".turbo"
]);

function indexPath(repoRoot: string, storageDir: string): string {
  return path.join(repoRoot, storageDir, "cache", "repo-index.json");
}

function normalizeRel(repoRoot: string, absPath: string): string {
  return path.relative(repoRoot, absPath).split(path.sep).join("/");
}

function nowIso(): string {
  return new Date().toISOString();
}

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z][a-z0-9_:-]{1,}/g) || [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of matches) {
    for (const part of raw.split(/[_:/-]+/g)) {
      const token = part.trim();
      if (token.length < 3) {
        continue;
      }
      if (seen.has(token)) {
        continue;
      }
      seen.add(token);
      out.push(token);
      if (out.length >= MAX_TOKENS_PER_FILE) {
        return out;
      }
    }
  }
  return out;
}

async function readFileHead(filePath: string): Promise<string> {
  const fh = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(MAX_FILE_READ_BYTES);
    const { bytesRead } = await fh.read(buffer, 0, MAX_FILE_READ_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

async function buildEntry(repoRoot: string, absPath: string, stat: Stats): Promise<RepoIndexEntry | null> {
  const rel = normalizeRel(repoRoot, absPath);
  let head = "";
  try {
    head = await readFileHead(absPath);
  } catch {
    return null;
  }
  if (head.includes("\u0000")) {
    return null;
  }
  const pathTokens = tokenize(rel.replace(/\./g, " "));
  const contentTokens = tokenize(head);
  const tokens = Array.from(new Set([...pathTokens, ...contentTokens])).slice(0, MAX_TOKENS_PER_FILE);
  return {
    path: rel,
    mtime_ms: stat.mtimeMs,
    size: stat.size,
    tokens
  };
}

async function walkIndexableFiles(repoRoot: string): Promise<string[]> {
  const queue = [repoRoot];
  const files: string[] = [];

  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) {
          continue;
        }
        queue.push(abs);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!INDEXABLE_EXTS.has(ext)) {
        continue;
      }
      files.push(abs);
      if (files.length >= MAX_INDEX_FILES) {
        return files;
      }
    }
  }

  return files;
}

function parseRepoIndex(raw: unknown, repoRoot: string): RepoIndexFile | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  if (rec.schema_version !== REPO_INDEX_SCHEMA_VERSION) {
    return null;
  }
  if (typeof rec.repo_root !== "string" || rec.repo_root !== repoRoot) {
    return null;
  }
  if (typeof rec.generated_at !== "string" || typeof rec.ttl_ms !== "number") {
    return null;
  }
  if (!Array.isArray(rec.entries)) {
    return null;
  }
  const entries: RepoIndexEntry[] = [];
  for (const item of rec.entries) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.path !== "string" || typeof r.mtime_ms !== "number" || typeof r.size !== "number" || !Array.isArray(r.tokens)) {
      continue;
    }
    entries.push({
      path: r.path,
      mtime_ms: r.mtime_ms,
      size: r.size,
      tokens: r.tokens.filter((t): t is string => typeof t === "string").slice(0, MAX_TOKENS_PER_FILE)
    });
  }
  return {
    schema_version: REPO_INDEX_SCHEMA_VERSION,
    repo_root: repoRoot,
    generated_at: rec.generated_at,
    ttl_ms: rec.ttl_ms,
    file_count: typeof rec.file_count === "number" ? rec.file_count : entries.length,
    entries
  };
}

export async function readOrBuildRepoIndex(
  repoRoot: string,
  storageDir: string,
  opts: { ttlMs?: number } = {}
): Promise<RepoIndexFile> {
  const ttlMs = typeof opts.ttlMs === "number" && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_INDEX_TTL_MS;
  const filePath = indexPath(repoRoot, storageDir);
  const cachedRaw = await readJsonIfExists(filePath).catch(() => null);
  const cached = parseRepoIndex(cachedRaw, repoRoot);
  if (cached) {
    const age = Date.now() - Date.parse(cached.generated_at);
    if (Number.isFinite(age) && age >= 0 && age <= ttlMs) {
      return cached;
    }
  }

  const files = await walkIndexableFiles(repoRoot);
  const builtEntries: RepoIndexEntry[] = [];
  for (const absPath of files) {
    let stat: Stats;
    try {
      stat = await fs.stat(absPath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      continue;
    }
    const entry = await buildEntry(repoRoot, absPath, stat);
    if (entry) {
      builtEntries.push(entry);
    }
  }

  const index: RepoIndexFile = {
    schema_version: REPO_INDEX_SCHEMA_VERSION,
    repo_root: repoRoot,
    generated_at: nowIso(),
    ttl_ms: ttlMs,
    file_count: builtEntries.length,
    entries: builtEntries
  };

  await ensureDir(path.dirname(filePath));
  await atomicWriteJson(filePath, index);
  return index;
}

function queryTokens(queryText: string): string[] {
  return tokenize(queryText).slice(0, 60);
}

export function suggestFilesFromRepoIndex(
  index: RepoIndexFile,
  queryText: string,
  opts: { limit?: number; exclude?: string[] } = {}
): Array<{ path: string; score: number; matched_tokens: string[] }> {
  const qTokens = new Set(queryTokens(queryText));
  if (qTokens.size === 0) {
    return [];
  }
  const exclude = new Set((opts.exclude || []).map((p) => p.trim()).filter(Boolean));
  const scored: Array<{ path: string; score: number; matched_tokens: string[] }> = [];

  for (const entry of index.entries) {
    if (exclude.has(entry.path)) {
      continue;
    }
    let score = 0;
    const matched: string[] = [];
    for (const token of entry.tokens) {
      if (qTokens.has(token)) {
        score += 1;
        matched.push(token);
      }
    }
    if (score === 0) {
      continue;
    }
    // Small path heuristics to favor likely component/service files over generic docs/config.
    if (/\/(ui|components?|features?|api|model|services?)\//i.test(entry.path)) {
      score += 2;
    }
    if (/\.(tsx|ts|jsx|js)$/i.test(entry.path)) {
      score += 1;
    }
    if (/readme|package\.json/i.test(entry.path)) {
      score -= 1;
    }
    scored.push({ path: entry.path, score, matched_tokens: matched.slice(0, 8) });
  }

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, Math.max(1, opts.limit || 8));
}
