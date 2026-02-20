import test from "node:test";
import assert from "node:assert/strict";

import { phaseForWrite } from "../../lib/domains/cycle/fsm.js";
import {
  PHASE_BACKEND,
  PHASE_COMPLETE,
  PHASE_FRONTEND,
  PHASE_FRONTEND_REFINE,
  ROLE_CODEX,
  ROLE_GEMINI
} from "../../lib/core/constants.js";

test("phaseForWrite returns deterministic transitions for valid writes", () => {
  assert.deepEqual(phaseForWrite(PHASE_FRONTEND, ROLE_CODEX), {
    nextPhase: PHASE_BACKEND,
    nextRole: ROLE_CODEX,
    rotate: true
  });

  assert.deepEqual(phaseForWrite(PHASE_BACKEND, ROLE_GEMINI), {
    nextPhase: PHASE_FRONTEND_REFINE,
    nextRole: ROLE_GEMINI,
    rotate: true
  });

  assert.deepEqual(phaseForWrite(PHASE_FRONTEND_REFINE, ROLE_CODEX), {
    nextPhase: PHASE_BACKEND,
    nextRole: ROLE_CODEX,
    rotate: true
  });
});

test("phaseForWrite rejects unsupported phase/target combinations", () => {
  assert.equal(phaseForWrite(PHASE_FRONTEND, ROLE_GEMINI), null);
  assert.equal(phaseForWrite(PHASE_BACKEND, ROLE_CODEX), null);
  assert.equal(phaseForWrite(PHASE_FRONTEND_REFINE, ROLE_GEMINI), null);
  assert.equal(phaseForWrite(PHASE_COMPLETE, ROLE_GEMINI), null);
  assert.equal(phaseForWrite(PHASE_COMPLETE, ROLE_CODEX), null);
});
