import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeToken } from "../lib/token.js";
import { Projects } from "../gateway/projects.js";
import { createGateway } from "../gateway/server.js";
import { SessionFilter, SessionState } from "../gateway/session.js";
import { FrameParser, acceptWebSocket, encodeFrame } from "../gateway/wsframe.js";

const SECRET = "x".repeat(40);
const page = (targetId, extra = {}) => ({ targetId, type: "page", url: "about:blank", ...extra });

test("ws frames round-trip at every length encoding, masked and fragmented", () => {
  const got = [];
  const p = new FrameParser((f) => got.push(f));
  for (const n of [0, 5, 125, 126, 65535, 65536, 200_000]) {
    const data = Buffer.alloc(n, 97);
    const frame = encodeFrame(0x1, data, { mask: n % 2 === 0 });
    // feed in awkward pieces
    p.push(frame.subarray(0, 1));
    p.push(frame.subarray(1, 3));
    p.push(frame.subarray(3));
    assert.equal(got.at(-1).payload.length, n);
    assert.ok(got.at(-1).payload.equals(data));
  }
  p.push(Buffer.concat([encodeFrame(0x1, "ab", { fin: false, mask: true }), encodeFrame(0x0, "cd", { mask: true })]));
  assert.deepEqual(got.slice(-2).map((f) => [f.fin, f.opcode, String(f.payload)]), [[false, 1, "ab"], [true, 0, "cd"]]);
});

test("filter: other pages are invisible, own pages and their popups are not", () => {
  const st = new SessionState("p", "sessionA1");
  const f = new SessionFilter(st);
  // Existing page from someone else, announced on discovery.
  assert.deepEqual(f.fromBrowser({ method: "Target.targetCreated", params: { targetInfo: page("OTHER") } }).toClient, []);
  // Tabs pass through.
  assert.equal(f.fromBrowser({ method: "Target.targetCreated", params: { targetInfo: { targetId: "TAB", type: "tab" } } }).toClient.length, 1);

  // createTarget is forced into the background and holds events until it is answered.
  const sent = f.fromClient({ id: 7, method: "Target.createTarget", params: { url: "about:blank" } });
  assert.equal(sent.toBrowser.params.background, true);
  assert.deepEqual(f.fromBrowser({ method: "Target.targetCreated", params: { targetInfo: page("MINE") } }).toClient, []);
  const flushed = f.fromBrowser({ id: 7, result: { targetId: "MINE" } }).toClient;
  assert.deepEqual(flushed.map((m) => m.method ?? m.id), ["Target.targetCreated", 7]);
  assert.ok(st.owned.has("MINE"));

  // Popups of owned pages become owned.
  assert.equal(f.fromBrowser({ method: "Target.targetCreated", params: { targetInfo: page("POP", { openerId: "MINE" }) } }).toClient.length, 1);
  assert.ok(st.owned.has("POP"));

  // getTargets omits other pages.
  f.fromClient({ id: 8, method: "Target.getTargets", params: {} });
  const list = f.fromBrowser({ id: 8, result: { targetInfos: [page("OTHER"), page("MINE"), page("POP"), { targetId: "TAB", type: "tab" }] } }).toClient[0];
  assert.deepEqual(list.result.targetInfos.map((t) => t.targetId), ["MINE", "POP", "TAB"]);

  // Commands naming another page fail like an unknown target.
  const denied = f.fromClient({ id: 9, method: "Target.closeTarget", params: { targetId: "OTHER" } });
  assert.equal(denied.toBrowser, undefined);
  assert.equal(denied.toClient.id, 9);
  assert.match(denied.toClient.error.message, /No target/);
  assert.ok(f.fromClient({ id: 10, method: "Target.activateTarget", params: { targetId: "MINE" } }).toBrowser);

  // Events about the other page stay hidden through its whole life.
  assert.deepEqual(f.fromBrowser({ method: "Target.targetInfoChanged", params: { targetInfo: page("OTHER", { url: "x" }) } }).toClient, []);
  assert.deepEqual(f.fromBrowser({ method: "Target.targetDestroyed", params: { targetId: "OTHER" } }).toClient, []);
  f.fromBrowser({ method: "Target.targetDestroyed", params: { targetId: "POP" } });
  assert.equal(st.owned.has("POP"), false);
});

