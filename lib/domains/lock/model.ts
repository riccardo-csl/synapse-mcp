export function unlockedState() {
  return {
    locked: false,
    role: null,
    lock_token: null,
    cycle_id: null,
    acquired_at: null,
    expires_at: null
  };
}
