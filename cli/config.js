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
  if (env.TELEBROWSER_PROJECT) {
    if (!PROJECT_RE.test(env.TELEBROWSER_PROJECT)) throw new Error(`invalid TELEBROWSER_PROJECT: ${env.TELEBROWSER_PROJECT}`);
    return env.TELEBROWSER_PROJECT;
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
  if (env.TELEBROWSER_SECRET) return env.TELEBROWSER_SECRET.trim();
  const file = env.TELEBROWSER_SECRET_FILE || join(configDir(env), "secret");
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    throw new Error(`no telebrowser secret: set TELEBROWSER_SECRET or create ${file}`);
  }
}

function configDir(env) {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "telebrowser");
}

/** Gateway URL: TELEBROWSER_URL, else ~/.config/telebrowser/url, else http://127.0.0.1:5858. */
export function gatewayUrl(env = process.env) {
  let url = env.TELEBROWSER_URL;
  if (!url) {
    try {
      url = readFileSync(join(configDir(env), "url"), "utf8").trim();
    } catch {
      url = "";
    }
  }
  return (url || "http://127.0.0.1:5858").replace(/\/+$/, "");
}

export function loadConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const project = resolveProject(cwd, env);
  const baseUrl = gatewayUrl(env);
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
  if (!res.ok) {
    const hint = data.error ? "" : ` (no telebrowser gateway at ${cfg.baseUrl}? set TELEBROWSER_URL or ~/.config/telebrowser/url)`;
    throw new Error(`gateway ${op}: ${res.status} ${data.error || ""}${hint}`.replace(/ +/g, " ").trim());
  }
  return data;
}
