// Launcher configuration: which project we are in, the gateway URL, and our token.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { makeToken, toProjectName, PROJECT_RE } from "../lib/token.js";

function git(cwd, ...args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * The project for a directory: the main checkout's directory name, so every worktree of a
 * repository shares one browser. Outside a repository: `scratch` (wiped when it stops).
 */
export function resolveProject(cwd = process.cwd(), env = process.env) {
  if (env.AGENT_BROWSER_PROJECT) {
    if (!PROJECT_RE.test(env.AGENT_BROWSER_PROJECT)) throw new Error(`invalid AGENT_BROWSER_PROJECT: ${env.AGENT_BROWSER_PROJECT}`);
    return env.AGENT_BROWSER_PROJECT;
  }
  const rel = git(cwd, "rev-parse", "--git-common-dir");
  if (!rel) return "scratch";
  const common = resolve(cwd, rel);
  // <main>/.git for normal repos and their worktrees; something else for submodules
  // (<super>/.git/modules/<name>) and bare repos, where the top level names it instead.
  const dir = basename(common) === ".git" ? dirname(common) : git(cwd, "rev-parse", "--show-toplevel") || common;
  return toProjectName(basename(dir)) || "scratch";
}

export function readSecret(env = process.env) {
  if (env.AGENT_BROWSER_SECRET) return env.AGENT_BROWSER_SECRET.trim();
  const file = env.AGENT_BROWSER_SECRET_FILE || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agent-browser", "secret");
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    throw new Error(`no agent-browser secret: set AGENT_BROWSER_SECRET or create ${file}`);
  }
}

export function loadConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const project = resolveProject(cwd, env);
  const baseUrl = (env.AGENT_BROWSER_URL || "http://127.0.0.1:5858").replace(/\/+$/, "");
  const token = makeToken(readSecret(env), project);
  const wsBase = baseUrl.replace(/^http/, "ws");
  return {
    project,
    baseUrl,
    token,
    /** Browser-level CDP endpoint with the token in the path (no headers needed). */
    wsEndpoint: `${wsBase}/t/${token}/devtools/browser`,
    /** HTTP base for /json/* with the token in the path (puppeteer browserURL style). */
    httpEndpoint: `${baseUrl}/t/${token}`,
  };
}

export async function api(cfg, op, { method = "POST", body } = {}) {
  const res = await fetch(`${cfg.baseUrl}/v1/${op}`, {
    method,
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : method === "POST" ? "{}" : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`gateway ${op}: ${res.status} ${data.error || ""}`.trim());
  return data;
}
