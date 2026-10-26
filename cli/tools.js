// The tools telebrowser adds next to chrome-devtools-mcp's.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { api } from "./config.js";

export const TOOLS = [
  {
    name: "browser_handoff",
    title: "Hand the browser to the user",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description:
      "Hand the project's browser to the user for a step only a human can do: signing in, a captcha, 2FA or a passkey prompt, a consent screen. " +
      "Brings this project's window to the front with your current tab selected, keeps the browser alive while they work, and returns the exact message to give the user. " +
      "After calling it, tell the user, then stop and wait for them to say they are done before continuing.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", minLength: 1, maxLength: 2000, description: "What the user should do, e.g. 'sign in to takeout.google.com'." },
        minutes: { type: "integer", minimum: 1, maximum: 1440, description: "How long to keep the browser alive without agent activity (default 60, max 1440)." },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_downloads",
    title: "List project downloads",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      "List files this project's browser has downloaded, newest first, with absolute host paths you can read directly. " +
      "Files ending in .crdownload are still in progress.",
    inputSchema: { type: "object", additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, maximum: 200, description: "Max entries (default 50, maximum 200)." } } },
    outputSchema: { type: "object", required: ["downloadsDir", "files"], properties: { downloadsDir: { type: "string" }, files: { type: "array", maxItems: 200, items: { type: "object", required: ["name", "path", "bytes", "modified", "inProgress"], properties: { name: { type: "string" }, path: { type: "string" }, bytes: { type: "number" }, modified: { type: "string" }, inProgress: { type: "boolean" } } } } } },
  },
  {
    name: "browser_info",
    title: "Inspect project browser",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      "Show this project's browser: project name, window title, human view URL, profile and downloads directories, idle timeout, " +
      "and the CDP endpoint for scripts (long-running download watchers and the like).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

const text = (s) => ({ content: [{ type: "text", text: s }] });
const data = (value) => ({ ...text(JSON.stringify(value, null, 2)), structuredContent: value });

export function validateArguments(name, args = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("arguments must be an object");
  const fields = name === "browser_handoff" ? ["task", "minutes"] : name === "browser_downloads" ? ["limit"] : [];
  if (Object.keys(args).some((key) => !fields.includes(key))) throw new Error("unknown argument");
  if (name === "browser_handoff") {
    if (typeof args.task !== "string" || !args.task.trim() || args.task.length > 2000) throw new Error("task must contain 1–2000 characters");
    if (args.minutes !== undefined && (!Number.isInteger(args.minutes) || args.minutes < 1 || args.minutes > 1440)) throw new Error("minutes must be an integer from 1 to 1440");
  }
  if (name === "browser_downloads" && args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200)) throw new Error("limit must be an integer from 1 to 200");
}

export function listDownloads(dir, limit = 50) {
  validateArguments("browser_downloads", { limit });
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const path = join(dir, name);
      const st = statSync(path, { throwIfNoEntry: false });
      return st?.isFile() ? { name, path, bytes: st.size, modified: st.mtime.toISOString(), inProgress: name.endsWith(".crdownload") } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.modified.localeCompare(a.modified))
    .slice(0, limit);
}

export async function callTool(cfg, name, args = {}) {
  try {
    validateArguments(name, args);
    if (name === "browser_handoff") {
      const minutes = args.minutes ?? 60;
      await api(cfg, "ensure");
      await api(cfg, "hold", { body: { minutes } });
      const st = await api(cfg, "focus", { body: { session: cfg.session } });
      const where = st.viewUrl ? `Open ${st.viewUrl}` : "Open the telebrowser view";
      return text(
        `Tell the user exactly this, then wait for their reply:\n\n` +
          `"${where} (the ${st.project} window is in front, on my tab). ` +
          `Please ${args.task}. Tell me when you are done."\n\n` +
          `The browser stays up for at least ${minutes} minutes without agent activity. ` +
          `Do not drive the page while the user is working in it.` +
          (st.ephemeral ? " Note: this is the scratch profile; it is wiped when it stops, so a sign-in here does not last." : ""),
      );
    }
    if (name === "browser_downloads") {
      const st = await api(cfg, "status", { method: "GET" });
      const files = listDownloads(st.downloadsDir, args.limit ?? 50);
      return data({ downloadsDir: st.downloadsDir, files });
    }
    if (name === "browser_info") {
      const st = await api(cfg, "status", { method: "GET" });
      return data(
          {
            ...st,
            cdp: {
              webSocket: cfg.wsEndpoint,
              http: cfg.httpEndpoint,
              note:
                "Both carry this project's token; keep them out of committed files and logs. " +
                "The WebSocket endpoint is scoped to this session: a script sees only your tabs, and tabs it opens are yours and close when this session ends. " +
                "`telebrowser ws` in a shell gives the unscoped endpoint (every tab in the project).",
              session: cfg.session,
            },
          },
      );
    }
    return { isError: true, ...text(`unknown tool ${name}`) };
  } catch (err) {
    return { isError: true, ...text(`telebrowser: ${err.message}`) };
  }
}
