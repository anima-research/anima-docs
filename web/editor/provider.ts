// Realtime provider for one document over /ws?doc=<id>.
//
// Binary frames are y-protocols (0 = sync, 1 = awareness); text frames are the
// JSON comment/meta channel. One socket carries both, so this is a small custom
// provider rather than y-websocket's.

import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { atLeast, type Me, type Role, type Thread } from '../lib/api';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

export type ConnStatus = 'connecting' | 'online' | 'offline' | 'closed';

export interface DocInfo { id: string; title: string; owner: { sub: string; label: string }; generalAccess: string; publicLink?: boolean; rev: number; updatedAt: number }
export interface ThreadEvent { kind: string; threadId: string; commentId: string; actor: string }

type Events = {
  status: (s: ConnStatus) => void;
  synced: () => void;
  hello: (m: { you: Me; role: Role; doc: DocInfo | null }) => void;
  threads: (threads: Thread[], event?: ThreadEvent) => void;
  meta: (doc: DocInfo) => void;
  role: (role: Role) => void;
  /** Your identity changed (a guest renamed themselves). */
  you: (you: Me) => void;
  error: (message: string) => void;
  /** The server refused our changes: discard local state and reload from the server. */
  resync: (message: string) => void;
  /** Terminal: 4001 session ended, 4003 blocked / access removed, 4004 document deleted. */
  closed: (info: { code: number; reason: string }) => void;
};

export class DocProvider {
  readonly doc = new Y.Doc();
  readonly ytext = this.doc.getText('body');
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  status: ConnStatus = 'connecting';
  synced = false;
  role: Role | null = null;
  retryAt = 0;

