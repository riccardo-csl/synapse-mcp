#!/usr/bin/env node
import { doctor, followLogs, health, logs, migrate, report, runCycle, startRunner } from "./lib/runner/index.js";

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

  if (command === "migrate") {
    const repoRoot = parseFlag(rest, "repo-root");
    const dryRun = rest.includes("--dry-run");
    const result = await migrate(repoRoot, dryRun);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "report") {
    const cycleId = rest[0];
    if (!cycleId) {
      throw new Error("Usage: synapse-runner report <cycle_id> [--repo-root=/path]");
    }
    const repoRoot = parseFlag(rest.slice(1), "repo-root");
    const result = await report(cycleId, repoRoot);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "logs") {
    const cycleId = rest[0];
    if (!cycleId) {
      throw new Error("Usage: synapse-runner logs <cycle_id> [--tail=N] [--follow] [--poll-ms=1000] [--repo-root=/path]");
    }
    const args = rest.slice(1);
    const repoRoot = parseFlag(args, "repo-root");
    const tailRaw = parseFlag(args, "tail");
    const pollMsRaw = parseFlag(args, "poll-ms");
    const tail = tailRaw ? Number(tailRaw) : undefined;
    const pollMs = pollMsRaw ? Number(pollMsRaw) : undefined;
    const follow = args.includes("--follow");

    if (follow) {
      const summary = await followLogs(cycleId, {
        repoRoot,
        tail,
        pollMs,
        onEntry(entry) {
          const phase = entry.phase_id ? ` ${entry.phase_id}` : "";
          const event = typeof entry.meta?.event === "string" ? ` event=${entry.meta.event}` : "";
          console.log(`[${entry.ts}] ${entry.level}${phase}${event} ${entry.message}`);
        }
      });
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    const result = await logs(cycleId, repoRoot, tail);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(
    "Usage:\n"
      + "  synapse-runner start [--once] [--poll-ms=500] [--repo-root=/path]\n"
      + "  synapse-runner run <cycle_id> [--repo-root=/path]\n"
      + "  synapse-runner doctor [--repo-root=/path]\n"
      + "  synapse-runner health [--repo-root=/path]\n"
      + "  synapse-runner migrate [--dry-run] [--repo-root=/path]\n"
      + "  synapse-runner report <cycle_id> [--repo-root=/path]\n"
      + "  synapse-runner logs <cycle_id> [--tail=N] [--follow] [--poll-ms=1000] [--repo-root=/path]"
  );
}

main().catch((err: any) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
