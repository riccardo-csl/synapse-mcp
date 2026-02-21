import { DEFAULT_STORAGE } from "../../core/constants.js";

export const DEFAULT_CONFIG = {
  version: "0.1",
  mode: "approval",
  validation: "basic",
  storage_path: DEFAULT_STORAGE,
  agents: {
    gemini: { psk: "" },
    codex: { psk: "" }
  }
};