  private ws: WebSocket | null = null;
  private attempts = 0;
  private retryTimer = 0;
  private destroyed = false;
  private reqSeq = 0;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: number }>();
  private handlers: { [K in keyof Events]?: Set<Events[K]> } = {};
  private unsent = false;

  constructor(readonly docId: string) {
    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
    window.addEventListener('beforeunload', this.onUnload);
    window.addEventListener('online', this.onOnline);
    document.addEventListener('visibilitychange', this.onVisible);
    this.connect();
  }

  on<K extends keyof Events>(event: K, fn: Events[K]): () => void {
    const handlers = this.handlers as Record<string, Set<unknown> | undefined>;
    const set = (handlers[event] ??= new Set()) as Set<Events[K]>;
    set.add(fn);
    return () => set.delete(fn);
  }

  private emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>) {
    for (const fn of (this.handlers[event] ?? []) as Set<(...a: Parameters<Events[K]>) => void>) {
      try { fn(...args); } catch (e) { console.error(`[provider] ${event} handler`, e); }
    }
  }

  get canEdit() { return atLeast(this.role, 'editor'); }
  /** Local edits not yet confirmed sent (offline typing). */
  get hasUnsent() { return this.unsent; }

  private setStatus(s: ConnStatus) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  connect() {
    if (this.destroyed) return;
    clearTimeout(this.retryTimer);
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?doc=${encodeURIComponent(this.docId)}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.setStatus('connecting');
    let opened = false;

    ws.onopen = () => {
      opened = true;
      this.attempts = 0;
      this.setStatus('online');
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeSyncStep1(enc, this.doc);
      this.sendBinary(encoding.toUint8Array(enc));
      if (this.awareness.getLocalState() !== null) this.sendAwareness([this.doc.clientID]);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') this.onText(ev.data);
      else this.onBinary(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onerror = () => { /* close follows */ };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.synced = false;
      for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('Connection lost. Try again in a moment.')); this.pending.delete(id); }
      const others = [...this.awareness.getStates().keys()].filter((c) => c !== this.doc.clientID);
      awarenessProtocol.removeAwarenessStates(this.awareness, others, this);
      if (this.destroyed) return;
      if (ev.code === 4001 || ev.code === 4003 || ev.code === 4004) {
        this.setStatus('closed');
        this.emit('closed', { code: ev.code, reason: ev.reason });
        return;
      }
      // 4500: the server failed to save and dropped the room. Reconnect promptly;
      // the Y.Doc is kept, so sync step 2 re-sends anything the server lacks.
      if (ev.code === 4500) this.attempts = 0;
      else if (!opened) this.attempts++;
      else this.attempts = Math.max(1, this.attempts);
      const base = ev.code === 4500 ? 300 : Math.min(30_000, 600 * 2 ** Math.min(this.attempts, 6));
      const delay = Math.round(base * (0.8 + Math.random() * 0.4));
      this.retryAt = Date.now() + delay;
      this.setStatus('offline');
      this.retryTimer = window.setTimeout(() => this.connect(), delay);
    };
  }

  /** Reconnect now (e.g. "Retry" button). */
  retryNow() {
    if (this.status === 'offline') { this.attempts = 0; this.connect(); }
  }

  private onOnline = () => this.retryNow();
  private onVisible = () => { if (document.visibilityState === 'visible') this.retryNow(); };
  private onUnload = () => {
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'unload');
  };

  private sendBinary(bytes: Uint8Array): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) { this.ws.send(bytes as Uint8Array<ArrayBuffer>); return true; }
    return false;
  }

  private sendAwareness(clients: number[]) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients));
    this.sendBinary(encoding.toUint8Array(enc));
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    // Offline edits stay in the Y.Doc and go out with sync step 2 on reconnect.
    if (!this.sendBinary(encoding.toUint8Array(enc))) this.unsent = true;
  };

  private onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === this) return;
    const mine = [...added, ...updated, ...removed].filter((c) => c === this.doc.clientID);
    if (mine.length) this.sendAwareness(mine);
  };

  private onBinary(data: Uint8Array) {
    const dec = decoding.createDecoder(data);
    const type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      const sub = decoding.readVarUint(dec);
      if (sub === syncProtocol.messageYjsSyncStep1) {
        const sv = decoding.readVarUint8Array(dec);
        // Readers never send content: a step 2 from them would carry our delete set and be refused.
        if (this.canEdit) {
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, MSG_SYNC);
          syncProtocol.writeSyncStep2(enc, this.doc, sv);
          if (this.sendBinary(encoding.toUint8Array(enc))) this.unsent = false;
        }
      } else if (sub === syncProtocol.messageYjsSyncStep2) {
        Y.applyUpdate(this.doc, decoding.readVarUint8Array(dec), this);
        if (!this.synced) { this.synced = true; this.emit('synced'); }
      } else if (sub === syncProtocol.messageYjsUpdate) {
        Y.applyUpdate(this.doc, decoding.readVarUint8Array(dec), this);
      }
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), this);
    }
  }

  private onText(raw: string) {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    switch (m.type) {
      case 'hello':
        this.role = m.role;
        this.emit('hello', { you: m.you, role: m.role, doc: m.doc });
        break;
      case 'threads': this.emit('threads', m.threads ?? [], m.event); break;
      case 'meta': if (m.doc) this.emit('meta', m.doc); break;
      case 'role': this.role = m.role; this.emit('role', m.role); break;
      case 'you': if (m.you?.sub) this.emit('you', m.you); break;
      case 'error':
        if (m.resync) this.emit('resync', String(m.message ?? 'Your changes were not saved.'));
        else this.emit('error', String(m.message ?? 'Something went wrong.'));
        break;
      case 'ack': {
        const p = this.pending.get(m.reqId);
        if (!p) break;
        this.pending.delete(m.reqId);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.data);
        else p.reject(new Error(m.error ?? 'Request failed.'));
        break;
      }
    }
  }

  /** Send a JSON request and wait for its ack. */
  request<T = unknown>(msg: Record<string, unknown>, timeoutMs = 12_000): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("You're offline. Try again when the connection is back."));
    const reqId = `q${++this.reqSeq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => { this.pending.delete(reqId); reject(new Error('The server did not respond. Try again.')); }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...msg, reqId }));
    });
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.retryTimer);
    window.removeEventListener('beforeunload', this.onUnload);
    window.removeEventListener('online', this.onOnline);
    document.removeEventListener('visibilitychange', this.onVisible);
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy');
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onclose = null; ws.onmessage = null; ws.close(1000, 'leaving'); }
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.awareness.destroy();
    this.doc.destroy();
    this.handlers = {};
  }
}
