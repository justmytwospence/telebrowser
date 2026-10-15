import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeToken, verifyToken, toProjectName } from "../lib/token.js";
import { Projects } from "../gateway/projects.js";
import { createGateway, rewriteDebugUrls } from "../gateway/server.js";

const SECRET = "x".repeat(40);

test("tokens round-trip and are project-bound", () => {
  const a = makeToken(SECRET, "alpha");
  assert.equal(verifyToken(SECRET, a), "alpha");
  assert.equal(verifyToken("y".repeat(40), a), null);
  const forged = "beta." + a.split(".")[1];
  assert.equal(verifyToken(SECRET, forged), null);
  assert.equal(verifyToken(SECRET, "alpha.zz"), null);
  assert.throws(() => makeToken("short", "alpha"));
});

test("project names are normalised", () => {
  assert.equal(toProjectName("My Repo"), "my-repo");
  assert.equal(toProjectName(".hidden"), "hidden");
  assert.equal(toProjectName("--"), null);
  assert.equal(toProjectName("a".repeat(100)).length, 63);
});

test("url rewriting points at the gateway under the token", () => {
  const body = '{"webSocketDebuggerUrl":"ws://127.0.0.1:9301/devtools/browser/abc","devtoolsFrontendUrl":"/x?ws=127.0.0.1:9301/devtools/page/1"}';
  const out = rewriteDebugUrls(body, 9301, "127.0.0.1:5859", "p.tok");
  assert.match(out, /ws:\/\/127\.0\.0\.1:5859\/t\/p\.tok\/devtools\/browser\/abc/);
  assert.match(out, /ws=127\.0\.0\.1:5859\/t\/p\.tok\/devtools\/page\/1/);
  assert.doesNotMatch(out, /9301/);
});

// Plays the supervisor: marks every wanted project as up on its port.
function autoUp(runDir) {
  const want = join(runDir, "want");
  const up = join(runDir, "up");
  mkdirSync(want, { recursive: true });
  mkdirSync(up, { recursive: true });
  return async () => {
    for (const p of (await import("node:fs")).readdirSync(want)) writeFileSync(join(up, p), readFileSync(join(want, p), "utf8").trim() + " 1");
    return {};
  };
}

test("projects: allocate, reuse, stop, idle sweep, hold", async () => {
  let t = 0;
  const runDir = mkdtempSync(join(tmpdir(), "ab-"));
  const ps = new Projects({ runDir, portStart: 9300, portEnd: 9301, idleMs: 1000, probe: autoUp(runDir), now: () => t });
  assert.equal(await ps.ensure("a"), 9300);
  assert.equal(await ps.ensure("a"), 9300);
  assert.equal(await ps.ensure("b"), 9301);
  await assert.rejects(ps.ensure("c"), /no free debug ports/);
  assert.equal(readFileSync(join(runDir, "want", "a"), "utf8").trim(), "9300");
  ps.hold("b", 5000);
  t = 2000;
  assert.deepEqual(ps.sweep(), ["a"]);
  assert.equal(existsSync(join(runDir, "want", "a")), false);
  t = 6000;
  assert.deepEqual(ps.sweep(), ["b"]);
  await assert.rejects(ps.ensure("../etc"), /invalid project/);
});

test("projects: a port still up for a stopped project is not reused", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "ab-"));
  const probe = autoUp(runDir);
  const ps = new Projects({ runDir, portStart: 9300, portEnd: 9301, readyTimeoutMs: 300, probe });
  assert.equal(await ps.ensure("a"), 9300);
  ps.stop("a"); // want file gone, but the supervisor has not reported the exit yet
  const pending = ps.ensure("b");
  assert.equal(readFileSync(join(runDir, "want", "b"), "utf8").trim(), "9301");
  assert.equal(await pending, 9301);
  rmSync(join(runDir, "up", "a"));
});

test("projects: not ready until the supervisor reports the right port", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "ab-"));
  mkdirSync(join(runDir, "up"), { recursive: true });
  writeFileSync(join(runDir, "up", "a"), "9399 1"); // stale entry on another port
  const ps = new Projects({ runDir, portStart: 9300, portEnd: 9301, readyTimeoutMs: 300, probe: async () => ({}) });
  await assert.rejects(ps.ensure("a"), /did not start/);
});

