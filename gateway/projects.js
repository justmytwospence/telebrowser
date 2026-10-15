// Project lifecycle. The gateway cannot start processes in the browser container, so it
// declares intent through files the supervisor there watches:
//   <runDir>/want/<project>   contents: the 127.0.0.1 debug port that project's Chromium uses
// The supervisor starts a Chromium for every want file and stops (and, for `scratch`,
// wipes) any whose file is gone. It reports what is actually running in
//   <runDir>/up/<project>     contents: "<port> <pid>", removed only once the process exited
// A port is reused only when neither file mentions it, and a browser counts as ready only
// when its up file names the expected port: otherwise a project could be handed a
// different project's Chromium that is still shutting down on a recycled port.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_RE } from "../lib/token.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Projects {
  constructor({ runDir, portStart = 9300, portEnd = 9399, idleMs = 60 * 60_000, readyTimeoutMs = 45_000, probe, now = Date.now }) {
    this.wantDir = join(runDir, "want");
    this.upDir = join(runDir, "up");
    this.raiseDir = join(runDir, "raise");
    mkdirSync(this.raiseDir, { recursive: true });
    mkdirSync(this.wantDir, { recursive: true });
    mkdirSync(this.upDir, { recursive: true });
    this.portStart = portStart;
    this.portEnd = portEnd;
    this.idleMs = idleMs;
    this.readyTimeoutMs = readyTimeoutMs;
    this.probe = probe; // async (port) => version JSON or null
    this.now = now;
    this.lastActivity = new Map();
    this.holdUntil = new Map();
    this.pending = new Map();
  }

  #read(dir) {
    const out = new Map();
    for (const name of readdirSync(dir)) {
      if (!PROJECT_RE.test(name)) continue;
      try {
        const port = Number.parseInt(readFileSync(join(dir, name), "utf8"), 10);
        if (Number.isInteger(port)) out.set(name, port);
      } catch {
        // removed between readdir and read
      }
    }
    return out;
  }

  /** Map of project -> port for every project that should be running. */
  wanted() {
    return this.#read(this.wantDir);
  }

  /** Map of project -> port for every Chromium the supervisor reports as running. */
  up() {
    return this.#read(this.upDir);
  }

  portOf(project) {
    return this.wanted().get(project) ?? null;
  }

  #allocate() {
    const used = new Set([...this.wanted().values(), ...this.up().values()]);
    for (let p = this.portStart; p <= this.portEnd; p++) if (!used.has(p)) return p;
    throw new Error("no free debug ports: too many project browsers running");
  }

  /** Make sure the project's Chromium is running and answering; return its port. */
  async ensure(project) {
    if (!PROJECT_RE.test(project)) throw new Error(`invalid project: ${project}`);
    // Concurrent ensures for one project share one start.
    if (this.pending.has(project)) return this.pending.get(project);
    const run = (async () => {
      let port = this.portOf(project);
      if (port === null) {
        port = this.#allocate();
        const tmp = join(this.wantDir, `.${project}.tmp`);
        writeFileSync(tmp, `${port}\n`);
        renameSync(tmp, join(this.wantDir, project));
      }
      this.touch(project);
      const deadline = this.now() + this.readyTimeoutMs;
      while (!(await this.probe(port)) || this.up().get(project) !== port) {
        if (this.now() > deadline) throw new Error(`browser for ${project} did not start within ${this.readyTimeoutMs} ms`);
        await sleep(250);
      }
      return port;
    })();
    this.pending.set(project, run);
    try {
      return await run;
    } finally {
      this.pending.delete(project);
    }
  }

  stop(project) {
    try {
      unlinkSync(join(this.wantDir, project));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    this.lastActivity.delete(project);
    this.holdUntil.delete(project);
  }

  /** Ask the supervisor to bring the project's window to the front of the desktop. */
  raise(project) {
    writeFileSync(join(this.raiseDir, project), "");
  }

  touch(project) {
    this.lastActivity.set(project, this.now());
  }

  /** Keep a browser alive without CDP traffic, e.g. while a human signs in. */
  hold(project, ms) {
    this.holdUntil.set(project, Math.max(this.holdUntil.get(project) ?? 0, this.now() + ms));
  }

  /** Stop browsers idle longer than idleMs. Returns the projects stopped. */
  sweep() {
    if (!this.idleMs) return [];
    const stopped = [];
    const t = this.now();
    for (const project of this.wanted().keys()) {
      if (!this.lastActivity.has(project)) this.lastActivity.set(project, t); // seen after a gateway restart
      const idle = t - this.lastActivity.get(project) > this.idleMs;
      const held = (this.holdUntil.get(project) ?? 0) > t;
      if (idle && !held) {
        this.stop(project);
        stopped.push(project);
      }
    }
    return stopped;
  }
}
