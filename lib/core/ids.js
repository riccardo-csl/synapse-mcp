import crypto from "crypto";

export function slugifyFeature(feature) {
  return feature
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_-]/g, "");
}

export function randomToken() {
  return crypto.randomBytes(24).toString("hex");
}

export function randomSessionToken() {
  return `sess_${crypto.randomBytes(24).toString("hex")}`;
}
