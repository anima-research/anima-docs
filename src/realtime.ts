// Browser realtime: one room per document over /ws?doc=<id>.
//
// Binary frames carry y-protocols messages (0 = sync, 1 = awareness). Text
// frames carry JSON: comment operations from the client, and thread lists,
// role changes and metadata from the server.

import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { createHmac, randomBytes } from 'node:crypto';
import type { App } from './app.js';
import { Fault } from './auth.js';
import { isGuest, type Actor } from './principals.js';
import { atLeast, type Role, type DocChange } from './documents.js';
import type { CommentEvent } from './comments.js';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const AGENT_PRESENCE_MS = 90_000;
const AWARENESS_RENEW_MS = 15_000; // y-protocols drops remote states after 30 s without renewal
const MAX_AWARENESS_STATE = 8 * 1024;
const REVALIDATE_MS = 2_000;
const MAX_SLOTS = 4;          // awareness client ids one connection may hold
const MAX_SLOTS_GUEST = 1;
const MAX_STATES_PER_FRAME = 8;

export interface WebSession { actor: Actor; tokenHash: string; expiresAt: number }

interface Conn { id: string; docId: string; ws: WebSocket; actor: Actor; role: Role; clients: Set<number>; session: WebSession; checkedAt: number; expiry: NodeJS.Timeout }

interface Room {
  docId: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Map<string, Conn>;
  /** Agents shown in this room: awareness client id → expiry timer. */
  agents: Map<number, { sub: string; timer: NodeJS.Timeout; renew: NodeJS.Timeout; clock: number; state: unknown }>;
  /** Awareness client id → the connection that owns it. */
  owners: Map<number, string>;
}

