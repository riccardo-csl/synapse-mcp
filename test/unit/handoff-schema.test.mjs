import test from "node:test";
import assert from "node:assert/strict";

import { expectedActors, validatePayload } from "../../lib/domains/handoff/schema.js";

const state = {
  cycle_id: "20260220T031000Z_featureX",
  feature: "featureX"
};

function basePayload() {
  return {
    cycle_id: state.cycle_id,
    feature: state.feature,
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

test("expectedActors returns producer/consumer mapping", () => {
  assert.deepEqual(expectedActors("codex"), { producer: "gemini", consumer: "codex" });
  assert.deepEqual(expectedActors("gemini"), { producer: "codex", consumer: "gemini" });
});

test("validatePayload accepts valid payload for target", () => {
  assert.doesNotThrow(() => validatePayload(basePayload(), "codex", state));
});

test("validatePayload rejects producer mismatch", () => {
  const payload = basePayload();
  payload.producer = "codex";

  assert.throws(
    () => validatePayload(payload, "codex", state),
    (err) => err.code === "SCHEMA_INVALID" && /producer/.test(err.message)
  );
});

test("validatePayload rejects malformed endpoint entries", () => {
  const payload = basePayload();
  payload.endpoints = [{ method: "GET" }];

  assert.throws(
    () => validatePayload(payload, "codex", state),
    (err) => err.code === "SCHEMA_INVALID"
  );
});

test("validatePayload rejects cycle mismatch", () => {
  const payload = basePayload();
  payload.cycle_id = "wrong";

  assert.throws(
    () => validatePayload(payload, "codex", state),
    (err) => err.code === "SCHEMA_INVALID" && /cycle_id/.test(err.message)
  );
});
