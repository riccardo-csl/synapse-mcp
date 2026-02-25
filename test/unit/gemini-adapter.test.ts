import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";

import { runGeminiPhase } from "../../lib/runner/adapters/gemini.js";
import { createCycleSpec } from "../../lib/synapse/stateMachine.js";
import type { RunnerConfig } from "../../lib/synapse/types.js";
import { cleanupDir, createTempRepo } from "../helpers/synapse-fixtures.js";

function baseConfig(
  command: string,
  requireMarker = false,
  geminiOverrides: Partial<RunnerConfig["adapters"]["gemini"]> = {}
): RunnerConfig {
  return {
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
        mode: "cli",
        command,
        require_marker: requireMarker,
        max_output_bytes: 1_000_000,
        max_patch_bytes: 500_000,
        max_file_ops: 100,
        max_file_op_bytes: 300_000,
        repair_retry_on_invalid_output: false,
        max_repair_attempts: 1,
        stream_output_to_runner: false,
        stream_output_to_synapse_logs: false,
        ...geminiOverrides
      }
    },
    locks: {
      ttl_ms: 20000,
      heartbeat_ms: 5000,
      takeover_grace_ms: 2000,
      pid_liveness_check: true
    },
    cancellation: {
      term_grace_ms: 1500
    },
    denylist_substrings: []
  };
}

test("Gemini adapter rejects non-JSON output", async () => {
  const repoRoot = await createTempRepo("synapse-gemini-parse-");
  try {
    const cycle = createCycleSpec({
      request: "Build frontend",
      repo_root: repoRoot,
      constraints: [],
      phases: ["FRONTEND"]
    });

    await assert.rejects(
      () => runGeminiPhase(cycle, cycle.phases[0], baseConfig("node -e \"console.log('not-json')\"")),
      (err: any) => err?.code === "ADAPTER_OUTPUT_PARSE_FAILED"
    );
  } finally {
    await cleanupDir(repoRoot);
  }
});

test("Gemini adapter validates schema for output payload", async () => {
  const repoRoot = await createTempRepo("synapse-gemini-schema-");
  try {
    const cycle = createCycleSpec({
      request: "Build frontend",
      repo_root: repoRoot,
      constraints: [],
      phases: ["FRONTEND"]
    });

    const output = JSON.stringify({ file_ops: [{ path: "x.ts", action: "write" }] });
    await assert.rejects(
      () => runGeminiPhase(cycle, cycle.phases[0], baseConfig(`node -e ${JSON.stringify(`console.log(${JSON.stringify(output)})`)}`)),
      (err: any) => err?.code === "ADAPTER_OUTPUT_INVALID"
    );
  } finally {
    await cleanupDir(repoRoot);
  }
});

test("Gemini adapter uses final marked payload when debug JSON is present", async () => {
  const repoRoot = await createTempRepo("synapse-gemini-marker-");
  try {
    const cycle = createCycleSpec({
      request: "Build frontend",
      repo_root: repoRoot,
      constraints: [],
      phases: ["FRONTEND"]
    });

    const payload = {
      file_ops: [{ path: "ui/result.txt", action: "write", content: "ok" }],
      report: { source: "marker" }
    };
    const script = [
      "console.log(JSON.stringify({debug:true, note:'example'}));",
      `console.log(${JSON.stringify(`SYNAPSE_RESULT_JSON: ${JSON.stringify(payload)}`)});`
    ].join(" ");
    const command = `node -e ${JSON.stringify(script)}`;

    const result = await runGeminiPhase(cycle, cycle.phases[0], baseConfig(command));
    assert.equal((result.report as any).source, "marker");

    const written = await fs.readFile(path.join(repoRoot, "ui/result.txt"), "utf8");
    assert.equal(written, "ok");
  } finally {
    await cleanupDir(repoRoot);
  }
});

test("Gemini adapter requires marker in strict mode", async () => {
  const repoRoot = await createTempRepo("synapse-gemini-require-marker-");
  try {
    const cycle = createCycleSpec({
      request: "Build frontend",
      repo_root: repoRoot,
      constraints: [],
      phases: ["FRONTEND"]
    });

    const payload = { file_ops: [{ path: "ui/x.txt", action: "write", content: "ok" }] };
    const command = `node -e ${JSON.stringify(`console.log(${JSON.stringify(JSON.stringify(payload))})`)}`;
    await assert.rejects(
      () => runGeminiPhase(cycle, cycle.phases[0], baseConfig(command, true)),
      (err: any) => err?.code === "ADAPTER_OUTPUT_PARSE_FAILED"
    );
  } finally {
    await cleanupDir(repoRoot);
  }
});

