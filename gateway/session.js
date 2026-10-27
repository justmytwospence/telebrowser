// Per-agent isolation inside one project's browser.
//
// Every `telebrowser mcp` process is a session (a random id in its CDP URL). The gateway
// relays that session's CDP traffic through a SessionFilter, which shows the client only
// the pages the session owns: the ones it created with Target.createTarget, and popups
// those pages opened. Other sessions' pages, and pages a human opened, do not exist for
// it: their events are dropped, Target.getTargets omits them, and commands naming them
// fail as for an unknown target. Tab targets, workers and the like pass through; clients
// such as Puppeteer list pages only.
//
// Chromium announces a new target before it answers the Target.createTarget that made it,
// so while a session's createTarget is in flight, browser messages are held back and
// released, in order, once the answer says which target is ours.

export const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;

const TARGET_ARG_METHODS = new Set([
  "Target.attachToTarget",
  "Target.activateTarget",
  "Target.closeTarget",
  "Target.getTargetInfo",
  "Target.exposeDevToolsProtocol",
  "Target.detachFromTarget",
  "Browser.getWindowForTarget",
]);

// Ids for messages the gateway itself sends on a client's connection. Clients count up
// from 1, so they never reach this range.
const CONTROL_ID_BASE = 1_000_000_000; // CDP ids must fit in an int32

/** What one session owns, shared by all its connections. */
export class SessionState {
  constructor(project, id) {
    this.project = project;
    this.id = id;
    this.owned = new Set(); // page targetIds
    this.lastTarget = null; // the page it most recently sent a command to
    this.connections = 0;
    this.cleanupTimer = null;
  }

  own(targetId) {
    this.owned.add(targetId);
    this.lastTarget ??= targetId;
  }

  disown(targetId) {
    this.owned.delete(targetId);
    if (this.lastTarget === targetId) this.lastTarget = [...this.owned].at(-1) ?? null;
  }
}

/** The CDP filter for one client connection of a session. */
export class SessionFilter {
  constructor(state) {
    this.state = state;
    this.pendingCreates = new Set(); // client ids of in-flight Target.createTarget
    this.pendingGetTargets = new Set();
    this.held = [];
    this.hiddenTargets = new Set(); // page targetIds this client must not see
    this.hiddenSessions = new Set(); // CDP sessions the gateway detaches on its behalf
    this.cdpSessions = new Map(); // visible CDP sessionId -> targetId
    this.controlIds = new Set();
    this.nextControlId = CONTROL_ID_BASE;
  }