// A fake Chromium: /json endpoints plus a WebSocket upgrade that records what it received.
function fakeChrome() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const port = srv.address().port;
    res.setHeader("content-type", "application/json");
    if (req.url === "/json/version") return res.end(JSON.stringify({ Browser: "Chrome/1", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/BID` }));
    if (req.url === "/json/list") return res.end(JSON.stringify([{ id: "P1", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/P1` }]));
    res.statusCode = 404;
    res.end("{}");
  });
  srv.on("upgrade", (req, socket) => {
    seen.push({ url: req.url, headers: req.headers });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nHELLO");
    socket.end();
  });
  return new Promise((res) => srv.listen(0, "127.0.0.1", () => res({ srv, seen, port: srv.address().port })));
}

async function setup() {
  const chrome = await fakeChrome();
  const runDir = mkdtempSync(join(tmpdir(), "ab-"));
  const up = autoUp(runDir);
  const ps = new Projects({ runDir, portStart: chrome.port, portEnd: chrome.port, probe: async () => (await up(), { Browser: "Chrome/1", webSocketDebuggerUrl: `ws://127.0.0.1:${chrome.port}/devtools/browser/BID` }) });
  const gw = createGateway({ secret: SECRET, projects: ps, hostDataDir: "/host/data", viewUrl: "https://view", log: () => {} });
  await new Promise((r) => gw.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${gw.address().port}`;
  return { chrome, ps, gw, base, close: () => { gw.close(); chrome.srv.close(); } };
}

test("gateway: auth, status, json rewrite", async () => {
  const s = await setup();
  try {
    const tok = makeToken(SECRET, "alpha");
    assert.equal((await fetch(`${s.base}/healthz`)).status, 200);
    assert.equal((await fetch(`${s.base}/json/version`)).status, 401);
    assert.equal((await fetch(`${s.base}/json/version`, { headers: { authorization: "Bearer alpha.00" } })).status, 401);

    const st = await (await fetch(`${s.base}/v1/ensure`, { method: "POST", headers: { authorization: `Bearer ${tok}` } })).json();
    assert.equal(st.project, "alpha");
    assert.equal(st.downloadsDir, "/host/data/projects/alpha/downloads");
    assert.equal(st.windowTitle, "[alpha]");

    const v = await (await fetch(`${s.base}/t/${tok}/json/version`)).json();
    assert.equal(v.webSocketDebuggerUrl, `ws://${new URL(s.base).host}/t/${tok}/devtools/browser/BID`);
  } finally {
    s.close();
  }
});

test("gateway: websocket upgrade is piped with auth stripped and browser id resolved", async () => {
  const s = await setup();
  try {
    const tok = makeToken(SECRET, "alpha");
    const gwPort = s.gw.address().port;
    const reply = await new Promise((res, rej) => {
      const c = net.connect(gwPort, "127.0.0.1", () => {
        c.write(`GET /devtools/browser HTTP/1.1\r\nHost: 127.0.0.1:${gwPort}\r\nAuthorization: Bearer ${tok}\r\nOrigin: http://evil\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let buf = "";
      c.on("data", (d) => (buf += d));
      c.on("end", () => res(buf));
      c.on("error", rej);
    });
    assert.match(reply, /101 Switching Protocols/);
    assert.match(reply, /HELLO$/);
    const seen = s.chrome.seen[0];
    assert.equal(seen.url, "/devtools/browser/BID");
    assert.equal(seen.headers.authorization, undefined);
    assert.equal(seen.headers.origin, undefined);
    assert.equal(seen.headers.host, `127.0.0.1:${s.chrome.port}`);

    const denied = await new Promise((res) => {
      const c = net.connect(gwPort, "127.0.0.1", () => c.write(`GET /devtools/browser HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`));
      let buf = "";
      c.on("data", (d) => (buf += d));
      c.on("close", () => res(buf));
    });
    assert.match(denied, /401/);
  } finally {
    s.close();
  }
});
