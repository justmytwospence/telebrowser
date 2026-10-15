// A stdio MCP server that is chrome-devtools-mcp plus telebrowser's own tools.
//
// It spawns chrome-devtools-mcp against this project's CDP endpoint and relays
// newline-delimited JSON-RPC both ways, with two interventions: our tools are appended
// to the first page of every tools/list result, and tools/call for our tools is answered
// here instead of being forwarded.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { TOOLS, TOOL_NAMES, callTool } from "./tools.js";

export const CHROME_DEVTOOLS_MCP = "chrome-devtools-mcp@1.10.1";

export function childCommand(cfg, env = process.env) {
  if (env.TELEBROWSER_MCP_CMD) {
    const [cmd, ...args] = JSON.parse(env.TELEBROWSER_MCP_CMD);
    return { cmd, args };
  }
  return {
    cmd: "npx",
    args: [
      "-y",
      CHROME_DEVTOOLS_MCP,
      `--wsEndpoint=${cfg.wsEndpoint}`,
      "--no-usage-statistics",
      "--no-performance-crux",
      "--categoryEmulation=false",
    ],
  };
}

export function runMcpProxy(cfg, { stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
  const { cmd, args } = childCommand(cfg, env);
  const child = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...env, CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1", CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1" },
  });
  const listIds = new Set();
  const write = (msg) => stdout.write(JSON.stringify(msg) + "\n");

  createInterface({ input: stdin, crlfDelay: Infinity }).on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      child.stdin.write(line + "\n");
      return;
    }
    if (msg.method === "tools/list" && msg.id !== undefined && !msg.params?.cursor) listIds.add(msg.id);
    if (msg.method === "tools/call" && TOOL_NAMES.has(msg.params?.name)) {
      const result = await callTool(cfg, msg.params.name, msg.params.arguments);
      write({ jsonrpc: "2.0", id: msg.id, result });
      return;
    }
    child.stdin.write(line + "\n");
  }).on("close", () => child.stdin.end());

  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && listIds.has(msg.id) && msg.result?.tools) {
        listIds.delete(msg.id);
        msg.result.tools = [...msg.result.tools, ...TOOLS];
        write(msg);
        return;
      }
    } catch {
      // not JSON: pass through untouched
    }
    stdout.write(line + "\n");
  });

  return new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on("error", (err) => {
      process.stderr.write(`telebrowser: cannot start ${cmd}: ${err.message}\n`);
      resolve(1);
    });
  });
}
