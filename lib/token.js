// Project names and project tokens, shared by the gateway and the launcher.
//
// A token is "<project>.<hex HMAC-SHA256(secret, 'telebrowser:' + project)>", so the
// gateway needs no token store: it recomputes the MAC for the project the token names.

import { createHmac, timingSafeEqual } from "node:crypto";

export const PROJECT_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/** Normalise a directory basename into a valid project name, or null. */
export function toProjectName(name) {
  const p = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 63)
    .replace(/[._-]+$/, "");
  return PROJECT_RE.test(p) ? p : null;
}

function mac(secret, project) {
  return createHmac("sha256", secret).update(`telebrowser:${project}`).digest("hex");
}

export function makeToken(secret, project) {
  if (!secret || secret.length < 32) throw new Error("telebrowser secret must be at least 32 characters");
  if (!PROJECT_RE.test(project)) throw new Error(`invalid project name: ${project}`);
  return `${project}.${mac(secret, project)}`;
}

/** Return the project a token is valid for, or null. */
export function verifyToken(secret, token) {
  if (typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const project = token.slice(0, dot);
  const given = token.slice(dot + 1);
  if (!PROJECT_RE.test(project) || !/^[0-9a-f]{64}$/.test(given)) return null;
  const want = Buffer.from(mac(secret, project), "hex");
  return timingSafeEqual(want, Buffer.from(given, "hex")) ? project : null;
}
