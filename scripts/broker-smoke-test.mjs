import { promises as fs } from "fs";
import path from "path";

import {
  cycleStart,
  cycleStatus,
  sessionOpen,
  lockAcquire,
  handoffWrite,
  handoffRead,
  cycleComplete,
  cycleArchive
} from "../lib/broker.js";

const BASE = ".mcp-broker-test";
const GEMINI_PSK = "GEMINI_SECRET";
const CODEX_PSK = "CODEX_SECRET";

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

function assert(cond, msg) {
  if (!cond) {
    throw new Error("ASSERT FAIL: " + msg);
  }
}

function geminiPayload(cycle_id, feature) {
  return {
    cycle_id,
    feature,
    producer: "gemini",
    consumer: "codex",
    files_modified: ["web/components/FeatureX.tsx"],
    endpoints: [{ method: "GET", path: "/api/feature-x" }],
    data_shapes: [],
    assumptions: [],
    todos: [],
    notes: [],
    extras: {}
  };
}

function codexPayload(cycle_id, feature) {
  return {
    cycle_id,
    feature,
    producer: "codex",
    consumer: "gemini",
    files_modified: ["api/feature-x.ts"],
    endpoints: [{ method: "GET", path: "/api/feature-x" }],
    data_shapes: [],
    assumptions: [],
    todos: [],
    notes: [],
    extras: {}
  };
}

