// The tools telebrowser adds next to chrome-devtools-mcp's.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { api } from "./config.js";

export const TOOLS = [
  {
    name: "browser_handoff",
    description:
      "Hand the project's browser to the user for a step only a human can do: signing in, a captcha, 2FA or a passkey prompt, a consent screen. " +
      "Brings this project's window to the front, keeps the browser alive while they work, and returns the exact message to give the user. " +
      "After calling it, tell the user, then stop and wait for them to say they are done before continuing.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What the user should do, e.g. 'sign in to takeout.google.com'." },
        minutes: { type: "number", description: "How long to keep the browser alive without agent activity (default 60, max 1440)." },
      },
      required: ["task"],
    },
  },
  {
    name: "browser_downloads",
    description:
      "List files this project's browser has downloaded, newest first, with absolute host paths you can read directly. " +
      "Files ending in .crdownload are still in progress.",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "Max entries (default 50)." } } },
  },
  {
    name: "browser_info",
    description:
      "Show this project's browser: project name, window title, human view URL, profile and downloads directories, idle timeout, " +
      "and the CDP endpoint for scripts (long-running download watchers and the like).",
    inputSchema: { type: "object", properties: {} },
  },
];

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

const text = (s) => ({ content: [{ type: "text", text: s }] });

export function listDownloads(dir, limit = 50) {
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
    if (name === "browser_handoff") {
      const minutes = Math.min(Math.max(Number(args.minutes) || 60, 1), 1440);
      await api(cfg, "ensure");
      await api(cfg, "hold", { body: { minutes } });
      const st = await api(cfg, "focus");
      const where = st.viewUrl ? `Open ${st.viewUrl}` : "Open the telebrowser view";
      return text(
        `Tell the user exactly this, then wait for their reply:\n\n` +
          `"${where} (the window for ${st.project} is now in front). ` +
          `Please ${args.task}. Tell me when you are done."\n\n` +
          `The browser stays up for at least ${minutes} minutes without agent activity. ` +
          `Do not drive the page while the user is working in it.` +
          (st.ephemeral ? " Note: this is the scratch profile; it is wiped when it stops, so a sign-in here does not last." : ""),
      );
    }
    if (name === "browser_downloads") {
      const st = await api(cfg, "status", { method: "GET" });
      const files = listDownloads(st.downloadsDir, Number(args.limit) || 50);
      return text(JSON.stringify({ downloadsDir: st.downloadsDir, files }, null, 2));
    }
    if (name === "browser_info") {
      const st = await api(cfg, "status", { method: "GET" });
      return text(
        JSON.stringify(
          {
            ...st,
            cdp: {
              webSocket: cfg.wsEndpoint,
              http: cfg.httpEndpoint,
              note: "Both carry this project's token; keep them out of committed files and logs. `telebrowser ws` prints the WebSocket URL in a shell.",
            },
          },
          null,
          2,
        ),
      );
    }
    return { isError: true, ...text(`unknown tool ${name}`) };
  } catch (err) {
    return { isError: true, ...text(`telebrowser: ${err.message}`) };
  }
}
