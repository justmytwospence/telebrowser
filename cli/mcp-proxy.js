// Relay upstream Chrome MCP unchanged except for telebrowser-owned tools/context.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { TOOLS, TOOL_NAMES, callTool } from "./tools.js";
import { INSTRUCTIONS, RESOURCES, TEMPLATES, PROMPTS, ownsResource, readResource, getPrompt } from "./context.js";

export const CHROME_DEVTOOLS_MCP = "chrome-devtools-mcp@1.10.1";

export function childCommand(cfg, env = process.env) {
  if (env.TELEBROWSER_MCP_CMD) {
    const [cmd, ...args] = JSON.parse(env.TELEBROWSER_MCP_CMD);
    return { cmd, args };
  }
  return {
    cmd: "npx",
    args: ["-y", CHROME_DEVTOOLS_MCP, `--wsEndpoint=${cfg.wsEndpoint}`, "--no-usage-statistics", "--no-performance-crux", "--categoryEmulation=false"],
  };
}

const listings = {
  "tools/list": ["tools", TOOLS],
  "resources/list": ["resources", RESOURCES],
  "resources/templates/list": ["resourceTemplates", TEMPLATES],
  "prompts/list": ["prompts", PROMPTS],
};

export function runMcpProxy(cfg, { stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
  const { cmd, args } = childCommand(cfg, env);
  const child = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...env, CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1", CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1" },
  });
  const pending = new Map();
  let capabilities;
  const write = (msg) => stdout.write(JSON.stringify(msg) + "\n");
  const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
  const failure = (id, err) => write({ jsonrpc: "2.0", id, error: { code: -32602, message: err.message } });

  createInterface({ input: stdin, crlfDelay: Infinity }).on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { child.stdin.write(line + "\n"); return; }
    const hasId = msg.id !== undefined;
    try {
      if (msg.method === "tools/call" && TOOL_NAMES.has(msg.params?.name)) {
        if (hasId) reply(msg.id, await callTool(cfg, msg.params.name, msg.params.arguments));
        return;
      }
      if (msg.method === "resources/read" && ownsResource(msg.params?.uri)) {
        if (hasId) reply(msg.id, await readResource(cfg, msg.params.uri));
        return;
      }
      if (msg.method === "prompts/get" && PROMPTS.some((p) => p.name === msg.params?.name)) {
        if (hasId) reply(msg.id, getPrompt(msg.params.arguments));
        return;
      }
      const listing = listings[msg.method];
      const firstPage = !msg.params?.cursor;
      const capability = msg.method?.startsWith("resources/") ? "resources" : msg.method?.startsWith("prompts/") ? "prompts" : "tools";
      // Do not forward unsupported methods to a child that declared no capability.
      if (listing && capabilities && !capabilities[capability]) {
        if (hasId) {
          if (!firstPage) throw new Error("unknown pagination cursor");
          reply(msg.id, { [listing[0]]: listing[1] });
        }
        return;
      }
      if (hasId && (msg.method === "initialize" || listing && firstPage)) pending.set(msg.id, msg.method);
      child.stdin.write(line + "\n");
    } catch (err) {
      if (hasId) failure(msg.id, err);
    }
  }).on("close", () => child.stdin.end());

  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id) && (msg.result || msg.error)) {
        const method = pending.get(msg.id);
        pending.delete(msg.id);
        if (method === "initialize" && msg.result) {
          capabilities = msg.result.capabilities ?? {};
          msg.result.capabilities = { ...capabilities, resources: { ...capabilities.resources }, prompts: { ...capabilities.prompts } };
          msg.result.instructions = [msg.result.instructions, INSTRUCTIONS].filter(Boolean).join("\n\n");
          write(msg);
          return;
        }
        const listing = listings[method];
        if (listing && msg.result?.[listing[0]]) {
          msg.result[listing[0]] = [...msg.result[listing[0]], ...listing[1]];
          write(msg);
          return;
        }
        if (listing && method !== "tools/list" && msg.error?.code === -32601) {
          reply(msg.id, { [listing[0]]: listing[1] });
          return;
        }
      }
    } catch { /* Preserve non-JSON child output for compatibility. */ }
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
