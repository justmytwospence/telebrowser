// Stand-in for chrome-devtools-mcp in tests: answers tools/list and tools/call.
import { createInterface } from "node:readline";

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  if (msg.method === "tools/list") reply({ tools: [{ name: "navigate_page", inputSchema: { type: "object" } }] });
  else if (msg.method === "tools/call") reply({ content: [{ type: "text", text: `child handled ${msg.params.name}` }] });
});
