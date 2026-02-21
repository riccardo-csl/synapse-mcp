import path from "node:path";
import { claimNextRunnablePhase, claimPhaseForCycle, executeClaimedPhase } from "./service.js";
import { runShellCommand } from "./command.js";

export interface RunnerStartOptions {
  repoRoot?: string;
  once?: boolean;
  pollMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveRepoRoot(repoRoot?: string): string {
  return path.resolve(repoRoot || process.cwd());
}

export async function startRunner(options: RunnerStartOptions = {}): Promise<void> {
  const repoRoot = resolveRepoRoot(options.repoRoot);
  const once = Boolean(options.once);
  const pollMs = typeof options.pollMs === "number" && options.pollMs > 0 ? options.pollMs : 500;
  const runnerId = `runner-${process.pid}`;

  while (true) {
    const claimed = await claimNextRunnablePhase(repoRoot, runnerId);
    if (!claimed) {
      if (once) {
        return;
      }
      await sleep(pollMs);
      continue;
    }
    await executeClaimedPhase(repoRoot, claimed, runnerId);
  }
}

export async function runCycle(cycleId: string, repoRootArg?: string): Promise<void> {
  const repoRoot = resolveRepoRoot(repoRootArg);
  const runnerId = `runner-${process.pid}`;

  while (true) {
    const claimed = await claimPhaseForCycle(repoRoot, cycleId, runnerId);
    if (!claimed) {
      return;
    }
    await executeClaimedPhase(repoRoot, claimed, runnerId);
  }
}

async function checkCommand(cmd: string, cwd: string): Promise<boolean> {
  const result = await runShellCommand(`command -v ${cmd}`, cwd, 10_000, []);
  return result.code === 0;
}

export async function doctor(repoRootArg?: string): Promise<{
  node: string;
  codex: boolean;
  gemini: boolean;
}> {
  const repoRoot = resolveRepoRoot(repoRootArg);
  const [codex, gemini] = await Promise.all([
    checkCommand("codex", repoRoot),
    checkCommand("gemini", repoRoot)
  ]);

  return {
    node: process.version,
    codex,
    gemini
  };
}