async function writeConfig() {
  await fs.mkdir(BASE, { recursive: true });
  const config = {
    version: "0.1",
    mode: "approval",
    validation: "basic",
    storage_path: BASE,
    agents: {
      gemini: { psk: GEMINI_PSK },
      codex: { psk: CODEX_PSK }
    }
  };
  await fs.writeFile(path.join(BASE, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
}

async function main() {
  await rmrf(BASE);
  await writeConfig();

  console.log("0) open sessions");
  const geminiSession = await sessionOpen({ role: "gemini", psk: GEMINI_PSK }, BASE);
  const codexSession = await sessionOpen({ role: "codex", psk: CODEX_PSK }, BASE);

  console.log("1) cycle.start");
  const start = await cycleStart({ feature: "featureX" }, BASE);
  console.log(start);

  let status = await cycleStatus(BASE);
  assert(status.phase === "frontend", "phase should be frontend");
  assert(status.active_role === "gemini", "active_role should be gemini");

  const cycle_id = start.cycle_id;
  const feature = "featureX";
  const geminiToken = start.lock_token;

  console.log("2) active gemini can acquire frontend lock");
  const geminiLock = await lockAcquire({ session_token: geminiSession.session_token }, BASE);
  assert(geminiLock.lock_token === geminiToken, "gemini should reacquire current lock token");

  console.log("2) handoff.write (wrong token) must fail");
  try {
    await handoffWrite({
      target: "codex",
      payload: geminiPayload(cycle_id, feature),
      lock_token: "bad",
      session_token: geminiSession.session_token
    }, BASE);
    throw new Error("Expected failure, got success");
  } catch (e) {
    console.log("OK failed:", e.code || e.message);
  }

  console.log("3) gemini -> codex write (advance to backend)");
  const w1 = await handoffWrite({
    target: "codex",
    payload: geminiPayload(cycle_id, feature),
    lock_token: geminiToken,
    session_token: geminiSession.session_token
  }, BASE);
  assert(!("lock_token" in w1), "handoff.write must not leak lock token");

  console.log("3b) old gemini token must fail after rotation");
  try {
    await handoffWrite({
      target: "gemini",
      payload: codexPayload(cycle_id, feature),
      lock_token: geminiToken,
      session_token: codexSession.session_token
    }, BASE);
    throw new Error("Expected old-token failure, got success");
  } catch (e) {
    assert(e.code === "LOCK_DENIED", "old token should fail with LOCK_DENIED");
    console.log("OK old token rejected:", e.code || e.message);
  }

  console.log("3c) handoff.read must not expose lock token fields");
  const codexHandoffAfterWrite = await handoffRead({ target: "codex" }, BASE);
  assert(!("lock_token" in codexHandoffAfterWrite), "handoff payload must not expose lock_token");
  assert(!("token" in codexHandoffAfterWrite), "handoff payload must not expose token");

  status = await cycleStatus(BASE);
  assert(status.phase === "backend", "phase should be backend");
  assert(status.active_role === "codex", "active_role should be codex");
  assert(!("lock_token" in status.lock), "cycle.status must not expose lock token");

  console.log("3d) active codex can acquire lock");
  const codexToken = (await lockAcquire({ session_token: codexSession.session_token }, BASE)).lock_token;

  console.log("3e) non-active gemini cannot acquire backend lock");
  try {
    await lockAcquire({ session_token: geminiSession.session_token }, BASE);
    throw new Error("Expected gemini lock denial during backend");
  } catch (e) {
    assert(e.code === "LOCK_DENIED", "gemini should be denied during backend phase");
  }

  console.log("3f) backend phase forbids gemini session handoff.write target=gemini");
  try {
    await handoffWrite({
      target: "gemini",
      payload: codexPayload(cycle_id, feature),
      lock_token: codexToken,
      session_token: geminiSession.session_token
    }, BASE);
    throw new Error("Expected backend authorization failure");
  } catch (e) {
    assert(e.code === "LOCK_DENIED" || e.code === "INVALID_PHASE", "backend write should be denied");
  }

  console.log("4) codex -> gemini write (advance to frontend_refine)");
  await handoffWrite({
    target: "gemini",
    payload: codexPayload(cycle_id, feature),
    lock_token: codexToken,
    session_token: codexSession.session_token
  }, BASE);

  status = await cycleStatus(BASE);
  assert(status.phase === "frontend_refine", "phase should be frontend_refine");
  assert(status.active_role === "gemini", "active_role should be gemini");

  const geminiToken2 = (await lockAcquire({ session_token: geminiSession.session_token }, BASE)).lock_token;

  console.log("5) refine -> backend rework loop (gemini writes codex)");
  await handoffWrite({
    target: "codex",
    payload: geminiPayload(cycle_id, feature),
    lock_token: geminiToken2,
    session_token: geminiSession.session_token
  }, BASE);

  status = await cycleStatus(BASE);
  assert(status.phase === "backend", "phase should go back to backend (rework loop)");
  assert(status.active_role === "codex", "active_role should be codex");

  const codexToken2 = (await lockAcquire({ session_token: codexSession.session_token }, BASE)).lock_token;

  console.log("6) codex -> gemini again (back to frontend_refine)");
  await handoffWrite({
    target: "gemini",
    payload: codexPayload(cycle_id, feature),
    lock_token: codexToken2,
    session_token: codexSession.session_token
  }, BASE);

  status = await cycleStatus(BASE);
  assert(status.phase === "frontend_refine", "phase should be frontend_refine again");

  const geminiToken3 = (await lockAcquire({ session_token: geminiSession.session_token }, BASE)).lock_token;

  console.log("7) cycle.complete (gemini only)");
  await cycleComplete({ lock_token: geminiToken3, session_token: geminiSession.session_token }, BASE);

  status = await cycleStatus(BASE);
  assert(status.phase === "complete", "phase should be complete");
  assert(status.active_role === "gemini", "active_role should remain gemini in complete");

  console.log("7b) archive continuity: reacquire lock after complete");
  const geminiToken4 = (await lockAcquire({ session_token: geminiSession.session_token }, BASE)).lock_token;

  console.log("8) cycle.archive (gemini token)");
  await cycleArchive({ lock_token: geminiToken4, session_token: geminiSession.session_token }, BASE);

  status = await cycleStatus(BASE);
  assert(status.phase === null || status.phase === undefined, "after archive, phase should be idle/null");

  const codexHandoff = await handoffRead({ target: "codex" }, BASE);
  assert(Object.keys(codexHandoff).length === 0, "codex handoff should be cleared after archive");

  console.log("ALL TESTS PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