test("filter: auto-attached foreign pages are resumed and detached by the gateway", () => {
  const st = new SessionState("p", "sessionA1");
  const f = new SessionFilter(st);
  const r = f.fromBrowser({
    method: "Target.attachedToTarget",
    sessionId: "TABSESSION",
    params: { sessionId: "S-OTHER", targetInfo: page("OTHER"), waitingForDebugger: true },
  });
  assert.deepEqual(r.toClient, []);
  assert.deepEqual(r.toBrowser.map((m) => [m.method, m.sessionId]), [
    ["Runtime.runIfWaitingForDebugger", "S-OTHER"],
    ["Target.detachFromTarget", "TABSESSION"],
  ]);
  // Their answers, and anything else on that session, never reach the client.
  for (const m of r.toBrowser) assert.deepEqual(f.fromBrowser({ id: m.id, result: {}, sessionId: m.sessionId }).toClient, []);
  assert.deepEqual(f.fromBrowser({ method: "Page.frameNavigated", sessionId: "S-OTHER", params: {} }).toClient, []);
  assert.deepEqual(f.fromBrowser({ method: "Target.detachedFromTarget", sessionId: "TABSESSION", params: { sessionId: "S-OTHER" } }).toClient, []);

  // A foreign page under a tab session takes its tab with it, so Puppeteer stops waiting for it.
  f.fromBrowser({ method: "Target.attachedToTarget", params: { sessionId: "S-TAB", targetInfo: { targetId: "TAB2", type: "tab" } } });
  const t = f.fromBrowser({ method: "Target.attachedToTarget", sessionId: "S-TAB", params: { sessionId: "S-OTHER2", targetInfo: page("OTHER2"), waitingForDebugger: false } });
  assert.deepEqual(t.toClient.map((m) => [m.method, m.params.targetId]), [["Target.detachedFromTarget", "TAB2"], ["Target.targetDestroyed", "TAB2"]]);
  assert.deepEqual(t.toBrowser.map((m) => [m.method, m.params.sessionId, m.sessionId]), [["Target.detachFromTarget", "S-TAB", undefined]]);
  assert.deepEqual(f.fromBrowser({ method: "Target.targetInfoChanged", params: { targetInfo: { targetId: "TAB2", type: "tab" } } }).toClient, []);
  assert.deepEqual(f.fromBrowser({ id: 99, result: {}, sessionId: "S-TAB" }).toClient, []);

  // An own page's session is tracked as the last one used.
  st.own("MINE");
  f.fromBrowser({ method: "Target.attachedToTarget", params: { sessionId: "S-MINE", targetInfo: page("MINE") } });
  st.lastTarget = null;
  f.fromClient({ id: 1, method: "Runtime.evaluate", sessionId: "S-MINE", params: {} });
  assert.equal(st.lastTarget, "MINE");
});