export class Realtime {
  private rooms = new Map<string, Room>();
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 5 * 1024 * 1024 });

  constructor(private app: App, private sessionFor: (req: IncomingMessage) => WebSession | null, private sessionValid: (s: WebSession) => boolean) {
    app.docs.on('update', (e: { docId: string; update: Uint8Array; origin?: { conn?: string } }) => this.broadcastUpdate(e.docId, e.update, e.origin?.conn));
    app.docs.on('change', (c: DocChange) => { if (c.origin.via !== 'web') this.showAgent(c.docId, c.origin.sub, c.ranges.at(-1)?.[1] ?? null); });
    app.docs.on('share', (e: { docId: string }) => this.refreshRoles(e.docId));
    app.docs.on('meta', (e: { docId: string; kind: string }) => this.broadcastMeta(e.docId, e.kind));
    app.comments.on('event', (e: CommentEvent) => this.broadcastThreads(e.docId, e));
    app.docs.on('failed', (e: { docId: string }) => this.closeRoom(e.docId, 4500, 'Save failed; reconnecting'));
    app.principals.on('role', (e: { sub: string }) => { this.reauthorize(e.sub); for (const id of this.rooms.keys()) this.recheckRoom(id); });
    app.principals.on('renamed', (e: { sub: string }) => this.renamed(e.sub));
    this.sweepTimer = setInterval(() => {
      try { for (const id of this.rooms.keys()) this.recheckRoom(id); } catch (e) { console.error('[realtime] sweep failed:', (e as Error).message); }
    }, app.config.roleSweepMs);
    this.sweepTimer.unref?.();
  }

  /**
   * Access can end without an event (a share link expiring), so every open
   * socket's role is re-derived on a short timer as well as on every change.
   */
  private sweepTimer: NodeJS.Timeout;

  attach(server: Server) {
    server.on('upgrade', (req, socket, head) => {
      const reject = (status: number) => { socket.write(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : 'Unauthorized'}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
      try {
        let url: URL;
        try { url = new URL(req.url ?? '/', 'http://docs'); } catch { return; } // the catch-all handler closes it
        if (url.pathname !== '/ws') return;
        // Cookie-authenticated WebSockets must come from our own pages.
        if (req.headers.origin !== this.app.config.origin) return reject(403);
        const session = this.sessionFor(req);
        if (!session) return reject(401);
        const docId = url.searchParams.get('doc') ?? '';
        const role = /^[A-Za-z0-9]{1,40}$/.test(docId) ? this.app.docs.role(docId, session.actor) : null;
        if (!role) return reject(404);
        this.wss.handleUpgrade(req, socket, head, (ws) => this.join(ws, session, docId, role));
      } catch (e) {
        console.error('[realtime] upgrade failed:', (e as Error).message);
        try { reject(400); } catch { socket.destroy(); }
      }
    });
  }

  /** Every JSON message to a connection goes through here, so guests never receive a principal id. */
  private sendTo(c: Pick<Conn, 'ws' | 'actor'>, m: unknown) { sendJson(c.ws, this.mask(c.actor, m)); }

  private mask<T>(viewer: Pick<Actor, 'sub'>, m: T): T { return maskFor(viewer, m, (id) => !!this.app.principals.get(id)); }

  private room(docId: string): Room {
    let r = this.rooms.get(docId);
    if (r) return r;
    const doc = this.app.docs.ydoc(docId);
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null);
    r = { docId, doc, awareness, conns: new Map(), agents: new Map(), owners: new Map() };
    this.app.docs.pin(docId);
    awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      const frame = (states?: Map<number, any>) => {
        const msg = encoding.createEncoder();
        encoding.writeVarUint(msg, MSG_AWARENESS);
        encoding.writeVarUint8Array(msg, awarenessProtocol.encodeAwarenessUpdate(awareness, changed, states));
        return encoding.toUint8Array(msg);
      };
      const bytes = frame();
      let masked: Uint8Array | null = null;
      for (const c of r!.conns.values()) {
        if (c === origin) continue;
        if (isGuest(c.actor.sub)) send(c.ws, masked ??= frame(maskStates(awareness.getStates(), changed)));
        else send(c.ws, bytes);
      }
    });
    this.rooms.set(docId, r);
    return r;
  }

  private join(ws: WebSocket, session: WebSession, docId: string, role: Role) {
    const actor = session.actor;
    const room = this.room(docId);
    // The socket lives no longer than the session that opened it.
    const expiry = setTimeout(() => ws.close(4001, 'Session expired'), Math.min(2 ** 31 - 1, Math.max(1, session.expiresAt - Date.now())));
    expiry.unref?.();
    const conn: Conn = { id: `w${randomBytes(4).toString('hex')}`, docId, ws, actor, role, clients: new Set(), session, checkedAt: Date.now(), expiry };
    room.conns.set(conn.id, conn);

    ws.on('message', (data, isBinary) => {
      try {
        if (!this.stillValid(conn)) { ws.close(4003, 'Signed out or blocked'); return; }
        if (isBinary) { this.onBinary(room, conn, new Uint8Array(data as Buffer)); return; }
        let m: unknown;
        try { m = JSON.parse(data.toString()); } catch { throw new Fault(400, 'Bad message.'); }
        if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Fault(400, 'Bad message.');
        this.onJson(room, conn, m as Record<string, unknown>).catch((e) => console.error('[realtime] message failed:', e));
      } catch (e) {
        this.sendTo(conn, { type: 'error', message: e instanceof Fault ? e.message : 'Bad message.' });
        if (!(e instanceof Fault)) console.error('[realtime]', e);
      }
    });
    ws.on('close', () => {
      clearTimeout(conn.expiry);
      room.conns.delete(conn.id);
      for (const c of conn.clients) room.owners.delete(c);
      awarenessProtocol.removeAwarenessStates(room.awareness, [...conn.clients], null);
      if (!room.conns.size) this.dropRoom(room);
    });
    ws.on('error', () => { /* close follows */ });

    // Hello: who you are here, then sync step 1, awareness, threads.
    this.sendTo(conn, { type: 'hello', you: publicActor(actor), role, doc: this.docInfo(docId) });
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, room.doc);
    send(ws, encoding.toUint8Array(enc));
    const states = [...room.awareness.getStates().keys()];
    if (states.length) {
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, MSG_AWARENESS);
      encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(room.awareness, states, isGuest(actor.sub) ? maskStates(room.awareness.getStates()) : undefined));
      send(ws, encoding.toUint8Array(a));
    }
    this.sendTo(conn, { type: 'threads', threads: this.threads(docId) });
  }

  private onBinary(room: Room, conn: Conn, data: Uint8Array) {
    const dec = decoding.createDecoder(data);
    const type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      const sub = decoding.readVarUint(dec);
      if (sub === syncProtocol.messageYjsSyncStep1) {
        const sv = decoding.readVarUint8Array(dec);
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.writeSyncStep2(enc, room.doc, sv);
        send(conn.ws, encoding.toUint8Array(enc));
      } else if (sub === syncProtocol.messageYjsSyncStep2 || sub === syncProtocol.messageYjsUpdate) {
        const update = decoding.readVarUint8Array(dec);
        if (!atLeast(conn.role, 'editor')) {
          // A reader's step 2 echoes what it was given; anything new is refused.
          if (!this.app.docs.isNoopUpdate(room.docId, update)) {
            this.sendTo(conn, { type: 'error', message: `You have ${conn.role} access; edits are not saved.`, resync: true });
          }
          return;
        }
        this.app.docs.applyClientUpdate(room.docId, update, { sub: conn.actor.sub, via: 'web', conn: conn.id });
      }
    } else if (type === MSG_AWARENESS) {
      const raw = decoding.readVarUint8Array(dec);
      // Identity in awareness comes from the session, never from the client.
      const user = { name: conn.actor.name, color: conn.actor.color, sub: conn.actor.sub, kind: conn.actor.kind };
      // A connection may only write awareness slots it owns (first come), never an agent's.
      const d = decoding.createDecoder(raw);
      const n = decoding.readVarUint(d);
      if (n > MAX_STATES_PER_FRAME) return;
      const maxSlots = isGuest(conn.actor.sub) ? MAX_SLOTS_GUEST : MAX_SLOTS;
      const keep: { client: number; clock: number; state: unknown }[] = [];
      for (let i = 0; i < n; i++) {
        const client = decoding.readVarUint(d); const clock = decoding.readVarUint(d); const json = decoding.readVarString(d);
        if (room.agents.has(client) || json.length > MAX_AWARENESS_STATE) continue;
        const owner = room.owners.get(client);
        if (owner && owner !== conn.id) continue;
        if (!owner && conn.clients.size >= maxSlots) continue; // one browser tab needs one slot
        let state: any;
        try { state = JSON.parse(json); } catch { continue; }
        if (state === null) { conn.clients.delete(client); room.owners.delete(client); }
        else { conn.clients.add(client); room.owners.set(client, conn.id); state = { ...state, user }; }
        keep.push({ client, clock, state });
      }
      if (!keep.length) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, keep.length);
      for (const k of keep) { encoding.writeVarUint(enc, k.client); encoding.writeVarUint(enc, k.clock); encoding.writeVarString(enc, JSON.stringify(k.state)); }
      awarenessProtocol.applyAwarenessUpdate(room.awareness, encoding.toUint8Array(enc), conn);
    }
  }

  private async onJson(room: Room, conn: Conn, m: any) {
    const reqId = typeof m.reqId === 'number' || typeof m.reqId === 'string' ? m.reqId : null;
    const reply = (ok: boolean, data?: unknown, error?: string) => this.sendTo(conn, { type: 'ack', reqId, ok, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}) });
    // Current standing (a block or admin change applies to an already-open socket).
    const standing = this.app.principals.standing(conn.actor.sub, conn.actor.scopes, conn.actor.issuer);
    if (!standing) { reply(false, undefined, 'Blocked.'); conn.ws.close(4003, 'blocked'); return; }
    const actor: Actor = { ...conn.actor, admin: standing.admin };
    // Guests get no "X has no access" warnings: they'd reveal who exists.
    const warn = (w: string[]) => (isGuest(actor.sub) ? [] : w);
    try {
      const C = this.app.comments;
      switch (m.type) {
        case 'comment.create': {
          const anchor = m.anchor ? this.anchorFromClient(room, m.anchor) : null;
          const r = C.create(room.docId, actor, { body: m.body, anchor, assignee: m.assignee ?? null });
          reply(true, { id: r.comment.id, warnings: warn(r.warnings) }); return;
        }
        case 'comment.reply': { const r = C.reply(m.comment, actor, m.body, { resolve: !!m.resolve }); reply(true, { id: r.comment.id, warnings: warn(r.warnings) }); return; }
        case 'comment.edit': { const r = C.editBody(m.comment, actor, m.body); reply(true, { id: r.comment.id, warnings: warn(r.warnings) }); return; }
        case 'comment.delete': C.remove(m.comment, actor); reply(true); return;
        case 'comment.resolve': C.resolve(m.comment, actor, m.resolved !== false); reply(true); return;
        case 'comment.assign': { const r = C.assign(m.comment, actor, m.assignee ?? null); reply(true, { warnings: warn(r.warnings) }); return; }
        case 'threads': reply(true, this.threads(room.docId, !!m.includeResolved)); return;
        default: reply(false, undefined, `Unknown message ${m.type}`);
      }
    } catch (e) {
      reply(false, undefined, e instanceof Fault ? e.message : 'Failed.');
      if (!(e instanceof Fault)) console.error('[realtime]', e);
    }
  }

  /** Clients send base64 relative positions computed on their replica; verify they resolve here. */
  private anchorFromClient(room: Room, a: { start: string; end: string }) {
    const start = Buffer.from(String(a.start), 'base64');
    const end = Buffer.from(String(a.end), 'base64');
    const s = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(start), room.doc);
    const e = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(end), room.doc);
    if (!s || !e || e.index <= s.index) throw new Fault(400, 'Select some text to comment on.');
    const quote = room.doc.getText('body').toString().slice(s.index, e.index);
    return { start: new Uint8Array(start), end: new Uint8Array(end), quote };
  }

  threads(docId: string, includeResolved = true) {
    const P = this.app.principals;
    const person = (sub: string | null) => {
      if (!sub) return null;
      const p = P.get(sub);
      return p ? { sub, name: p.name, kind: p.kind, color: p.color, label: P.label(sub) } : { sub, name: sub, kind: 'human', color: '#5f6368', label: sub };
    };
    return this.app.comments.threads(docId, { includeResolved }).map((t) => ({
      id: t.root.id,
      rel: t.rel,
      quote: t.root.quote,
      orphaned: !!t.anchor?.orphaned,
      resolved: !!t.root.resolvedAt,
      resolvedBy: person(t.root.resolvedBy),
      assignee: person(t.root.assignee),
      comments: [t.root, ...t.replies].map((c) => ({ id: c.id, author: person(c.author), body: c.body, createdAt: c.createdAt, editedAt: c.editedAt, mentions: c.mentions })),
    }));
  }

  /** Session still exists and principal not blocked (re-checked at most every REVALIDATE_MS). */
  private stillValid(conn: Conn): boolean {
    if (Date.now() - conn.checkedAt < REVALIDATE_MS) return true;
    conn.checkedAt = Date.now();
    if (!this.sessionValid(conn.session) || !this.app.principals.standing(conn.actor.sub, conn.actor.scopes, conn.actor.issuer)) return false;
    return this.recheck(conn);
  }

  /** An admin changed someone's standing: re-check every socket they hold. */
  private reauthorize(sub: string) {
    for (const room of this.rooms.values()) {
      for (const c of room.conns.values()) {
        if (c.actor.sub !== sub) continue;
        const standing = this.app.principals.standing(sub, c.actor.scopes, c.actor.issuer);
        if (!standing) { c.ws.close(4003, 'Blocked'); continue; }
        c.actor = { ...c.actor, admin: standing.admin };
        const role = this.app.docs.role(room.docId, c.actor);
        if (!role) { c.ws.close(4003, 'Access removed'); continue; }
        if (role !== c.role) { c.role = role; this.sendTo(c, { type: 'role', role }); }
      }
    }
  }

  /** A guest chose a name: carry it into their open sockets (awareness labels come from the session). */
  private renamed(sub: string) {
    const p = this.app.principals.get(sub);
    if (!p) return;
    for (const room of this.rooms.values()) {
      for (const c of room.conns.values()) {
        if (c.actor.sub !== sub) continue;
        c.actor = { ...c.actor, name: p.name };
        this.sendTo(c, { type: 'you', you: publicActor(c.actor) });
      }
    }
    // Comment cards elsewhere carry the old name until the thread list is re-sent.
    for (const room of this.rooms.values()) {
      const threads = this.threads(room.docId);
      for (const c of room.conns.values()) this.sendTo(c, { type: 'threads', threads });
    }
  }

  /** A session ended (logout): close every socket it opened. */
  closeSession(tokenHash: string) {
    for (const room of this.rooms.values()) for (const c of room.conns.values()) if (c.session.tokenHash === tokenHash) c.ws.close(4001, 'Signed out');
  }

  private closeRoom(docId: string, code: number, reason: string) {
    const room = this.rooms.get(docId);
    if (!room) return;
    for (const c of room.conns.values()) c.ws.close(code, reason);
  }

  private dropRoom(room: Room) {
    for (const a of room.agents.values()) { clearTimeout(a.timer); clearInterval(a.renew); }
    room.awareness.destroy();
    this.rooms.delete(room.docId);
    this.app.docs.unpin(room.docId);
  }

  private docInfo(docId: string) {
    const d = this.app.docs.get(docId);
    if (!d) return null;
    const P = this.app.principals;
    return { id: d.id, title: d.title, owner: { sub: d.ownerSub, label: P.label(d.ownerSub) }, generalAccess: d.generalAccess, publicLink: this.app.docs.hasPublicLink(docId), rev: d.rev, updatedAt: d.updatedAt };
  }

  private broadcastUpdate(docId: string, update: Uint8Array, exceptConn?: string) {
    const room = this.rooms.get(docId);
    if (!room) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    const bytes = encoding.toUint8Array(enc);
    for (const c of room.conns.values()) if (c.id !== exceptConn) send(c.ws, bytes);
  }

  private broadcastThreads(docId: string, e: CommentEvent) {
    const room = this.rooms.get(docId);
    if (!room) return;
    const threads = this.threads(docId);
    for (const c of room.conns.values()) this.sendTo(c, { type: 'threads', threads, event: { kind: e.kind, threadId: e.threadId, commentId: e.commentId, actor: e.actor } });
    if (e.actor !== undefined) this.showAgentIfAgent(docId, e.actor);
  }

  private broadcastMeta(docId: string, kind: string) {
    const room = this.rooms.get(docId);
    if (!room) return;
    if (kind === 'deleted') { for (const c of room.conns.values()) c.ws.close(4004, 'Document deleted'); return; }
    for (const c of room.conns.values()) this.sendTo(c, { type: 'meta', doc: this.docInfo(docId) });
  }

  private refreshRoles(docId: string) {
    const room = this.rooms.get(docId);
    if (!room) return;
    this.recheckRoom(docId);
    for (const c of room.conns.values()) this.sendTo(c, { type: 'meta', doc: this.docInfo(docId) });
  }

  /** Re-derive every connection's role in a room: close those with none, tell the rest of any change. */
  private recheckRoom(docId: string) {
    const room = this.rooms.get(docId);
    if (!room) return;
    for (const c of room.conns.values()) this.recheck(c);
  }

  private recheck(c: Conn): boolean {
    const role = this.app.docs.role(c.docId, c.actor);
    if (!role) { c.ws.close(4003, 'Access removed'); return false; }
    if (role !== c.role) { c.role = role; this.sendTo(c, { type: 'role', role }); }
    return true;
  }

  private showAgentIfAgent(docId: string, sub: string) {
    const p = this.app.principals.get(sub);
    if (p && (p.kind === 'agent' || p.kind === 'service')) this.showAgent(docId, sub, null);
  }

  /**
   * Show a non-browser participant (an agent editing over MCPL) in the room's
   * awareness, with a cursor where it last edited, for a little while.
   */
  private showAgent(docId: string, sub: string, cursorAt: number | null) {
    const room = this.rooms.get(docId);
    if (!room) return;
    const p = this.app.principals.get(sub);
    if (!p) return;
    const client = this.app.docs.serverClientFor(docId, sub);
    const prev = room.agents.get(client);
    if (prev) { clearTimeout(prev.timer); clearInterval(prev.renew); }
    const ytext = room.doc.getText('body');
    const prevCursor = (prev?.state as { cursor?: unknown } | undefined)?.cursor ?? null;
    const cursor = cursorAt === null ? prevCursor : (() => {
      const pos = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, Math.min(cursorAt, ytext.length)));
      return { anchor: pos, head: pos };
    })();
    const state = { user: { name: p.name, color: p.color, sub, kind: p.kind, via: 'mcpl' }, cursor };
    const entry = { sub, clock: (prev?.clock ?? 0) + 1, state, timer: undefined as unknown as NodeJS.Timeout, renew: undefined as unknown as NodeJS.Timeout };
    this.applyRemoteAwareness(room, client, entry.clock, state);
    // Remote awareness states expire after 30 s unless renewed with a higher clock.
    entry.renew = setInterval(() => { entry.clock++; this.applyRemoteAwareness(room, client, entry.clock, entry.state); }, AWARENESS_RENEW_MS);
    entry.renew.unref?.();
    entry.timer = setTimeout(() => {
      clearInterval(entry.renew);
      room.agents.delete(client);
      this.applyRemoteAwareness(room, client, entry.clock + 1, null);
    }, AGENT_PRESENCE_MS);
    entry.timer.unref?.();
    room.agents.set(client, entry);
  }

  private applyRemoteAwareness(room: Room, client: number, clock: number, state: unknown) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 1);
    encoding.writeVarUint(enc, client);
    encoding.writeVarUint(enc, clock);
    encoding.writeVarString(enc, JSON.stringify(state));
    awarenessProtocol.applyAwarenessUpdate(room.awareness, encoding.toUint8Array(enc), 'agent');
  }

  /** Who is in a document right now (for the doc list). */
  presence(docId: string): { sub: string; name: string; kind: string; color: string }[] {
    const room = this.rooms.get(docId);
    if (!room) return [];
    const seen = new Map<string, { sub: string; name: string; kind: string; color: string }>();
    for (const s of room.awareness.getStates().values() as Iterable<any>) if (s?.user?.sub) seen.set(s.user.sub, { sub: s.user.sub, name: s.user.name, kind: s.user.kind, color: s.user.color });
    return [...seen.values()];
  }

  close() {
    clearInterval(this.sweepTimer);
    for (const r of this.rooms.values()) for (const c of r.conns.values()) c.ws.terminate();
    this.wss.close();
  }
}

