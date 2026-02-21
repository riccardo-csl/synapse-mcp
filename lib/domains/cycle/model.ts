export function idleState(config, updatedAt) {
  return {
    active: false,
    cycle_id: null,
    feature: null,
    phase: null,
    active_role: null,
    mode: config.mode,
    created_at: null,
    updated_at: updatedAt,
    handoff_status: {
      codex: "empty",
      gemini: "empty"
    }
  };
}
