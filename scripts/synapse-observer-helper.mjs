#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const TERMINAL = new Set(["DONE", "FAILED", "CANCELED"]);

function parseArgs(argv) {
  const args = {
    repoRoot: process.cwd(),
    cycleId: null,
    mode: "live-watch",
    latestAny: false,
    json: false
  };

  for (const arg of argv) {
    if (arg === "--json") args.json = true;
    else if (arg === "--latest-any") args.latestAny = true;
    else if (arg.startsWith("--repo-root=")) args.repoRoot = path.resolve(arg.slice("--repo-root=".length));
    else if (arg.startsWith("--cycle-id=")) args.cycleId = arg.slice("--cycle-id=".length);
    else if (arg.startsWith("--mode=")) args.mode = arg.slice("--mode=".length);
    else if (arg === "-h" || arg === "--help") args.help = true;
    else args.unknown = (args.unknown || []).concat(arg);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/synapse-observer-helper.mjs [options]",
    "",
    "Options:",
    "  --repo-root=/path        Repo containing .synapse state (default: cwd)",
    "  --cycle-id=<id>          Inspect this exact cycle",
    "  --latest-any             Select latest cycle even if terminal",
    "  --mode=<mode>            live-watch | postmortem | baseline (default: live-watch)",
    "  --json                   Emit machine-readable JSON",
    "  -h, --help               Show help",
    "",
    "Examples:",
    "  node scripts/synapse-observer-helper.mjs",
    "  node scripts/synapse-observer-helper.mjs --latest-any --mode=postmortem",
    "  node scripts/synapse-observer-helper.mjs --cycle-id=cycle_123 --json"
  ].join("\n");
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function loadCycles(repoRoot) {
  const cyclesDir = path.join(repoRoot, ".synapse", "cycles");
  let names = [];
  try {
    names = await fs.readdir(cyclesDir);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { cycles: [], warnings: [`No .synapse/cycles directory at ${cyclesDir}`] };
    }
    throw err;
  }

  const warnings = [];
  const cycles = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(cyclesDir, name);
    try {
      const cycle = await readJson(filePath);
      cycles.push(cycle);
    } catch (err) {
      warnings.push(`Failed to parse ${name}: ${err.message || String(err)}`);
    }
  }

  cycles.sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));
  return { cycles, warnings };
}

function pickCycle(cycles, { cycleId, latestAny }) {
  if (cycleId) {
    return cycles.find((c) => c.id === cycleId) || null;
  }
  if (latestAny) {
    return cycles[0] || null;
  }
  return cycles.find((c) => !TERMINAL.has(c.status)) || null;
}

function summarizePhase(cycle) {
  if (!cycle || typeof cycle.current_phase_index !== "number") {
    return null;
  }
  const phase = Array.isArray(cycle.phases) ? cycle.phases[cycle.current_phase_index] : null;
  if (!phase) return null;
  return {
    id: phase.id,
    type: phase.type,
    status: phase.status,
    attempt_count: phase.attempt_count,
    max_attempts: phase.max_attempts
  };
}

function buildChecklist(mode, cycle) {
  const cycleId = cycle?.id || "<cycle_id>";
  const lines = [];

  if (mode === "baseline") {
    lines.push("1. Run `synapse-runner doctor` and note warnings.");
    lines.push("2. Run `synapse-runner health` to confirm runner process health.");
    lines.push("3. Check `.synapse/config.json` for strict markers / limits settings.");
    return lines;
  }

  lines.push(`1. Target cycle: \`${cycleId}\`.`);
  lines.push(`2. Call \`synapse.status\` for \`${cycleId}\`.`);
  if (mode === "live-watch") {
    lines.push("3. Poll `synapse.status` at a reasonable interval and track phase transitions.");
    lines.push("4. Only call `synapse.logs` when failures/retries/stalls appear.");
    lines.push(`5. If terminal, run \`synapse-runner report ${cycleId}\` and produce findings.`);
  } else {
    lines.push(`3. Run \`synapse-runner report ${cycleId}\`.`);
    lines.push("4. Pull `synapse.logs` (tail first, then expand if needed).");
    lines.push("5. Produce postmortem: findings -> evidence -> smallest fix -> regression test.");
  }
  return lines;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  if (args.unknown?.length) {
    console.error(`Unknown arguments: ${args.unknown.join(" ")}`);
    console.error(usage());
    process.exit(2);
  }

  const { cycles, warnings } = await loadCycles(args.repoRoot);
  const target = pickCycle(cycles, args);

  const payload = {
    repo_root: args.repoRoot,
    mode: args.mode,
    cycle_count: cycles.length,
    warnings,
    selected_cycle: target
      ? {
          id: target.id,
          status: target.status,
          created_at: target.created_at ?? null,
          updated_at: target.updated_at ?? null,
          current_phase_index: target.current_phase_index ?? null,
          current_phase: summarizePhase(target),
          last_error: target.last_error ?? null,
          canceled_reason: target.canceled_reason ?? null
        }
      : null,
    checklist: buildChecklist(args.mode, target)
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("Synapse Observer Helper");
  console.log(`Repo: ${payload.repo_root}`);
  console.log(`Mode: ${payload.mode}`);
  console.log(`Cycles found: ${payload.cycle_count}`);
  if (warnings.length) {
    console.log("Warnings:");
    for (const w of warnings) console.log(`- ${w}`);
  }

  if (!target) {
    console.log("");
    console.log("No matching cycle found.");
    console.log("Tips:");
    console.log("- Use `--latest-any` to inspect the most recent terminal cycle.");
    console.log("- Use `--cycle-id=<id>` to target a specific cycle.");
    return;
  }

  console.log("");
  console.log("Selected Cycle");
  console.log(`- id: ${payload.selected_cycle.id}`);
  console.log(`- status: ${payload.selected_cycle.status}`);
  console.log(`- updated_at: ${payload.selected_cycle.updated_at}`);
  if (payload.selected_cycle.current_phase) {
    const p = payload.selected_cycle.current_phase;
    console.log(`- phase: ${p.type} (${p.status}) attempt ${p.attempt_count}/${p.max_attempts}`);
  }
  if (payload.selected_cycle.last_error) {
    console.log(`- last_error: ${payload.selected_cycle.last_error.code}: ${payload.selected_cycle.last_error.message}`);
  }

  console.log("");
  console.log("Observer Checklist");
  for (const line of payload.checklist) console.log(line);

  console.log("");
  console.log("Suggested report template:");
  console.log("- diagnostics/templates/SYNAPSE_OBSERVER_REPORT_TEMPLATE.md");
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
