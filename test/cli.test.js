import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { resolveProject } from "../cli/config.js";
import { runMcpProxy } from "../cli/mcp-proxy.js";
import { listDownloads } from "../cli/tools.js";

const here = dirname(fileURLToPath(import.meta.url));
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "ignore" });

test("project resolution: repo, worktree, subdir, non-repo, override", () => {
  const root = mkdtempSync(join(tmpdir(), "ab-proj-"));
  const repo = join(root, "My-Repo");
  mkdirSync(join(repo, "sub"), { recursive: true });
  sh(repo, "init", "-q");
  sh(repo, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "x");
  sh(repo, "worktree", "add", "-q", join(repo, ".worktrees", "feat-x"), "-b", "feat-x");
  assert.equal(resolveProject(repo, {}), "my-repo");
  assert.equal(resolveProject(join(repo, "sub"), {}), "my-repo");
  assert.equal(resolveProject(join(repo, ".worktrees", "feat-x"), {}), "my-repo");
  assert.equal(resolveProject(root, {}), "scratch");
  assert.equal(resolveProject(root, { TELEBROWSER_PROJECT: "other" }), "other");
  assert.throws(() => resolveProject(root, { TELEBROWSER_PROJECT: "../x" }));
});

test("downloads are listed newest first with in-progress flag", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-dl-"));
  writeFileSync(join(dir, "old.zip"), "a");
  utimesSync(join(dir, "old.zip"), 1000, 1000);
  writeFileSync(join(dir, "new.zip.crdownload"), "bb");
  const files = listDownloads(dir);
  assert.deepEqual(files.map((f) => f.name), ["new.zip.crdownload", "old.zip"]);
  assert.equal(files[0].inProgress, true);
  assert.equal(files[1].path, join(dir, "old.zip"));
  assert.deepEqual(listDownloads(join(dir, "missing")), []);
});

test("mcp proxy appends our tools and relays everything else", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const fake = join(here, "fixtures", "fake-mcp.js");
  const done = runMcpProxy({ wsEndpoint: "ws://x", baseUrl: "http://127.0.0.1:1", token: "t" }, {
    stdin,
    stdout,
    env: { ...process.env, TELEBROWSER_MCP_CMD: JSON.stringify([process.execPath, fake]) },
  });
  const lines = [];
  const got = (n) =>
    new Promise((res) => {
      const check = () => (lines.length >= n ? res() : setTimeout(check, 10));
      check();
    });
  stdout.on("data", (d) => lines.push(...String(d).split("\n").filter(Boolean).map((l) => JSON.parse(l))));

  stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) + "\n");
  await got(1);
  const names = lines[0].result.tools.map((t) => t.name);
  assert.deepEqual(names, ["navigate_page", "browser_handoff", "browser_downloads", "browser_info"]);

  stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "navigate_page", arguments: {} } }) + "\n");
  await got(2);
  assert.equal(lines[1].result.content[0].text, "child handled navigate_page");

  // Our tool is answered locally; the gateway is unreachable here, so it reports an error.
  stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_info", arguments: {} } }) + "\n");
  await got(3);
  assert.equal(lines[2].id, 3);
  assert.equal(lines[2].result.isError, true);

  stdin.end();
  assert.equal(await done, 0);
});
