import path from "path";
import test from "node:test";
import assert from "node:assert/strict";
import { access } from "fs/promises";

import {
  cycleArchive,
  cycleComplete,
  cycleStart,
  cycleStatus,
  handoffRead,
  handoffWrite,
  lockAcquire,
  sessionOpen
} from "../../lib/index.js";
import {
  cleanupSandbox,
  codexPayload,
  createSandbox,
  geminiPayload,
  writeConfig,
  GEMINI_PSK,
  CODEX_PSK
} from "../helpers/broker-fixtures.mjs";

test("full cycle lifecycle supports rework loop and archive continuity", async () => {
  const baseDir = await createSandbox("mcp-broker-lifecycle-");
  try {
    await writeConfig(baseDir);

    const geminiSession = await sessionOpen({ role: "gemini", psk: GEMINI_PSK }, baseDir);
    const codexSession = await sessionOpen({ role: "codex", psk: CODEX_PSK }, baseDir);
    const started = await cycleStart({ feature: "featureX" }, baseDir);

    const geminiLock = await lockAcquire({ session_token: geminiSession.session_token }, baseDir);
    await handoffWrite(
      {
        target: "codex",
        payload: geminiPayload(started.cycle_id, "featureX"),
        lock_token: geminiLock.lock_token,
        session_token: geminiSession.session_token
      },
      baseDir
    );

    let status = await cycleStatus(baseDir);
    assert.equal(status.phase, "backend");
    assert.equal(status.active_role, "codex");

    const codexLock = await lockAcquire({ session_token: codexSession.session_token }, baseDir);
    await handoffWrite(
      {
        target: "gemini",
        payload: codexPayload(started.cycle_id, "featureX"),
        lock_token: codexLock.lock_token,
        session_token: codexSession.session_token
      },
      baseDir
    );

    status = await cycleStatus(baseDir);
    assert.equal(status.phase, "frontend_refine");
    assert.equal(status.active_role, "gemini");

    const geminiLock2 = await lockAcquire({ session_token: geminiSession.session_token }, baseDir);
    await handoffWrite(
      {
        target: "codex",
        payload: geminiPayload(started.cycle_id, "featureX"),
        lock_token: geminiLock2.lock_token,
        session_token: geminiSession.session_token
      },
      baseDir
    );

    status = await cycleStatus(baseDir);
    assert.equal(status.phase, "backend");
    assert.equal(status.active_role, "codex");

    const codexLock2 = await lockAcquire({ session_token: codexSession.session_token }, baseDir);
    await handoffWrite(
      {
        target: "gemini",
        payload: codexPayload(started.cycle_id, "featureX"),
        lock_token: codexLock2.lock_token,
        session_token: codexSession.session_token
      },
      baseDir
    );

    const geminiLock3 = await lockAcquire({ session_token: geminiSession.session_token }, baseDir);
    await cycleComplete(
      {
        lock_token: geminiLock3.lock_token,
        session_token: geminiSession.session_token
      },
      baseDir
    );

    status = await cycleStatus(baseDir);
    assert.equal(status.phase, "complete");
    assert.equal(status.active_role, "gemini");

    const geminiLock4 = await lockAcquire({ session_token: geminiSession.session_token }, baseDir);
    await cycleArchive(
      {
        lock_token: geminiLock4.lock_token,
        session_token: geminiSession.session_token
      },
      baseDir
    );

    status = await cycleStatus(baseDir);
    assert.equal(status.phase, null);
    assert.equal(status.active_role, null);

    const codexHandoff = await handoffRead({ target: "codex" }, baseDir);
    const geminiHandoff = await handoffRead({ target: "gemini" }, baseDir);
    assert.deepEqual(codexHandoff, {});
    assert.deepEqual(geminiHandoff, {});

    await access(path.join(baseDir, "archive", started.cycle_id, "manifest.json"));
  } finally {
    await cleanupSandbox(baseDir);
  }
});

test("archive is rejected before completion", async () => {
  const baseDir = await createSandbox("mcp-broker-archive-guard-");
  try {
    await writeConfig(baseDir);
    const geminiSession = await sessionOpen({ role: "gemini", psk: GEMINI_PSK }, baseDir);
    await cycleStart({ feature: "featureX" }, baseDir);
    const geminiLock = await lockAcquire({ session_token: geminiSession.session_token }, baseDir);

    await assert.rejects(
      () =>
        cycleArchive(
          {
            lock_token: geminiLock.lock_token,
            session_token: geminiSession.session_token
          },
          baseDir
        ),
      (err) => err.code === "ARCHIVE_NOT_ALLOWED"
    );
  } finally {
    await cleanupSandbox(baseDir);
  }
});