test("Gemini adapter supports BEGIN/END structured markers", async () => {
  const repoRoot = await createTempRepo("synapse-gemini-block-marker-");
  try {
    const cycle = createCycleSpec({
      request: "Build frontend",
      repo_root: repoRoot,
      constraints: [],
      phases: ["FRONTEND"]
    });

    const payload = {
      file_ops: [{ path: "ui/block.txt", action: "write", content: "block" }],
      report: { source: "block" }
    };
    const script = [
      "console.log('debug line');",
      `console.log(${JSON.stringify("SYNAPSE_RESULT_JSON_BEGIN")});`,
      `console.log(${JSON.stringify(JSON.stringify(payload))});`,
      `console.log(${JSON.stringify("SYNAPSE_RESULT_JSON_END")});`
    ].join(" ");
    const command = `node -e ${JSON.stringify(script)}`;

    const result = await runGeminiPhase(cycle, cycle.phases[0], baseConfig(command, true));
    assert.equal((result.report as any).source, "block");
    assert.equal(await fs.readFile(path.join(repoRoot, "ui/block.txt"), "utf8"), "block");
  } finally {
    await cleanupDir(repoRoot);
  }
});

test("Gemini adapter rejects duplicate file_ops for the same path", async () => {
  const repoRoot = await createTempRepo("synapse-gemini-duplicate-fileops-");
  try {
    const cycle = createCycleSpec({
      request: "Build frontend",
      repo_root: repoRoot,
      constraints: [],
      phases: ["FRONTEND"]
    });

    const payload = {
      file_ops: [
        { path: "ui/dup.txt", action: "write", content: "a" },
        { path: "ui/dup.txt", action: "write", content: "b" }
      ]
    };
    const script = `console.log(${JSON.stringify(`SYNAPSE_RESULT_JSON: ${JSON.stringify(payload)}`)});`;
    const command = `node -e ${JSON.stringify(script)}`;

    await assert.rejects(
      () => runGeminiPhase(cycle, cycle.phases[0], baseConfig(command)),
      (err: any) => err?.code === "ADAPTER_OUTPUT_INVALID"
    );
  } finally {
    await cleanupDir(repoRoot);
  }
});

test("Gemini adapter enforces max_file_ops limit", async () => {
  const repoRoot = await createTempRepo("synapse-gemini-fileops-limit-");
  try {
    const cycle = createCycleSpec({
      request: "Build frontend",
      repo_root: repoRoot,
      constraints: [],
      phases: ["FRONTEND"]
    });

    const payload = {
      file_ops: [
        { path: "ui/a.txt", action: "write", content: "a" },
        { path: "ui/b.txt", action: "write", content: "b" }
      ]
    };
    const command = `node -e ${JSON.stringify(`console.log(${JSON.stringify(`SYNAPSE_RESULT_JSON: ${JSON.stringify(payload)}`)})`)}`;

    await assert.rejects(
      () => runGeminiPhase(cycle, cycle.phases[0], baseConfig(command, false, { max_file_ops: 1 })),
      (err: any) => err?.code === "ADAPTER_OUTPUT_INVALID"
    );
  } finally {
    await cleanupDir(repoRoot);
  }
});

test("Gemini adapter can repair invalid first output with one retry", async () => {
  const repoRoot = await createTempRepo("synapse-gemini-repair-retry-");
  try {
    const cycle = createCycleSpec({
      request: "Build frontend",
      repo_root: repoRoot,
      constraints: [],
      phases: ["FRONTEND"]
    });

    const script = [
      "const fs=require('fs');",
      "const f='.synapse-gemini-repair-flag';",
      "if (!fs.existsSync(f)) {",
      "  fs.writeFileSync(f,'1');",
      "  console.log('not-json');",
      "} else {",
      "  const payload={file_ops:[{path:'ui/repaired.txt',action:'write',content:'ok'}],report:{repaired:true}};",
      "  console.log('SYNAPSE_RESULT_JSON: '+JSON.stringify(payload));",
      "}"
    ].join(" ");
    const command = `node -e ${JSON.stringify(script)}`;

    const result = await runGeminiPhase(cycle, cycle.phases[0], baseConfig(command, false, {
      repair_retry_on_invalid_output: true,
      max_repair_attempts: 1
    }));

    assert.equal((result.report as any).repaired, true);
    assert.equal((result.report as any).repair_attempts, 1);
    assert.equal(await fs.readFile(path.join(repoRoot, "ui/repaired.txt"), "utf8"), "ok");
    assert.equal(result.commands_run.length, 2);
  } finally {
    await cleanupDir(repoRoot);
  }
});

