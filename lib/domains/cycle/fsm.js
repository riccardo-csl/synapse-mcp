import {
  PHASE_BACKEND,
  PHASE_FRONTEND,
  PHASE_FRONTEND_REFINE,
  ROLE_CODEX,
  ROLE_GEMINI
} from "../../core/constants.js";

export function phaseForWrite(phase, target) {
  if (phase === PHASE_FRONTEND && target === ROLE_CODEX) {
    return { nextPhase: PHASE_BACKEND, nextRole: ROLE_CODEX, rotate: true };
  }
  if (phase === PHASE_BACKEND && target === ROLE_GEMINI) {
    return { nextPhase: PHASE_FRONTEND_REFINE, nextRole: ROLE_GEMINI, rotate: true };
  }
  if (phase === PHASE_FRONTEND_REFINE && target === ROLE_CODEX) {
    return { nextPhase: PHASE_BACKEND, nextRole: ROLE_CODEX, rotate: true };
  }
  return null;
}
