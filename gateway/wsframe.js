// A minimal WebSocket server endpoint (RFC 6455) over a socket Node's http server handed
// to an `upgrade` listener: text and binary messages, fragmentation, ping/pong, close.
// No extensions are negotiated, so frames are never compressed.

import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE = 512 * 1024 * 1024; // CDP screenshots and traces can be large

export const acceptKey = (key) => createHash("sha1").update(key + GUID).digest("base64");

/** One frame; `mask` is for client-to-server frames (used by tests). */
export function encodeFrame(opcode, payload, { mask = false, fin = true } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? "");
  const len = data.length;
  const ext = len < 126 ? 0 : len < 65536 ? 2 : 8;
  const head = Buffer.alloc(2 + ext + (mask ? 4 : 0));
  head[0] = (fin ? 0x80 : 0) | opcode;
  head[1] = (mask ? 0x80 : 0) | (ext === 0 ? len : ext === 2 ? 126 : 127);
  if (ext === 2) head.writeUInt16BE(len, 2);
  if (ext === 8) head.writeBigUInt64BE(BigInt(len), 2);
  if (!mask) return Buffer.concat([head, data]);
  const key = head.subarray(2 + ext);
  for (let i = 0; i < 4; i++) key[i] = (Math.random() * 256) | 0;
  const out = Buffer.from(data);
  for (let i = 0; i < out.length; i++) out[i] ^= key[i & 3];
  return Buffer.concat([head, out]);
}

/** Incremental frame parser. Calls onFrame({fin, opcode, payload}) per complete frame. */
export class FrameParser {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) throw new Error("frame too large");
        len = Number(big);
        off = 10;
      }
      if (len > MAX_MESSAGE) throw new Error("frame too large");
      const keyOff = off;
      if (masked) off += 4;
      if (b.length < off + len) return;
      const payload = Buffer.from(b.subarray(off, off + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= b[keyOff + (i & 3)];
      this.buf = b.subarray(off + len);
      this.onFrame({ fin: (b[0] & 0x80) !== 0, opcode: b[0] & 0x0f, payload });
    }
  }
}

/**
 * Complete the handshake on an upgraded socket and return a small connection object.
 * onMessage(string) receives each text message; onClose() fires once.
 */
export function acceptWebSocket(req, socket, head, { onMessage, onClose }) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return null;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  let closed = false;
  let parts = [];
  let partsLen = 0;
  const finish = () => {
    if (closed) return;
    closed = true;
    onClose?.();
  };
  const conn = {
    send(text) {
      if (!closed && socket.writable) socket.write(encodeFrame(0x1, Buffer.from(text)));
    },
    close(code = 1000) {
      if (closed) return;
      const p = Buffer.alloc(2);
      p.writeUInt16BE(code);
      if (socket.writable) socket.end(encodeFrame(0x8, p));
      finish();
      setTimeout(() => socket.destroy(), 1000).unref();
    },
    get closed() {
      return closed;
    },
  };
  const parser = new FrameParser(({ fin, opcode, payload }) => {
    if (opcode === 0x8) {
      if (socket.writable) socket.end(encodeFrame(0x8, payload.subarray(0, 2)));
      finish();
      return;
    }
    if (opcode === 0x9) {
      if (socket.writable) socket.write(encodeFrame(0xa, payload));
      return;
    }
    if (opcode === 0xa) return;
    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      parts.push(payload);
      partsLen += payload.length;
      if (partsLen > MAX_MESSAGE) throw new Error("message too large");
      if (!fin) return;
      const msg = Buffer.concat(parts, partsLen).toString("utf8");
      parts = [];
      partsLen = 0;
      onMessage(msg);
    }
  });
  const feed = (chunk) => {
    try {
      parser.push(chunk);
    } catch {
      socket.destroy();
      finish();
    }
  };
  socket.on("data", feed);
  socket.on("close", finish);
  socket.on("error", finish);
  if (head?.length) feed(head);
  return conn;
}