test("Gemini adapter repair prompt is shell-safe when previous stdout contains backticks and ${...}", async () => {
  const repoRoot = await createTempRepo("synapse-gemini-repair-shellsafe-");
  try {
    const cycle = createCycleSpec({
      request: "Build frontend",
      repo_root: repoRoot,
      constraints: [],
      phases: ["FRONTEND"]
    });

    const script = [
      "const fs=require('fs');",
      "const path=require('path');",
      "const f='.synapse-gemini-repair-shellsafe-flag';",
      "const prompt=process.argv.slice(1).join(' ');",
      "if (!fs.existsSync(f)) {",
      "  fs.writeFileSync(f,'1');",
      "  console.log('I used `replace` and saw template `${statusColor}` in JSX.');",
      "  console.log('SYNAPSE_RESULT_JSON_BEGIN');",
      "  console.log(JSON.stringify({ report: { summary: 'missing payload mode' }, frontend_tweak_required: false }));",
      "  console.log('SYNAPSE_RESULT_JSON_END');",
      "} else {",
      "  if (!prompt.includes('Previous output failed Synapse validation')) process.exit(9);",
      "  if (!prompt.includes('`replace`')) process.exit(10);",
      "  if (!prompt.includes('${statusColor}')) process.exit(11);",
      "  const payload={file_ops:[{path:'ui/shellsafe-repair.txt',action:'write',content:'ok'}],report:{repaired:true}};",
      "  console.log('SYNAPSE_RESULT_JSON: '+JSON.stringify(payload));",
      "}"
    ].join(" ");
    const command = `node -e ${JSON.stringify(script)}`;

    const result = await runGeminiPhase(cycle, cycle.phases[0], baseConfig(command, true, {
      repair_retry_on_invalid_output: true,
      max_repair_attempts: 1
    }));

    assert.equal((result.report as any).repaired, true);
    assert.equal((result.report as any).repair_attempts, 1);
    assert.equal(await fs.readFile(path.join(repoRoot, "ui/shellsafe-repair.txt"), "utf8"), "ok");
    assert.equal(result.commands_run.length, 2);
  } finally {
    await cleanupDir(repoRoot);
  }
});

test("Gemini adapter can stream visible output to runner terminal when enabled", async () => {
  const repoRoot = await createTempRepo("synapse-gemini-stream-runner-");
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const captured: string[] = [];
  (process.stdout.write as any) = ((chunk: any, ...args: any[]) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    const cycle = createCycleSpec({
      request: "Build frontend",
      repo_root: repoRoot,
      constraints: [],
      phases: ["FRONTEND"]
    });

    const payload = {
      file_ops: [{ path: "ui/stream.txt", action: "write", content: "ok" }],
      report: { source: "stream-test" }
    };
    const script = [
      "console.log('gemini-visible-step');",
      `console.log(${JSON.stringify(`SYNAPSE_RESULT_JSON: ${JSON.stringify(payload)}`)});`
    ].join(" ");
    const command = `node -e ${JSON.stringify(script)}`;

    const result = await runGeminiPhase(cycle, cycle.phases[0], baseConfig(command, false, {
      stream_output_to_runner: true
    }));

    assert.equal((result.report as any).source, "stream-test");
    assert.equal(captured.some((s) => s.includes("gemini-visible-step")), true);
  } finally {
    process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
    await cleanupDir(repoRoot);
  }
});

test("Gemini adapter classifies provider capacity exhaustion as ADAPTER_CAPACITY_EXHAUSTED", async () => {
  const repoRoot = await createTempRepo("synapse-gemini-capacity-");
  try {
    const cycle = createCycleSpec({
      request: "Build frontend",
      repo_root: repoRoot,
      constraints: [],
      phases: ["FRONTEND"]
    });

    const script = [
      "console.error('status: 429');",
      "console.error('RESOURCE_EXHAUSTED');",
      "console.error('MODEL_CAPACITY_EXHAUSTED');",
      "console.error('{\"model\":\"gemini-3-pro-preview\"}');",
      "process.exit(1);"
    ].join(" ");
    const command = `node -e ${JSON.stringify(script)}`;

    await assert.rejects(
      () => runGeminiPhase(cycle, cycle.phases[0], baseConfig(command)),
      (err: any) =>
        err?.code === "ADAPTER_CAPACITY_EXHAUSTED"
        && err?.details?.model === "gemini-3-pro-preview"
        && err?.details?.recommended_action === "retry_later_or_switch_model"
    );
  } finally {
    await cleanupDir(repoRoot);
  }
});
