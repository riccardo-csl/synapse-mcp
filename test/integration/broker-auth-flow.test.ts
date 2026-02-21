import test from "node:test";
import assert from "node:assert/strict";

import {
  cycleStart,
  cycleStatus,
  handoffWrite,
  lockAcquire,
  sessionOpen
} from "../../lib/index.js";
import {
  cleanupSandbox,
  createSandbox,
  geminiPayload,
  writeConfig,
  GEMINI_PSK,
  CODEX_PSK
} from "../helpers/broker-fixtures.js";

test("session auth, spoofing prevention, and lock gating", async () => {
  const baseDir = await createSandbox("mcp-broker-auth-flow-");
  try {
    await writeConfig(baseDir);

    const geminiSession = await sessionOpen({ role: "gemini", psk: GEMINI_PSK }, baseDir);
    const codexSession = await sessionOpen({ role: "codex", psk: CODEX_PSK }, baseDir);
    const started = await cycleStart({ feature: "featureX" }, baseDir);

    const geminiLock = await lockAcquire({ session_token: geminiSession.session_token }, baseDir);
    assert.equal(geminiLock.lock_token, started.lock_token);

    await assert.rejects(
      () => lockAcquire({ session_token: codexSession.session_token }, baseDir),
      (err: any) => err.code === "LOCK_DENIED"
    );

    const writeResult = await handoffWrite(
      {
        target: "codex",
        payload: geminiPayload(started.cycle_id, "featureX"),
        lock_token: geminiLock.lock_token,
        session_token: geminiSession.session_token
      },
      baseDir
    );
    assert.equal(writeResult.phase, "backend");
    assert.equal(writeResult.active_role, "codex");
    assert.equal("lock_token" in writeResult, false);

    const status = await cycleStatus(baseDir);
    assert.equal(status.phase, "backend");
    assert.equal(status.active_role, "codex");
    assert.equal("lock_token" in status.lock, false);

    await assert.rejects(
      () => lockAcquire({ session_token: geminiSession.session_token }, baseDir),
      (err: any) => err.code === "LOCK_DENIED"
    );

    const codexLock = await lockAcquire({ session_token: codexSession.session_token }, baseDir);
    assert.equal(codexLock.role, "codex");

    await assert.rejects(
      () =>
        handoffWrite(
          {
            target: "gemini",
            payload: {
              ...geminiPayload(started.cycle_id, "featureX"),
              producer: "codex",
              consumer: "gemini"
            },
            lock_token: codexLock.lock_token,
            session_token: geminiSession.session_token
          },
          baseDir
        ),
      (err: any) => err.code === "LOCK_DENIED"
    );

    await assert.rejects(
      () =>
        handoffWrite(
          {
            target: "gemini",
            payload: {
              ...geminiPayload(started.cycle_id, "featureX"),
              producer: "codex",
              consumer: "gemini"
            },
            lock_token: started.lock_token,
            session_token: codexSession.session_token
          },
          baseDir
        ),
      (err: any) => err.code === "LOCK_DENIED"
    );
  } finally {
    await cleanupSandbox(baseDir);
  }
});

test("session.open rejects wrong credentials", async () => {
  const baseDir = await createSandbox("mcp-broker-auth-fail-");
  try {
    await writeConfig(baseDir);
    await assert.rejects(
      () => sessionOpen({ role: "gemini", psk: "WRONG" }, baseDir),
      (err: any) => err.code === "AUTH_FAILED"
    );
  } finally {
    await cleanupSandbox(baseDir);
  }
});