// A fake Chromium speaking just enough browser-level CDP.
function fakeChrome() {
  const pages = new Map([["HUMAN", page("HUMAN")]]);
  let n = 0;
  const clients = new Set();
  const srv = http.createServer((req, res) => {
    const port = srv.address().port;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ Browser: "Chrome/1", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/BID` }));
  });
  srv.on("upgrade", (req, socket, head) => {
    const c = acceptWebSocket(req, socket, head, {
      onMessage: (text) => {
        const { id, method, params = {} } = JSON.parse(text);
        const send = (m) => c.send(JSON.stringify(m));
        const broadcast = (m) => clients.forEach((x) => x.discover && x.c.send(JSON.stringify(m)));
        if (method === "Target.setDiscoverTargets") {
          me.discover = true;
          for (const info of pages.values()) send({ method: "Target.targetCreated", params: { targetInfo: info } });
          return send({ id, result: {} });
        }
        if (method === "Target.getTargets") return send({ id, result: { targetInfos: [...pages.values()] } });
        if (method === "Target.createTarget") {
          const info = page(`T${++n}`, { url: params.url, background: params.background });
          pages.set(info.targetId, info);
          broadcast({ method: "Target.targetCreated", params: { targetInfo: info } });
          return send({ id, result: { targetId: info.targetId } });
        }
        if (method === "Target.closeTarget") {
          pages.delete(params.targetId);
          broadcast({ method: "Target.targetDestroyed", params: { targetId: params.targetId } });
          return send({ id, result: {} });
        }
        send({ id, result: {} });
      },
      onClose: () => clients.delete(me),
    });
    const me = { c, discover: false };
    clients.add(me);
  });
  return new Promise((res) => srv.listen(0, "127.0.0.1", () => res({ srv, pages, port: srv.address().port })));
}

function client(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    } else events.push(msg);
  };
  return {
    events,
    open: new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej))),
    send: (method, params = {}) => new Promise((res) => (waiting.set(++id, res), ws.send(JSON.stringify({ id, method, params })))),
    close: () => ws.close(),
  };
}

test("gateway: sessions see only their own tabs and clean up after themselves", async () => {
  const chrome = await fakeChrome();
  const runDir = mkdtempSync(join(tmpdir(), "ab-"));
  mkdirSync(join(runDir, "up"), { recursive: true });
  const probe = async () => {
    for (const p of readdirSync(join(runDir, "want"))) writeFileSync(join(runDir, "up", p), readFileSync(join(runDir, "want", p), "utf8").trim() + " 1");
    return { Browser: "Chrome/1", webSocketDebuggerUrl: `ws://127.0.0.1:${chrome.port}/devtools/browser/BID` };
  };
  const ps = new Projects({ runDir, portStart: chrome.port, portEnd: chrome.port, probe });
  const gw = createGateway({ secret: SECRET, projects: ps, log: () => {}, sessionGraceMs: 50 });
  await new Promise((r) => gw.listen(0, "127.0.0.1", r));
  const tok = makeToken(SECRET, "alpha");
  const base = `ws://127.0.0.1:${gw.address().port}/t/${tok}`;
  try {
    const a = client(`${base}/s/sessionAAAA/devtools/browser`);
    const b = client(`${base}/s/sessionBBBB/devtools/browser`);
    await Promise.all([a.open, b.open]);
    const pagesOf = async (c) => (await c.send("Target.getTargets")).result.targetInfos.map((t) => t.targetId).sort();

    // Each session starts on a blank tab of its own.
    const [pa, pb] = [await pagesOf(a), await pagesOf(b)];
    assert.equal(pa.length, 1);
    assert.equal(pb.length, 1);
    assert.notEqual(pa[0], pb[0]);

    await a.send("Target.setDiscoverTargets", { discover: true });
    const created = (await a.send("Target.createTarget", { url: "https://a.example" })).result.targetId;
    assert.equal(chrome.pages.get(created).background, true);
    assert.deepEqual(await pagesOf(a), [pa[0], created].sort());
    assert.deepEqual(await pagesOf(b), pb);
    assert.deepEqual(a.events.map((e) => e.params.targetInfo.targetId).sort(), [pa[0], created].sort());
    assert.match((await b.send("Target.closeTarget", { targetId: created })).error.message, /No target/);

    // Handoff focuses the session's own tab.
    const focus = await fetch(`http://127.0.0.1:${gw.address().port}/v1/focus`, {
      method: "POST",
      headers: { authorization: `Bearer ${tok}` },
      body: JSON.stringify({ session: "sessionBBBB" }),
    });
    assert.equal((await focus.json()).focusedTarget, pb[0]);

    // An unscoped connection still sees everything.
    const all = client(`${base}/devtools/browser`);
    await all.open;
    assert.equal((await pagesOf(all)).length, 4);
    all.close();

    // A's tabs close after it leaves; the human's and B's stay.
    a.close();
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual([...chrome.pages.keys()].sort(), ["HUMAN", pb[0]].sort());
    b.close();
  } finally {
    gw.close();
    chrome.srv.close();
  }
});