  /** Is this target a page the session must not see? Claims popups of its own pages. */
  #hidden(info) {
    if (!info) return false;
    const { owned } = this.state;
    if (this.hiddenTargets.has(info.targetId) && !owned.has(info.targetId)) return true;
    if (info.type !== "page") return false;
    if (owned.has(info.targetId)) return false;
    if (info.openerId && owned.has(info.openerId)) {
      this.state.own(info.targetId);
      return false;
    }
    this.hiddenTargets.add(info.targetId);
    return true;
  }

  #control(method, params, sessionId) {
    const id = this.nextControlId++;
    this.controlIds.add(id);
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return msg;
  }

  /**
   * A message from the client. Returns { toBrowser, toClient }: the (possibly rewritten)
   * message to forward, or a reply to send straight back instead.
   */
  fromClient(msg) {
    if (msg.sessionId) {
      const target = this.cdpSessions.get(msg.sessionId)?.targetId;
      if (target && this.state.owned.has(target)) this.state.lastTarget = target;
      if (this.hiddenSessions.has(msg.sessionId)) return { toClient: notFound(msg, "No session with given id") };
    }
    if (msg.method === "Target.createTarget" && msg.id !== undefined) {
      // A new tab never takes the window from whatever tab the human is looking at.
      msg = { ...msg, params: { ...msg.params, background: true } };
      this.pendingCreates.add(msg.id);
    } else if (msg.method === "Target.getTargets" && msg.id !== undefined) {
      this.pendingGetTargets.add(msg.id);
    } else if (TARGET_ARG_METHODS.has(msg.method)) {
      const t = msg.params?.targetId;
      if (t && this.hiddenTargets.has(t) && !this.state.owned.has(t)) return { toClient: notFound(msg, "No target with given id found") };
      if (msg.method === "Target.activateTarget" && this.state.owned.has(t)) this.state.lastTarget = t;
    }
    // Bringing one of its own tabs to the front (select_page with bringToFront) switches the
    // tab, but only the gateway can raise the project's window over the others: ask for it.
    const raise = msg.method === "Page.bringToFront" || msg.method === "Target.activateTarget";
    return raise ? { toBrowser: msg, raise } : { toBrowser: msg };
  }

  /** A message from the browser. Returns { toClient: [...], toBrowser: [...] }. */
  fromBrowser(msg) {
    const out = { toClient: [], toBrowser: [] };
    if (msg.id !== undefined && this.pendingCreates.has(msg.id)) {
      this.pendingCreates.delete(msg.id);
      if (msg.result?.targetId) this.state.own(msg.result.targetId);
      this.held.push(msg);
      if (this.pendingCreates.size) return out;
      const held = this.held;
      this.held = [];
      for (const m of held) this.#process(m, out);
      return out;
    }
    if (this.pendingCreates.size) {
      this.held.push(msg);
      return out;
    }
    this.#process(msg, out);
    return out;
  }

  #process(msg, out) {
    if (msg.id !== undefined && this.controlIds.delete(msg.id)) return;
    if (msg.sessionId && this.hiddenSessions.has(msg.sessionId)) return;
    if (msg.id !== undefined) {
      if (this.pendingGetTargets.delete(msg.id) && msg.result?.targetInfos) {
        msg = { ...msg, result: { ...msg.result, targetInfos: msg.result.targetInfos.filter((i) => !this.#hidden(i)) } };
      }
      out.toClient.push(msg);
      return;
    }
    const p = msg.params || {};
    switch (msg.method) {
      case "Target.targetCreated":
      case "Target.targetInfoChanged":
        if (this.#hidden(p.targetInfo)) return;
        break;
      case "Target.targetDestroyed":
      case "Target.targetCrashed":
        if (this.hiddenTargets.has(p.targetId)) {
          if (msg.method === "Target.targetDestroyed") this.hiddenTargets.delete(p.targetId);
          return;
        }
        if (msg.method === "Target.targetDestroyed") this.state.disown(p.targetId);
        break;
      case "Target.attachedToTarget":
        if (this.#hidden(p.targetInfo)) {
          // Auto-attached on the client's behalf: let the page run and let go of it.
          this.hiddenSessions.add(p.sessionId);
          if (p.waitingForDebugger) out.toBrowser.push(this.#control("Runtime.runIfWaitingForDebugger", {}, p.sessionId));
          const parent = msg.sessionId && this.cdpSessions.get(msg.sessionId);
          if (parent?.type === "tab") {
            // The page's tab target: Puppeteer waits for a tab's page before it is ready,
            // so the tab has to go too. Tell the client it is gone, and let go of it.
            this.cdpSessions.delete(msg.sessionId);
            this.hiddenSessions.add(msg.sessionId);
            this.hiddenTargets.add(parent.targetId);
            out.toBrowser.push(this.#control("Target.detachFromTarget", { sessionId: msg.sessionId }));
            out.toClient.push({ method: "Target.detachedFromTarget", params: { sessionId: msg.sessionId, targetId: parent.targetId } });
            out.toClient.push({ method: "Target.targetDestroyed", params: { targetId: parent.targetId } });
          } else {
            out.toBrowser.push(this.#control("Target.detachFromTarget", { sessionId: p.sessionId }, msg.sessionId));
          }
          return;
        }
        this.cdpSessions.set(p.sessionId, { targetId: p.targetInfo?.targetId, type: p.targetInfo?.type });
        break;
      case "Target.detachedFromTarget":
        if (this.hiddenSessions.delete(p.sessionId)) return;
        this.cdpSessions.delete(p.sessionId);
        break;
    }
    out.toClient.push(msg);
  }
}

function notFound(msg, message) {
  const reply = { id: msg.id, error: { code: -32602, message } };
  if (msg.sessionId) reply.sessionId = msg.sessionId;
  return reply;
}