function send(ws: WebSocket, bytes: Uint8Array) { if (ws.readyState === ws.OPEN) ws.send(bytes); }
function sendJson(ws: WebSocket, m: unknown) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); }
export function publicActor(a: Actor) { return { sub: a.sub, name: a.name, kind: a.kind, color: a.color, admin: a.admin, issuer: a.issuer }; }

// ---------------------------------------------------------------------------
// Guests see people by name, never by Archipelago id: every principal id in
// what a guest receives (other than their own) becomes a stable opaque id.
// ---------------------------------------------------------------------------

const MASK_KEY = randomBytes(32);
/** Principal ids wherever they appear in a string, including @{sub} and @[name](sub) mentions inside comment bodies. */
const EMBEDDED_ID = /\b(?:human|agent|service|guest):[^\s)}\]"'<>,]+/g;

export function maskSub(sub: string): string {
  return `anon:${createHmac('sha256', MASK_KEY).update(sub).digest('base64url').slice(0, 16)}`;
}

/**
 * Deep-copy `value` with principal ids masked for a guest viewer (members get
 * it unchanged). `isKnown` limits masking to real principals, so text that
 * merely looks like an id ("service:mesh" in a title) is left alone.
 */
export function maskFor<T>(viewer: Pick<Actor, 'sub'>, value: T, isKnown: (id: string) => boolean = () => true): T {
  if (!isGuest(viewer.sub)) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(EMBEDDED_ID, (id) => (id === viewer.sub || !isKnown(id) ? id : maskSub(id)));
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** Awareness states with user ids masked (only `clients`, when given: the ones being sent). */
function maskStates(states: Map<number, any>, clients?: number[]): Map<number, any> {
  const out = new Map<number, any>();
  for (const client of clients ?? states.keys()) {
    const st = states.get(client);
    if (st !== undefined) out.set(client, st?.user?.sub ? { ...st, user: { ...st.user, sub: maskSub(st.user.sub) } } : st);
  }
  return out;
}
