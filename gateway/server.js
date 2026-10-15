// The gateway: the only network entry to the per-project browsers.
//
//   GET  /healthz                     no auth
//   *    /v1/{ensure,stop,status,focus,hold}   project API
//   *    /json/*                       Chrome's HTTP debug endpoints, for the token's project only
//   WS   /devtools/*                   CDP, piped to the token's project's Chromium
//
// Auth is `Authorization: Bearer <token>` or a `/t/<token>` path prefix (for clients that
// cannot send headers, and in the WebSocket URLs /json returns). A token names exactly one
// project; nothing lists or reaches another project's browser.

import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import { verifyToken } from "../lib/token.js";

const HOP_HEADERS = new Set(["host", "authorization", "origin", "cookie", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]);

export function parseAuth(req, secret) {
  let path = req.url || "/";
  let token = null;
  const m = path.match(/^\/t\/([^/?#]+)(\/.*)?$/);
  if (m) {
    token = decodeURIComponent(m[1]);
    path = m[2] || "/";
  } else {
    const h = req.headers.authorization || "";
    if (h.toLowerCase().startsWith("bearer ")) token = h.slice(7).trim();
  }
  const project = token ? verifyToken(secret, token) : null;
  return { project, token, path };
}

export async function probe(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Point every debugger URL Chrome hands out at the gateway, under the caller's token. */
export function rewriteDebugUrls(body, port, publicHost, token) {
  const prefix = `${publicHost}/t/${encodeURIComponent(token)}`;
  return body
    .replaceAll(`ws://127.0.0.1:${port}/`, `ws://${prefix}/`)
    .replaceAll(`ws=127.0.0.1:${port}/`, `ws=${prefix}/`)
    .replaceAll(`http://127.0.0.1:${port}/`, `http://${prefix}/`);
}

/** Minimal CDP call over the browser-level WebSocket (Node 22+ global WebSocket). */
async function cdp(wsUrl, calls) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("CDP connection failed"));
  });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.id && waiting.has(msg.id)) {
      const { res, rej } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      waiting.set(++id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  try {
    return await calls(send);
  } finally {
    ws.close();
  }
}

function json(res, status, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

export function createGateway({ secret, projects, hostDataDir = "/data", viewUrl = "", log = console.log }) {
  const describe = async (project) => {
    const port = projects.portOf(project);
    const version = port ? await probe(port) : null;
    const dir = join(hostDataDir, "projects", project);
    return {
      project,
      running: port !== null,
      ready: Boolean(version),
      browser: version?.Browser ?? null,
      windowTitle: `[${project}]`,
      viewUrl,
      profileDir: join(dir, "profile"),
      downloadsDir: join(dir, "downloads"),
      idleMinutes: Math.round(projects.idleMs / 60_000),
      ephemeral: project === "scratch",
    };
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === "/healthz") return json(res, 200, { ok: true });
      const { project, token, path } = parseAuth(req, secret);
      if (!project) return json(res, 401, { error: "missing or invalid project token" });
      const url = new URL(path, "http://gateway");

      if (url.pathname.startsWith("/v1/")) {
        const op = url.pathname.slice(4);
        if (op === "status" && req.method === "GET") return json(res, 200, await describe(project));
        if (req.method !== "POST") return json(res, 405, { error: "use POST" });
        const body = await readBody(req);
        if (op === "ensure") {
          await projects.ensure(project);
          log(`ensure ${project}`);
          return json(res, 200, await describe(project));
        }
        if (op === "stop") {
          projects.stop(project);
          log(`stop ${project}`);
          return json(res, 200, await describe(project));
        }
        if (op === "hold") {
          const minutes = Math.min(Math.max(Number(body.minutes) || 60, 1), 24 * 60);
          projects.hold(project, minutes * 60_000);
          return json(res, 200, { ...(await describe(project)), heldMinutes: minutes });
        }
        if (op === "focus") {
          const port = await projects.ensure(project);
          const version = await probe(port);
          const target = await cdp(version.webSocketDebuggerUrl, async (send) => {
            const { targetInfos } = await send("Target.getTargets");
            let t = targetInfos.find((x) => x.type === "page" && (!body.targetId || x.targetId === body.targetId));
            if (!t) t = { targetId: (await send("Target.createTarget", { url: "about:blank" })).targetId };
            await send("Target.activateTarget", { targetId: t.targetId });
            return t.targetId;
          });
          // activateTarget only switches the tab; the window itself is raised by the supervisor.
          projects.raise(project);
          return json(res, 200, { ...(await describe(project)), focusedTarget: target });
        }
        return json(res, 404, { error: `unknown operation ${op}` });
      }

      if (url.pathname === "/json" || url.pathname.startsWith("/json/")) {
        const port = await projects.ensure(project);
        projects.touch(project);
        const upstream = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { method: req.method });
        const text = await upstream.text();
        const host = req.headers.host || `127.0.0.1`;
        res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json" });
        return res.end(rewriteDebugUrls(text, port, host, token));
      }

      return json(res, 404, { error: "not found" });
    } catch (err) {
      log(`error ${req.method} ${req.url?.replace(/\/t\/[^/]+/, "/t/***")}: ${err.message}`);
      if (!res.headersSent) json(res, 502, { error: err.message });
      else res.end();
    }
  });

  server.on("upgrade", async (req, socket, head) => {
    const fail = (status, msg) => {
      socket.end(`HTTP/1.1 ${status} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    socket.on("error", () => {});
    try {
      const { project, path } = parseAuth(req, secret);
      if (!project) return fail(401, "Unauthorized");
      if (!path.startsWith("/devtools/")) return fail(404, "Not Found");
      const port = await projects.ensure(project);
      let target = path;
      if (/^\/devtools\/browser\/?(\?.*)?$/.test(path)) {
        const version = await probe(port);
        target = new URL(version.webSocketDebuggerUrl).pathname;
      }
      const upstream = net.connect(port, "127.0.0.1");
      upstream.on("error", () => socket.destroy());
      upstream.on("connect", () => {
        const lines = [`GET ${target} HTTP/1.1`, `Host: 127.0.0.1:${port}`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          if (!HOP_HEADERS.has(req.rawHeaders[i].toLowerCase())) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        }
        upstream.write(lines.join("\r\n") + "\r\n\r\n");
        if (head?.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
        upstream.on("data", () => projects.touch(project));
        socket.on("data", () => projects.touch(project));
        socket.on("close", () => upstream.destroy());
        upstream.on("close", () => socket.destroy());
      });
    } catch (err) {
      log(`error upgrade: ${err.message}`);
      fail(502, "Bad Gateway");
    }
  });

  return server;
}
