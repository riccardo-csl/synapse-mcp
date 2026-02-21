import test from "node:test";
import assert from "node:assert/strict";

import {
  claimCurrentPhase,
  createCycleSpec,
  markClaimedPhaseRunning,
  markPhaseDone,
  markPhaseFailed
} from "../../lib/synapse/stateMachine.js";

test("claimCurrentPhase is idempotent for already-claimed phase", () => {
  const cycle = createCycleSpec({
    request: "build feature",
    repo_root: "/tmp/repo",
    constraints: []
  });

  const first = claimCurrentPhase(cycle, "runner-1");
  assert.ok(first);
  const second = claimCurrentPhase(cycle, "runner-2");
  assert.equal(second, null);
});

test("failed phase retries until max attempts then fails cycle", () => {
  const cycle = createCycleSpec({
    request: "build feature",
    repo_root: "/tmp/repo",
    constraints: [],
    phases: ["BACKEND"]
  });

  const claim1 = claimCurrentPhase(cycle, "runner-1");
  assert.ok(claim1);
  markClaimedPhaseRunning(cycle, claim1!.phaseIndex, claim1!.claimToken);
  markPhaseFailed(cycle, claim1!.phaseIndex, claim1!.claimToken, {
    code: "CHECK_FAILED",
    message: "check failed",
    details: {}
  });
  assert.equal(cycle.phases[0].status, "PENDING");
  assert.equal(cycle.status, "RUNNING");

  const claim2 = claimCurrentPhase(cycle, "runner-1");
  assert.ok(claim2);
  markClaimedPhaseRunning(cycle, claim2!.phaseIndex, claim2!.claimToken);
  markPhaseFailed(cycle, claim2!.phaseIndex, claim2!.claimToken, {
    code: "CHECK_FAILED",
    message: "check failed again",
    details: {}
  });

  assert.equal(cycle.phases[0].status, "FAILED");
  assert.equal(cycle.status, "FAILED");
});

test("backend completion skips frontend_tweak when not required", () => {
  const cycle = createCycleSpec({
    request: "build feature",
    repo_root: "/tmp/repo",
    constraints: [],
    phases: ["BACKEND", "FRONTEND_TWEAK"]
  });

  const claim = claimCurrentPhase(cycle, "runner-1");
  assert.ok(claim);
  markClaimedPhaseRunning(cycle, claim!.phaseIndex, claim!.claimToken);
  markPhaseDone(cycle, claim!.phaseIndex, claim!.claimToken, { ok: true }, { report: {}, commands_run: [] });

  assert.equal(cycle.phases[1].status, "SKIPPED");
  assert.equal(cycle.status, "DONE");
});
