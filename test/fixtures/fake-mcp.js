// Stand-in for chrome-devtools-mcp in tests: answers tools/list and tools/call.
import { createInterface } from "node:readline";

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  if (msg.method === "initialize") reply({ protocolVersion: "2025-11-25", serverInfo: { name: "chrome", version: "test" }, instructions: "Upstream guidance.", capabilities: { tools: {}, ...(process.env.FAKE_CONTEXT ? { resources: { listChanged: true }, prompts: {} } : {}) } });
  else if (msg.method === "tools/list") reply({ tools: [{ name: "navigate_page", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } }] });
  else if (msg.method === "tools/call") reply({ content: [{ type: "text", text: `child handled ${msg.params.name}` }] });
  else if (msg.method === "resources/list") reply({ resources: [{ uri: "chrome://context", name: "upstream" }], nextCursor: "next" });
  else if (msg.method === "resources/templates/list") reply({ resourceTemplates: [{ uriTemplate: "chrome://item/{id}", name: "upstream-template" }] });
  else if (msg.method === "resources/read") reply({ contents: [{ uri: msg.params.uri, text: "upstream context" }] });
  else if (msg.method === "prompts/list") reply({ prompts: [{ name: "upstream-prompt" }] });
  else if (msg.method === "prompts/get") reply({ messages: [{ role: "user", content: { type: "text", text: "upstream prompt" } }] });
});
