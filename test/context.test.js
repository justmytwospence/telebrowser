import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { TOOLS, callTool, validateArguments } from "../cli/tools.js";
import { readResource, getPrompt } from "../cli/context.js";
import { runMcpProxy } from "../cli/mcp-proxy.js";

const cfg = { project: "test", session: "session", token: "secret-token", wsEndpoint: "ws://secret-token", baseUrl: "http://127.0.0.1:1" };

test("custom annotations are complete and invalid input never reaches the gateway", async () => {
  for (const tool of TOOLS) {
    assert.ok(tool.title);
    for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) assert.equal(typeof tool.annotations[key], "boolean");
    assert.equal(tool.annotations.readOnlyHint, tool.name !== "browser_handoff");
  }
  for (const args of [{}, { task: "" }, { task: "x", minutes: 0 }, { task: "x", minutes: 1.5 }, { task: "x", unexpected: true }]) {
    assert.equal((await callTool(cfg, "browser_handoff", args)).isError, true);
  }
  for (const limit of [-1, 0, 201, Infinity, "5"]) assert.throws(() => validateArguments("browser_downloads", { limit }));
  assert.throws(() => validateArguments("browser_info", null));
});

test("local resources and prompt retrieval are token-free and zero-request", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("unexpected network request"); };
  try {
    for (const uri of ["telebrowser://usage", "telebrowser://status"]) {
      const resource = await readResource(cfg, uri);
      assert.doesNotMatch(JSON.stringify(resource), /secret-token/);
    }
    const prompt = getPrompt({ task: "sign in" });
    assert.match(prompt.messages[0].content.text, /does not|Do not/);
    assert.throws(() => getPrompt({ task: "sign in", minutes: 4 }));
    for (const uri of ["telebrowser://unknown", "telebrowser://downloads?limit=-1", "telebrowser://downloads?limit=201", "telebrowser://downloads?limit=1&limit=2", "telebrowser://downloads?x=1", "telebrowser://downloads/../../secret", "telebrowser://downloads#x"]) {
      await assert.rejects(readResource(cfg, uri));
    }
  } finally { globalThis.fetch = original; }
});

async function proxy(t, upstreamContext) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const done = runMcpProxy(cfg, { stdin, stdout, env: {
    ...process.env, FAKE_CONTEXT: upstreamContext ? "1" : "",
    TELEBROWSER_MCP_CMD: JSON.stringify([process.execPath, fileURLToPath(new URL("./fixtures/fake-mcp.js", import.meta.url))]),
  } });
  let nextId = 0;
  let buffer = "";
  const pending = new Map();
  stdout.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      pending.get(message.id)?.(message);
    }
  });
  t.after(async () => { stdin.end(); assert.equal(await done, 0); });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 2000);
    pending.set(id, (message) => { clearTimeout(timer); pending.delete(id); resolve(message); });
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

for (const upstreamContext of [false, true]) test(`proxy merges capability/context without breaking upstream (context=${upstreamContext})`, async (t) => {
  const request = await proxy(t, upstreamContext);
  const init = (await request("initialize")).result;
  assert.equal(init.serverInfo.name, "chrome");
  assert.deepEqual(init.capabilities.resources, upstreamContext ? { listChanged: true } : {});
  assert.ok(init.capabilities.prompts);
  assert.match(init.instructions, /Upstream guidance/);
  assert.match(init.instructions, /project-isolated/);
  const resources = (await request("resources/list")).result;
  assert.equal(resources.resources.filter((r) => r.uri.startsWith("telebrowser:")).length, 2);
  assert.equal(resources.resources.some((r) => r.uri === "chrome://context"), upstreamContext);
  if (upstreamContext) {
    assert.equal(resources.nextCursor, "next");
    const second = (await request("resources/list", { cursor: "next" })).result;
    assert.equal(second.resources.length, 1, "local resources appended only to first page");
    assert.equal((await request("resources/read", { uri: "chrome://context" })).result.contents[0].text, "upstream context");
    assert.equal((await request("prompts/get", { name: "upstream-prompt" })).result.messages[0].content.text, "upstream prompt");
  }
  const templates = (await request("resources/templates/list")).result.resourceTemplates;
  assert.ok(templates.some((r) => r.name === "project-downloads"));
  const prompts = (await request("prompts/list")).result.prompts;
  assert.ok(prompts.some((p) => p.name === "browser-handoff-review"));
  const status = await request("resources/read", { uri: "telebrowser://status" });
  assert.equal(JSON.parse(status.result.contents[0].text).project, "test");
  assert.doesNotMatch(JSON.stringify(status), /secret-token/);
  const invalid = await request("resources/read", { uri: "telebrowser://downloads?limit=0" });
  assert.equal(invalid.error.code, -32602);
  const tools = (await request("tools/list")).result.tools;
  assert.deepEqual(tools[0].annotations, { readOnlyHint: false }, "upstream tool declaration untouched");
});
