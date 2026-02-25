import test from "node:test";
import assert from "node:assert/strict";

import {
  claimCurrentPhase,
  completeManualPhase,
  createCycleSpec,
  failManualPhase,
  markClaimedPhaseRunning,
  markPhaseDone,
  markPhaseFailed,
  startManualPhase
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
    phases: ["FRONTEND"]
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

  const started = startManualPhase(cycle, cycle.phases[0].id);
  assert.equal(cycle.phases[started.phaseIndex].claimed_by, "orchestrator");
  completeManualPhase(
    cycle,
    cycle.phases[0].id,
    { frontend_tweak_required: false },
    { report: {}, commands_run: [], frontend_tweak_required: false }
  );

  assert.equal(cycle.phases[1].status, "SKIPPED");
  assert.equal(cycle.status, "DONE");
});

test("claimCurrentPhase reclaims stale running phase", () => {
  const cycle = createCycleSpec({
    request: "recover",
    repo_root: "/tmp/repo",
    constraints: [],
    phases: ["FRONTEND"]
  });

  cycle.status = "RUNNING";
  cycle.current_phase_index = 0;
  cycle.phases[0].status = "RUNNING";
  cycle.phases[0].claim_token = "dead";
  cycle.phases[0].claimed_by = "runner-old";
  cycle.phases[0].started_at = new Date(Date.now() - 120_000).toISOString();

  const claim = claimCurrentPhase(cycle, "runner-new", { reclaim_stale_ms: 1_000 });
  assert.ok(claim);
  assert.equal(cycle.phases[0].status, "CLAIMED");
  assert.equal(cycle.phases[0].claimed_by, "runner-new");
});

test("manual backend phase can fail terminally via orchestrator", () => {
  const cycle = createCycleSpec({
    request: "manual backend fail",
    repo_root: "/tmp/repo",
    constraints: [],
    phases: ["BACKEND"]
  });

  startManualPhase(cycle, cycle.phases[0].id, "starting backend work");
  failManualPhase(cycle, cycle.phases[0].id, {
    code: "BACKEND_IMPL_FAILED",
    message: "could not complete backend",
    details: { source: "orchestrator" }
  });

  assert.equal(cycle.status, "FAILED");
  assert.equal(cycle.current_phase_index, null);
  assert.equal(cycle.phases[0].status, "FAILED");
  assert.equal(cycle.last_error?.code, "BACKEND_IMPL_FAILED");
});
