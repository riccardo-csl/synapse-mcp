#!/usr/bin/env node
import { doctor, health, runCycle, startRunner } from "./lib/runner/index.js";

function parseFlag(args: string[], name: string): string | undefined {
  const full = `--${name}=`;
  const found = args.find((arg) => arg.startsWith(full));
  return found ? found.slice(full.length) : undefined;
}

async function main() {
  const [, , command, ...rest] = process.argv;

  if (command === "start") {
    const once = rest.includes("--once");
    const pollMsRaw = parseFlag(rest, "poll-ms");
    const repoRoot = parseFlag(rest, "repo-root");
    const pollMs = pollMsRaw ? Number(pollMsRaw) : undefined;
    await startRunner({ once, pollMs, repoRoot });
    return;
  }

  if (command === "run") {
    const cycleId = rest[0];
    if (!cycleId) {
      throw new Error("Usage: synapse-runner run <cycle_id> [--repo-root=/path]");
    }
    const repoRoot = parseFlag(rest.slice(1), "repo-root");
    await runCycle(cycleId, repoRoot);
    return;
  }

  if (command === "doctor") {
    const repoRoot = parseFlag(rest, "repo-root");
    const report = await doctor(repoRoot);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (command === "health") {
    const repoRoot = parseFlag(rest, "repo-root");
    const report = await health(repoRoot);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  throw new Error(
    "Usage:\n"
      + "  synapse-runner start [--once] [--poll-ms=500] [--repo-root=/path]\n"
      + "  synapse-runner run <cycle_id> [--repo-root=/path]\n"
      + "  synapse-runner doctor [--repo-root=/path]\n"
      + "  synapse-runner health [--repo-root=/path]"
  );
}

main().catch((err: any) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
