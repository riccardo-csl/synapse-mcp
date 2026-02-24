import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";

import { cleanupDir, createTempRepo } from "../helpers/synapse-fixtures.js";
import { readOrBuildRepoIndex, suggestFilesFromRepoIndex } from "../../lib/runner/adapters/repoIndex.js";

test("repo index builds cache and suggests likely files from request tokens", async () => {
  const repoRoot = await createTempRepo("synapse-repo-index-");
  try {
    await fs.mkdir(path.join(repoRoot, "apps/web/src/features/dashboard/ui"), { recursive: true });
    await fs.mkdir(path.join(repoRoot, "apps/web/src/features/tasks/api"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "apps/web/src/features/dashboard/ui/MyScheduleCard.tsx"),
      "export function MyScheduleCard() { return <div>task card dashboard schedule</div>; }\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(repoRoot, "apps/web/src/features/tasks/api/tasksClient.ts"),
      "export interface ApiTask { id: string; title: string }\n",
      "utf8"
    );

    const index1 = await readOrBuildRepoIndex(repoRoot, ".synapse", { ttlMs: 60_000 });
    const cachePath = path.join(repoRoot, ".synapse/cache/repo-index.json");
    const cacheStat1 = await fs.stat(cachePath);
    const index2 = await readOrBuildRepoIndex(repoRoot, ".synapse", { ttlMs: 60_000 });
    const cacheStat2 = await fs.stat(cachePath);

    assert.equal(index1.entries.length > 0, true);
    assert.equal(index2.entries.length > 0, true);
    assert.equal(cacheStat1.mtimeMs, cacheStat2.mtimeMs, "cache should be reused within TTL");

    const suggestions = suggestFilesFromRepoIndex(
      index2,
      "Frontend UI enhancement for My Schedule dashboard task card",
      { limit: 5 }
    );
    assert.equal(suggestions.length > 0, true);
    assert.equal(
      suggestions.some((s) => s.path === "apps/web/src/features/dashboard/ui/MyScheduleCard.tsx"),
      true
    );
  } finally {
    await cleanupDir(repoRoot);
  }
});
