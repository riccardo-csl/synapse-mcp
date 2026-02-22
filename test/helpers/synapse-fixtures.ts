import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execCb);

export async function createTempRepo(prefix = "synapse-test-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await exec("git init -q", { cwd: dir });
  await exec("git config user.email test@example.com", { cwd: dir });
  await exec("git config user.name synapse-test", { cwd: dir });
  await fs.writeFile(path.join(dir, "README.md"), "# temp\n", "utf8");
  await exec("git add README.md && git commit -m init -q", { cwd: dir });
  return dir;
}

export async function cleanupDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

export async function writeSynapseConfig(
  repoRoot: string,
  configPatch: Record<string, unknown> = {}
): Promise<void> {
  const synapseDir = path.join(repoRoot, ".synapse");
  await fs.mkdir(synapseDir, { recursive: true });
  const config = {
    schema_version: 1,
    storage_dir: ".synapse",
    checks: {
      FRONTEND: [],
      BACKEND: [],
      FRONTEND_TWEAK: []
    },
    require_changes: {
      FRONTEND: false,
      BACKEND: false,
      FRONTEND_TWEAK: false
    },
    adapters: {
      gemini: {
        mode: "stub",
        command: "gemini"
      },
      codexExec: {
        command: "node -e \"require('fs').writeFileSync('backend.txt','ok')\""
      }
    },
    locks: {
      ttl_ms: 20000,
      heartbeat_ms: 5000,
      takeover_grace_ms: 2000
    },
    denylist_substrings: ["rm -rf /", "git reset --hard", "git clean -fdx"]
  } as Record<string, unknown>;

  const merged = {
    ...config,
    ...configPatch,
    adapters: {
      ...(config.adapters as Record<string, unknown>),
      ...((configPatch.adapters as Record<string, unknown>) || {})
    },
    checks: {
      ...(config.checks as Record<string, unknown>),
      ...((configPatch.checks as Record<string, unknown>) || {})
    },
    require_changes: {
      ...(config.require_changes as Record<string, unknown>),
      ...((configPatch.require_changes as Record<string, unknown>) || {})
    },
    locks: {
      ...(config.locks as Record<string, unknown>),
      ...((configPatch.locks as Record<string, unknown>) || {})
    }
  };

  await fs.writeFile(path.join(synapseDir, "config.json"), JSON.stringify(merged, null, 2) + "\n", "utf8");
}
