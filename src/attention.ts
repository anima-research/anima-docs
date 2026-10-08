// Agent attention: who hears about what, when, and whether it wakes them.
//
// Every principal with an MCPL session can set its own wake gates per document
// (or '*' for all). The server evaluates the gate and labels each event
// `docs:wake` or `docs:quiet`; one operator rule on the host maps those to
// wake / defer. Edits and comment activity are RFC-006 *deferred* subjects:
// the host holds one pending slot per document and asks us to render "what
// changed since you last looked" only when it is about to show the agent.
// Comments that address the agent (mention, assignment, reply in its thread)
// are *plain* subjects keyed per comment, so an edit replaces an unread
// mention and a deletion retracts it.

import { randomBytes } from 'node:crypto';
import * as Y from 'yjs';
import type { DB } from './db.js';
import { Fault } from './auth.js';
import { isGuest, type Principals } from './principals.js';
import { Documents, type DeleteSet, type DocChange, type Role } from './documents.js';
import { suggestionSummary, type CommentEvent, type Comments, type Thread } from './comments.js';
import { textChanges, firstLook } from './diff.js';
import { outline, sectionPath } from './markdown.js';

export type Level = 'wake' | 'quiet' | 'off';

export interface WatchSettings {
  /** Edits to the document text by others. Rendered as an attributed diff. */
  edits: Level;
  /** Comment activity not addressed to you (new threads, replies elsewhere, resolutions). */
  comments: Level;
  /** @mentions of you and threads assigned to you. Always delivered. */
  mentions: 'wake' | 'quiet';
  /** Replies in threads you started or took part in. */
  replies: Level;
  /** Documents shared with you (only meaningful on '*'). */
  shares: Level;
  /** Whose activity may wake you; activity by anyone else is delivered quietly. */
  from: 'anyone' | 'humans' | 'agents' | string[];
  /**
   * Guests (people who came in through an "anyone with the link" link without
   * signing in): wake = they count as humans for \`from\`; quiet = delivered,
   * never wakes; off = their activity never triggers a delivery.
   */
  guests: Level;
  /** Edits smaller than this (chars added+removed by qualifying authors) don't wake. */
  min_chars: number;
  /** If set, only edits under these headings wake (substring match on the heading path). */
  sections: string[];
  /** If set, only edits whose inserted text contains one of these (case-insensitive) wake. */
  keywords: string[];
  /** Wait for this many seconds without further edits before notifying (typing settles). */
  settle_seconds: number;
  /** After an edit wake from this document, further edits stay quiet for this long. */
  cooldown_seconds: number;
  /** ISO time; until then nothing from this scope wakes you (everything is delivered quietly). */
  quiet_until: string | null;
}

export const BASE_SETTINGS: WatchSettings = {
  edits: 'off', comments: 'off', mentions: 'wake', replies: 'wake', shares: 'wake',
  from: 'anyone', guests: 'quiet', min_chars: 0, sections: [], keywords: [], settle_seconds: 10, cooldown_seconds: 0, quiet_until: null,
};
/** What `watch` means when a document is first watched without options. */
/** Separate addressed deliveries from guests per (agent, document) per hour. */
const GUEST_ADDRESSED_PER_HOUR = 10;

export const WATCH_PRESET: Partial<WatchSettings> = { edits: 'quiet', comments: 'wake', from: 'humans' };

export interface Notice { eventId: string; timestamp: string; data?: unknown }
export interface PushParams {
  featureSet: string;
  eventId: string;
  timestamp: string;
  tags: string[];
  origin?: Record<string, unknown>;
  coalesce?: { key: string; deferred?: boolean; retract?: boolean; initial?: boolean; data?: unknown };
  payload: { content: { type: 'text'; text: string }[] };
}
export interface PushResult { accepted: boolean; reason?: string; inferenceId?: string; coalesce?: { outcome: string; priorEventId?: string } }

/** What the attention engine needs from an MCPL connection. */
export interface AgentSession {
  id: string;
  sub: string;
  /** docs.watch enabled and pushEvents granted. */
  pushReady(): boolean;
  coalescing(): { plain: boolean; deferred: boolean; initial: boolean };
  push(p: PushParams): Promise<PushResult | null>;
}

export const FEATURE_SET = 'docs.watch';

interface EditAccum {
  first: number; last: number;
  authors: Set<string>; qualifying: Set<string>;
  chars: number; qualifyingChars: number;
  sections: Set<string>; keywordHit: boolean;
  timer: NodeJS.Timeout | null;
}
interface CommentAccum { actors: Set<string>; qualifying: boolean; timer: NodeJS.Timeout | null }
/** Suggestions for an owner, and decisions for a suggester, gathered until the burst settles. */
interface SuggestAccum { created: Set<string>; decided: Map<string, { kind: 'accepted' | 'rejected'; by: string; note: string | null }>; first: number; timer: NodeJS.Timeout | null }

/** Wait this long after the last suggestion (or revision) in a burst before telling the owner. */
const SUGGEST_SETTLE_MS = 20_000;
/** ...but never longer than this after the first. */
const SUGGEST_MAX_WAIT_MS = 120_000;

const SUBJECT_EDITS = (docId: string) => `doc:${docId}:edits`;
const SUBJECT_COMMENTS = (docId: string) => `doc:${docId}:comments`;
const SUBJECT_COMMENT = (commentId: string) => `comment:${commentId}`;
const SUBJECT_SHARE = (docId: string) => `share:${docId}`;
const eventId = (kind: string) => `${kind}_${Date.now().toString(36)}_${randomBytes(5).toString('hex')}`;
const iso = (ms = Date.now()) => new Date(ms).toISOString();

export class Attention {
  private sessions = new Map<string, Set<AgentSession>>();
  private edits = new Map<string, EditAccum>();
  private commentAccums = new Map<string, CommentAccum>();
  private suggestAccums = new Map<string, SuggestAccum>();
  private lastWake = new Map<string, number>();
  /** Subs whose outbox is being flushed: new deliveries queue behind it, in order. */
  private flushing = new Set<string>();
  /** Per-subject render serialization (RFC-006 §5.2: one baseline advance at a time). */
  private renderChains = new Map<string, Promise<unknown>>();
  private closed = false;

  constructor(
    private db: DB,
    private docs: Documents,
    private comments: Comments,
    private principals: Principals,
    private opts: { commentSettleMs?: number; suggestSettleMs?: number; log?: (msg: string) => void } = {},
  ) {
    docs.on('change', (c: DocChange) => this.onChange(c));
    docs.on('share', (e: { docId: string; sub: string | null; role: string; by: string }) => this.onShare(e));
    comments.on('event', (e: CommentEvent) => this.onComment(e));
  }

  private log(msg: string) { (this.opts.log ?? ((m) => console.log(`[attention] ${m}`)))(msg); }

  close() {
    this.closed = true;
    for (const a of this.edits.values()) if (a.timer) clearTimeout(a.timer);
    for (const a of this.commentAccums.values()) if (a.timer) clearTimeout(a.timer);
    for (const a of this.suggestAccums.values()) if (a.timer) clearTimeout(a.timer);
  }

  // ------------------------------------------------------------------ settings

  rawWatch(sub: string, docId: string): Partial<WatchSettings> | null {
    const r = this.db.prepare('SELECT settings FROM watches WHERE sub = ? AND doc_id = ?').get(sub, docId) as { settings: string } | undefined;
    return r ? JSON.parse(r.settings) : null;
  }

  settings(sub: string, docId: string): WatchSettings {
    return { ...BASE_SETTINGS, ...(this.rawWatch(sub, '*') ?? {}), ...(docId === '*' ? {} : this.rawWatch(sub, docId) ?? {}) };
  }

  setWatch(sub: string, docId: string, patch: Partial<WatchSettings>, opts: { preset?: boolean } = {}): WatchSettings {
    const clean = validateSettings(patch);
    const existing = this.rawWatch(sub, docId);
    const next = { ...(existing ?? (opts.preset && docId !== '*' ? WATCH_PRESET : {})), ...clean };
    this.db.prepare(`INSERT INTO watches (sub, doc_id, settings, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(sub, doc_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`)
      .run(sub, docId, JSON.stringify(next), Date.now());
    return this.settings(sub, docId);
  }

  unwatch(sub: string, docId: string): boolean {
    for (const k of [`${sub}\0${docId}`]) {
      const a = this.edits.get(k); if (a?.timer) clearTimeout(a.timer); this.edits.delete(k);
      const c = this.commentAccums.get(k); if (c?.timer) clearTimeout(c.timer); this.commentAccums.delete(k);
    }
    return this.db.prepare('DELETE FROM watches WHERE sub = ? AND doc_id = ?').run(sub, docId).changes > 0;
  }

  watches(sub: string): { docId: string; settings: Partial<WatchSettings>; updatedAt: number }[] {
    return (this.db.prepare('SELECT doc_id, settings, updated_at FROM watches WHERE sub = ? ORDER BY updated_at DESC').all(sub) as any[])
      .map((r) => ({ docId: r.doc_id, settings: JSON.parse(r.settings), updatedAt: r.updated_at }));
  }

  /** Principals whose effective edits/comments level on `docId` is not 'off'. */
  private watchersOf(docId: string, field: 'edits' | 'comments'): string[] {
    const subs = (this.db.prepare(`SELECT DISTINCT sub FROM watches WHERE doc_id IN (?, '*')`).all(docId) as { sub: string }[]).map((r) => r.sub);
    return subs.filter((s) => this.settings(s, docId)[field] !== 'off');
  }

  // ------------------------------------------------------------------ baselines

  baseline(sub: string, docId: string): { snapshot: Y.Snapshot; commentSeq: number; updatedAt: number } | null {
    const r = this.db.prepare('SELECT snapshot, comment_seq, updated_at FROM baselines WHERE sub = ? AND doc_id = ?').get(sub, docId) as
      { snapshot: Buffer; comment_seq: number; updated_at: number } | undefined;
    return r ? { snapshot: Y.decodeSnapshot(r.snapshot), commentSeq: r.comment_seq, updatedAt: r.updated_at } : null;
  }

  private saveBaseline(sub: string, docId: string, p: { snapshot?: Y.Snapshot; commentSeq?: number }) {
    const prev = this.baseline(sub, docId);
    const snap = p.snapshot ?? prev?.snapshot ?? this.docs.snapshot(docId);
    const seq = p.commentSeq ?? prev?.commentSeq ?? this.comments.lastSeq(docId);
    this.db.prepare(`INSERT INTO baselines (sub, doc_id, snapshot, comment_seq, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(sub, doc_id) DO UPDATE SET snapshot = excluded.snapshot, comment_seq = excluded.comment_seq, updated_at = excluded.updated_at`)
      .run(sub, docId, Buffer.from(Y.encodeSnapshot(snap)), seq, Date.now());
  }

  /** The agent has seen the whole current text (and, optionally, all comments). */
  markRead(sub: string, docId: string, opts: { comments?: boolean } = {}) {
    this.saveBaseline(sub, docId, { snapshot: this.docs.snapshot(docId), ...(opts.comments ? { commentSeq: this.comments.lastSeq(docId) } : {}) });
  }

  markCommentsRead(sub: string, docId: string) {
    this.saveBaseline(sub, docId, { commentSeq: this.comments.lastSeq(docId) });
  }

  /** The agent edited: fold its own change into what it has seen. */
  noteOwnEdit(sub: string, docId: string, client: number, deleteSet: DeleteSet) {
    const prev = this.baseline(sub, docId);
    const snapshot = prev ? Documents.foldOwnEdit(prev.snapshot, this.docs.ydoc(docId), client, deleteSet) : this.docs.snapshot(docId);
    this.saveBaseline(sub, docId, { snapshot });
  }

  // ------------------------------------------------------------------ sessions

  register(s: AgentSession) {
    let set = this.sessions.get(s.sub);
    if (!set) this.sessions.set(s.sub, set = new Set());
    set.add(s);
  }

  unregister(s: AgentSession) {
    const set = this.sessions.get(s.sub);
    set?.delete(s);
    if (set && !set.size) this.sessions.delete(s.sub);
  }

  private live(sub: string): AgentSession[] {
    return [...(this.sessions.get(sub) ?? [])].filter((s) => s.pushReady());
  }

  /** A session just became push-capable: deliver what accumulated while away. */
  async ready(s: AgentSession) {
    await this.flushOutbox(s.sub);
    const docIds = new Set<string>();
    for (const w of this.watches(s.sub)) if (w.docId !== '*') docIds.add(w.docId);
    if (this.rawWatch(s.sub, '*')) {
      for (const r of this.db.prepare('SELECT doc_id FROM baselines WHERE sub = ?').all(s.sub) as { doc_id: string }[]) docIds.add(r.doc_id);
    }
    for (const docId of docIds) {
      const doc = this.docs.get(docId);
      if (!doc || !this.access(s.sub, docId)) continue;
      const st = this.settings(s.sub, docId);
      const base = this.baseline(s.sub, docId);
      if (!base) continue;
      if (st.edits !== 'off' && doc.updatedAt > base.updatedAt) {
        const c = textChanges(this.docs, this.principals, docId, base.snapshot, { title: doc.title });
        const others = c.authors.filter((a) => a !== s.sub && !(st.guests === 'off' && isGuest(a)));
        if (c.changed && others.length) {
          const acc = this.editAccum(s.sub, docId);
          for (const a of others) { acc.authors.add(a); if (this.qualifies(st, a)) acc.qualifying.add(a); }
          acc.chars += c.added + c.removed;
          acc.qualifyingChars += c.added + c.removed;
          acc.keywordHit = true; // unknown; don't let a keyword filter swallow a catch-up
          this.bg(this.flushEdits(s.sub, docId));
        }
      }
      if (st.comments !== 'off' && this.comments.lastSeq(docId) > base.commentSeq) {
        const evs = this.comments.eventsSince(docId, base.commentSeq).filter((e) => e.actor !== s.sub && !(st.guests === 'off' && isGuest(e.actor)));
        if (evs.length) {
          const acc = this.commentAccum(s.sub, docId);
          for (const e of evs) { acc.actors.add(e.actor); if (this.qualifies(st, e.actor)) acc.qualifying = true; }
          this.bg(this.flushComments(s.sub, docId));
        }
      }
    }
  }

  private access(sub: string, docId: string): Role | null {
    const p = this.principals.get(sub);
    if (!p || p.role === 'blocked') return null;
    return this.docs.role(docId, { sub, admin: p.role === 'admin' });
  }

  private qualifies(st: WatchSettings, actorSub: string): boolean {
    if (isGuest(actorSub)) return st.guests === 'wake' && (st.from === 'anyone' || st.from === 'humans');
    if (st.from === 'anyone') return true;
    const p = this.principals.get(actorSub);
    if (st.from === 'humans') return p?.kind === 'human';
    if (st.from === 'agents') return p?.kind === 'agent' || p?.kind === 'service';
    return st.from.some((f) => f === actorSub || (p && f.replace(/^@/, '').toLowerCase() === p.name.toLowerCase()));
  }

  private quietNow(st: WatchSettings): boolean {
    return !!st.quiet_until && Date.parse(st.quiet_until) > Date.now();
  }

  // ------------------------------------------------------------------ edits

  private editAccum(sub: string, docId: string): EditAccum {
    const k = `${sub}\0${docId}`;
    let a = this.edits.get(k);
    if (!a) this.edits.set(k, a = { first: Date.now(), last: Date.now(), authors: new Set(), qualifying: new Set(), chars: 0, qualifyingChars: 0, sections: new Set(), keywordHit: false, timer: null });
    return a;
  }

  private onChange(c: DocChange) {
    if (this.closed) return;
    const watchers = this.watchersOf(c.docId, 'edits').filter((s) => s !== c.origin.sub);
    if (!watchers.length) return;
    let sections: string[] | null = null;
    const sectionsHit = () => {
      if (sections) return sections;
      const heads = outline(this.docs.text(c.docId));
      const set = new Set<string>();
      for (const [from] of c.ranges) for (const s of sectionPath(heads, from)) set.add(s);
      return (sections = [...set]);
    };
    for (const sub of watchers) {
      if (!this.access(sub, c.docId)) continue;
      const st = this.settings(sub, c.docId);
      if (st.guests === 'off' && isGuest(c.origin.sub)) continue;
      const a = this.editAccum(sub, c.docId);
      a.last = Date.now();
      a.authors.add(c.origin.sub);
      a.chars += c.added + c.removed;
      if (this.qualifies(st, c.origin.sub)) {
        a.qualifying.add(c.origin.sub);
        a.qualifyingChars += c.added + c.removed;
        if (st.sections.length) for (const s of sectionsHit()) a.sections.add(s);
        if (st.keywords.length && !a.keywordHit) { const low = c.inserted.toLowerCase(); a.keywordHit = st.keywords.some((k) => low.includes(k.toLowerCase())); }
      }
      const settle = st.settle_seconds * 1000;
      const maxWait = Math.min(Math.max(settle * 6, 60_000), 600_000);
      const due = Math.min(a.last + settle, a.first + maxWait);
      if (a.timer) clearTimeout(a.timer);
      a.timer = setTimeout(() => this.bg(this.flushEdits(sub, c.docId)), Math.max(0, due - Date.now()));
      a.timer.unref?.();
    }
  }

  /** Run background work; failures are logged, never thrown into the event loop. */
  private bg(p: Promise<unknown>) {
    p.catch((e) => this.log(`background delivery failed: ${(e as Error).message}`));
  }

  private editLevel(sub: string, docId: string, st: WatchSettings, a: EditAccum): Level {
    if (st.edits !== 'wake') return st.edits;
    if (!a.qualifying.size) return 'quiet';
    if (a.qualifyingChars < st.min_chars) return 'quiet';
    if (st.sections.length && ![...a.sections].some((sec) => st.sections.some((want) => sec.toLowerCase().includes(want.toLowerCase())))) return 'quiet';
    if (st.keywords.length && !a.keywordHit) return 'quiet';
    if (this.quietNow(st)) return 'quiet';
    const last = this.lastWake.get(`${sub}\0${docId}`) ?? 0;
    if (st.cooldown_seconds && Date.now() - last < st.cooldown_seconds * 1000) return 'quiet';
    return 'wake';
  }

  private async flushEdits(sub: string, docId: string) {
    const k = `${sub}\0${docId}`;
    const a = this.edits.get(k);
    if (!a) return;
    if (a.timer) clearTimeout(a.timer);
    this.edits.delete(k);
    const doc = this.docs.get(docId);
    if (!doc || !this.access(sub, docId)) return;
    const st = this.settings(sub, docId);
    const level = this.editLevel(sub, docId, st, a);
    if (level === 'off') return;
    const sessions = this.live(sub);
    if (!sessions.length) return; // catch-up on reconnect recomputes from the baseline
    if (level === 'wake') this.lastWake.set(k, Date.now());
    const names = [...a.authors].map((s) => this.principals.label(s));
    const kinds = new Set([...a.authors].map((s) => this.principals.get(s)?.kind));
    const tags = ['docs:edit', level === 'wake' ? 'docs:wake' : 'docs:quiet',
      ...(kinds.has('human') || kinds.has('guest') ? ['chat:from-human'] : []), ...(kinds.has('agent') || kinds.has('service') ? ['chat:from-agent'] : []),
      ...(kinds.has('guest') ? ['docs:from-guest'] : [])];
    const fallback = `“${doc.title}” (${docId}) was edited by ${names.join(', ')}. Details unavailable here — use read_document {"document":"${docId}"} to see the current text.`;
    for (const s of sessions) {
      const caps = s.coalescing();
      if (caps.deferred) {
        await this.pushTo(s, {
          featureSet: FEATURE_SET, eventId: eventId('edit'), timestamp: iso(), tags,
          origin: { documentId: docId, title: doc.title, authors: [...a.authors] },
          coalesce: { key: SUBJECT_EDITS(docId), deferred: true, data: { authors: [...a.authors].slice(0, 20), chars: a.chars } },
          payload: { content: [{ type: 'text', text: fallback }] },
        });
      } else {
        // Append-only host: describe now and advance the baseline now (restored if the push fails).
        const prior = this.baseline(sub, docId);
        const text = await this.renderEdits(sub, docId);
        if (!text) continue;
        const ok = await this.pushTo(s, {
          featureSet: FEATURE_SET, eventId: eventId('edit'), timestamp: iso(), tags,
          origin: { documentId: docId, title: doc.title, authors: [...a.authors] },
          payload: { content: [{ type: 'text', text }] },
        });
        if (!ok && prior) this.saveBaseline(sub, docId, { snapshot: prior.snapshot });
      }
    }
  }

  /** Describe edits since the agent's baseline and advance it. Empty string = nothing new. */
  renderEdits(sub: string, docId: string): Promise<string> {
    return this.serialize(`${sub}\0${SUBJECT_EDITS(docId)}`, async () => {
      const doc = this.docs.get(docId);
      if (!doc || !this.access(sub, docId)) return '';
      const base = this.baseline(sub, docId);
      if (!base) {
        this.markRead(sub, docId); // the outline counts as a first look; diffs start here
        return firstLook(this.docs.text(docId), doc.title, docId);
      }
      const c = textChanges(this.docs, this.principals, docId, base.snapshot, { title: doc.title });
      this.saveBaseline(sub, docId, { snapshot: this.docs.snapshot(docId) });
      return c.changed ? c.text : '';
    });
  }

  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.renderChains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.renderChains.set(key, tail);
    void tail.then(() => { if (this.renderChains.get(key) === tail) this.renderChains.delete(key); });
    return next;
  }

  // ------------------------------------------------------------------ comments

  private commentAccum(sub: string, docId: string): CommentAccum {
    const k = `${sub}\0${docId}`;
    let a = this.commentAccums.get(k);
    if (!a) this.commentAccums.set(k, a = { actors: new Set(), qualifying: false, timer: null });
    return a;
  }

  private onComment(e: CommentEvent) {
    if (this.closed) return;
    const comment = this.comments.get(e.commentId);
    if (!comment) return;
    /** Recipients of an addressed delivery for this event (kept out of their digest). */
    const handled = new Set<string>();

    // 1. Addressed: mentions and assignments made by this event.
    const guestActor = isGuest(e.actor);
    const ignores = (sub: string) => guestActor && this.settings(sub, e.docId).guests === 'off';
    for (const t of e.newlyAddressed) {
      if (t.sub === e.actor || !this.access(t.sub, e.docId) || ignores(t.sub)) continue;
      handled.add(t.sub);
      if (t.reason === 'suggestion' || t.reason === 'decision') this.queueSuggestionNotice(t.sub, e);
      else this.bg(this.deliverAddressed(t.sub, e, t.reason));
    }
    // A suggester still revising: hold the owner's notice until they pause.
    if (e.kind === 'edited' && e.commentId === e.threadId && comment.suggestion) this.extendSuggestionNotices(e.docId, e.threadId);

    // 2. Replies in threads the recipient started or took part in.
    if (e.kind === 'replied') {
      const thread = this.comments.thread(e.threadId);
      const participants = new Set<string>();
      if (thread) {
        participants.add(thread.root.author);
        if (thread.root.assignee) participants.add(thread.root.assignee);
        for (const r of thread.replies) participants.add(r.author);
      }
      for (const p of participants) {
        if (p === e.actor || handled.has(p) || !this.access(p, e.docId) || ignores(p)) continue;
        if (this.settings(p, e.docId).replies === 'off') continue;
        handled.add(p);
        this.bg(this.deliverAddressed(p, e, 'reply'));
      }
    }

    // 3. Edits and deletions of comments already addressed to someone: one
    //    replacement or retraction per (recipient, comment).
    if (e.kind === 'edited' || e.kind === 'deleted') {
      const ids = e.kind === 'deleted' && e.commentId === e.threadId
        ? (this.db.prepare('SELECT id FROM comments WHERE thread_id = ?').all(e.threadId) as { id: string }[]).map((r) => r.id)
        : [e.commentId];
      const rows = this.db.prepare(`SELECT sub, comment_id, reason, level FROM addressed WHERE comment_id IN (${ids.map(() => '?').join(',')}) AND reason IN ('mention', 'assigned', 'reply')`).all(...ids) as
        { sub: string; comment_id: string; reason: 'mention' | 'assigned' | 'reply'; level: string }[];
      for (const r of rows) {
        if (e.kind === 'edited') {
          if (handled.has(r.sub) || !this.access(r.sub, e.docId)) continue;
          handled.add(r.sub);
          this.bg(this.deliverAddressed(r.sub, e, r.reason, { replacement: true, level: r.level }));
        } else {
          handled.add(r.sub);
          this.bg(this.retractAddressed(r.sub, r.comment_id, e));
        }
      }
    }

    // 4. Everyone else watching comments gets the deferred digest.
    for (const sub of this.watchersOf(e.docId, 'comments')) {
      if (sub === e.actor || handled.has(sub) || !this.access(sub, e.docId) || ignores(sub)) continue;
      const st = this.settings(sub, e.docId);
      const a = this.commentAccum(sub, e.docId);
      a.actors.add(e.actor);
      if (this.qualifies(st, e.actor)) a.qualifying = true;
      if (a.timer) clearTimeout(a.timer);
      a.timer = setTimeout(() => this.bg(this.flushComments(sub, e.docId)), this.opts.commentSettleMs ?? 3000);
      a.timer.unref?.();
    }
  }

  private async flushComments(sub: string, docId: string) {
    const k = `${sub}\0${docId}`;
    const a = this.commentAccums.get(k);
    if (!a) return;
    if (a.timer) clearTimeout(a.timer);
    this.commentAccums.delete(k);
    const doc = this.docs.get(docId);
    if (!doc || !this.access(sub, docId)) return;
    const st = this.settings(sub, docId);
    if (st.comments === 'off') return;
    const sessions = this.live(sub);
    if (!sessions.length) return;
    const level: Level = st.comments === 'wake' && a.qualifying && !this.quietNow(st) ? 'wake' : 'quiet';
    const names = [...a.actors].map((s) => this.principals.label(s));
    const kinds = new Set([...a.actors].map((x) => this.principals.get(x)?.kind));
    const tags = ['docs:comment', level === 'wake' ? 'docs:wake' : 'docs:quiet',
      ...(kinds.has('human') || kinds.has('guest') ? ['chat:from-human'] : []), ...(kinds.has('agent') || kinds.has('service') ? ['chat:from-agent'] : []),
      ...(kinds.has('guest') ? ['docs:from-guest'] : [])];
    const fallback = `New comment activity on “${doc.title}” (${docId}) by ${names.join(', ')}. Use list_comments {"document":"${docId}"} to read it.`;
    for (const s of sessions) {
      if (s.coalescing().deferred) {
        await this.pushTo(s, {
          featureSet: FEATURE_SET, eventId: eventId('cmt'), timestamp: iso(), tags,
          origin: { documentId: docId, title: doc.title, actors: [...a.actors] },
          coalesce: { key: SUBJECT_COMMENTS(docId), deferred: true, data: { actors: [...a.actors].slice(0, 20) } },
          payload: { content: [{ type: 'text', text: fallback }] },
        });
      } else {
        const prior = this.baseline(sub, docId);
        const text = await this.renderComments(sub, docId);
        if (!text) continue;
        const ok = await this.pushTo(s, { featureSet: FEATURE_SET, eventId: eventId('cmt'), timestamp: iso(), tags, origin: { documentId: docId }, payload: { content: [{ type: 'text', text }] } });
        if (!ok && prior) this.saveBaseline(sub, docId, { commentSeq: prior.commentSeq });
      }
    }
  }

  /** Comment activity since the agent's comment baseline, excluding its own and what reached it as addressed events. */
  renderComments(sub: string, docId: string): Promise<string> {
    return this.serialize(`${sub}\0${SUBJECT_COMMENTS(docId)}`, async () => {
      const doc = this.docs.get(docId);
      if (!doc || !this.access(sub, docId)) return '';
      const base = this.baseline(sub, docId);
      const since = base?.commentSeq ?? Math.max(0, this.comments.lastSeq(docId) - 20);
      const evs = this.comments.eventsSince(docId, since, 500);
      const last = evs.length ? evs[evs.length - 1].seq : since;
      this.saveBaseline(sub, docId, { commentSeq: last });
      const addressed = new Set((this.db.prepare('SELECT comment_id FROM addressed WHERE sub = ?').all(sub) as { comment_id: string }[]).map((r) => r.comment_id));
      const lines: string[] = [];
      const st = this.settings(sub, docId);
      for (const e of evs) {
        if (e.actor === sub) continue;
        if (st.guests === 'off' && isGuest(e.actor)) continue;
        if (addressed.has(e.commentId) && (e.kind === 'created' || e.kind === 'replied' || e.kind === 'edited' || e.kind === 'accepted' || e.kind === 'rejected')) continue;
        const line = this.describeCommentEvent(e);
        if (line) lines.push(line);
      }
      if (!lines.length) return '';
      const shown = lines.slice(-40);
      return `Comment activity on “${doc.title}” (${docId}):\n` + shown.join('\n')
        + (lines.length > shown.length ? `\n… ${lines.length - shown.length} earlier items not shown (list_comments for everything).` : '');
    });
  }

  private describeCommentEvent(e: CommentEvent): string | null {
    const who = this.principals.label(e.actor);
    const c = this.comments.get(e.commentId);
    const root = this.comments.get(e.threadId);
    const on = root?.quote ? ` on “${clip(root.quote, 80)}”` : '';
    const sg = root?.suggestion;
    if (sg) {
      const what = suggestionSummary(sg, 240);
      const note = c && c.id !== root.id && !c.deletedAt ? ` — “${clip(c.body, 300)}”` : '';
      switch (e.kind) {
        case 'created': return root && !root.deletedAt ? `• ${who} suggested [${e.threadId}]: ${what}${root.body ? ` — “${clip(root.body, 300)}”` : ''}` : null;
        case 'edited': return root && !root.deletedAt && e.commentId === root.id ? `• ${who} revised suggestion ${e.threadId}: ${what}` : null;
        case 'accepted': return `• ${who} accepted ${this.principals.label(root.author)}'s suggestion ${e.threadId}: ${what}${note}`;
        case 'rejected': return `• ${who} rejected ${this.principals.label(root.author)}'s suggestion ${e.threadId}: ${what}${note}`;
        case 'deleted': if (e.commentId === e.threadId) return `• ${who} withdrew suggestion ${e.threadId}: ${what}`; break;
      }
    }
    switch (e.kind) {
      case 'accepted': case 'rejected': return null;
      case 'created': return c && !c.deletedAt ? `• ${who} commented${on} [thread ${e.threadId}]: ${clip(c.body, 600)}` : null;
      case 'replied': return c && !c.deletedAt ? `• ${who} replied in thread ${e.threadId}${on}: ${clip(c.body, 600)}` : null;
      case 'edited': return c && !c.deletedAt ? `• ${who} edited comment ${e.commentId} in thread ${e.threadId}: ${clip(c.body, 400)}` : null;
      case 'deleted': return `• ${who} deleted ${e.commentId === e.threadId ? `thread ${e.threadId}` : `a comment in thread ${e.threadId}`}${on}`;
      case 'resolved': return `• ${who} resolved thread ${e.threadId}${on}`;
      case 'reopened': return `• ${who} reopened thread ${e.threadId}${on}`;
      case 'assigned': return root?.assignee ? `• ${who} assigned thread ${e.threadId}${on} to ${this.principals.label(root.assignee)}` : `• ${who} unassigned thread ${e.threadId}`;
    }
  }

  // ------------------------------------------------------------------ suggestions

  /** Gather a new suggestion (for the owner) or a decision (for the suggester) into one settled notice. */
  private queueSuggestionNotice(sub: string, e: CommentEvent) {
    const p = this.principals.get(sub);
    if (!p || p.kind === 'human' || p.kind === 'guest') return; // people see suggestions in the web UI
    const k = `${sub}\0${e.docId}`;
    let a = this.suggestAccums.get(k);
    if (!a) this.suggestAccums.set(k, a = { created: new Set(), decided: new Map(), first: Date.now(), timer: null });
    if (e.kind === 'created') a.created.add(e.threadId);
    else if (e.kind === 'accepted' || e.kind === 'rejected') {
      const note = e.commentId !== e.threadId ? this.comments.get(e.commentId)?.body ?? null : null;
      a.decided.set(e.threadId, { kind: e.kind, by: e.actor, note });
    }
    this.armSuggestionNotice(k, sub, e.docId, a);
  }

  private armSuggestionNotice(k: string, sub: string, docId: string, a: SuggestAccum) {
    if (a.timer) clearTimeout(a.timer);
    const settle = this.opts.suggestSettleMs ?? SUGGEST_SETTLE_MS;
    const wait = Math.max(0, Math.min(settle, a.first + Math.max(settle, SUGGEST_MAX_WAIT_MS) - Date.now()));
    a.timer = setTimeout(() => this.bg(this.flushSuggestions(sub, docId)), wait);
    a.timer.unref?.();
  }

  private extendSuggestionNotices(docId: string, threadId: string) {
    for (const [k, a] of this.suggestAccums) {
      if (!a.created.has(threadId)) continue;
      const [sub, d] = k.split('\0');
      if (d === docId) this.armSuggestionNotice(k, sub, docId, a);
    }
  }

  private async flushSuggestions(sub: string, docId: string) {
    const k = `${sub}\0${docId}`;
    const a = this.suggestAccums.get(k);
    if (!a) return;
    if (a.timer) clearTimeout(a.timer);
    this.suggestAccums.delete(k);
    const doc = this.docs.get(docId);
    if (!doc || !this.access(sub, docId)) return;
    const st = this.settings(sub, docId);
    const live = (id: string) => { const t = this.comments.thread(id); return t && !t.root.deletedAt && t.suggestion ? t : null; };
    let created = [...a.created].map(live).filter((t): t is Thread => !!t && t.suggestion!.status === 'open');
    if (st.guests === 'off') created = created.filter((t) => !isGuest(t.root.author));
    const decided = st.replies === 'off' ? [] : [...a.decided].map(([id, d]) => ({ t: live(id), ...d }))
      .filter((x): x is { t: Thread; kind: 'accepted' | 'rejected'; by: string; note: string | null } => !!x.t && x.t.suggestion!.status === x.kind);
    if (!created.length && !decided.length) return;
    const authors = new Set([...created.map((t) => t.root.author), ...decided.map((d) => d.by)]);
    const allGuests = [...authors].every((s) => isGuest(s));
    if (allGuests && !this.allowGuestDelivery(sub, docId)) return;
    const kinds = new Set([...authors].map((s) => this.principals.get(s)?.kind));
    const wake = !this.quietNow(st) && (created.length
      ? st.mentions === 'wake' && (!allGuests || st.guests === 'wake')
      : st.replies === 'wake');
    const tags = ['docs:suggestion', 'chat:addressed',
      ...(kinds.has('human') || kinds.has('guest') ? ['chat:from-human'] : []), ...(kinds.has('agent') || kinds.has('service') ? ['chat:from-agent'] : []),
      ...(allGuests ? ['docs:from-guest'] : []),
      wake ? 'docs:wake' : 'docs:quiet'];
    const text = this.suggestionNoticeText(doc, created, decided);
    const now = Date.now();
    const mark = this.db.prepare(`INSERT INTO addressed (sub, comment_id, doc_id, reason, level, at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(sub, comment_id) DO UPDATE SET at = excluded.at`);
    for (const t of created) mark.run(sub, t.root.id, docId, 'suggestion', wake ? 'wake' : 'quiet', now);
    for (const d of decided) {
      // The decision event's comment is its note, if it had one, else the suggestion itself.
      const ev = this.db.prepare(`SELECT comment_id FROM comment_events WHERE thread_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1`).get(d.t.root.id, d.kind) as { comment_id: string } | undefined;
      mark.run(sub, ev?.comment_id ?? d.t.root.id, docId, 'decision', wake ? 'wake' : 'quiet', now);
    }
    await this.sendOrQueue(sub, {
      featureSet: FEATURE_SET, eventId: eventId('sug'), timestamp: iso(), tags,
      origin: { documentId: docId, title: doc.title, suggestions: created.map((t) => t.root.id), decided: decided.map((d) => d.t.root.id) },
      coalesce: { key: `suggestions:${docId}:${randomBytes(4).toString('hex')}`, initial: true },
      payload: { content: [{ type: 'text', text }] },
    }, docId);
  }

  private suggestionNoticeText(doc: { id: string; title: string }, created: Thread[], decided: { t: Thread; kind: 'accepted' | 'rejected'; by: string; note: string | null }[]): string {
    const L = (s: string) => this.principals.label(s);
    const out: string[] = [];
    const line = (t: Thread) => (t.anchor && !t.anchor.orphaned ? ` (line ${t.anchor.line})` : '');
    if (created.length) {
      const by = [...new Set(created.map((t) => t.root.author))].map(L).join(', ');
      out.push(`${by} suggested ${created.length === 1 ? 'a change' : `${created.length} changes`} to “${doc.title}” (${doc.id}), which you own. You decide:`);
      for (const t of created.slice(0, 25)) {
        out.push(`  [${t.root.id}]${line(t)} ${suggestionSummary(t.suggestion!, 400, t.anchor)}${t.suggestion!.outdated ? ' — OUTDATED (the text has since changed)' : ''}`);
        if (t.root.body) out.push(`      note: ${clip(t.root.body, 500)}`);
      }
      if (created.length > 25) out.push(`  … and ${created.length - 25} more.`);
      const ids = created.slice(0, 3).map((t) => JSON.stringify(t.root.id)).join(',');
      out.push(`Accept with accept_suggestion {"suggestions":[${ids}]}, reject with reject_suggestion {"suggestions":[…],"reason":"…"}, or discuss with reply_comment. list_comments {"document":"${doc.id}","only":"suggestions"} shows them in full; read_document {"document":"${doc.id}","suggestions":"inline"} shows them in place.`);
    }
    for (const d of decided) {
      out.push(`${L(d.by)} ${d.kind} your suggestion ${d.t.root.id} on “${doc.title}” (${doc.id}): ${suggestionSummary(d.t.suggestion!, 300)}${d.note ? ` — “${clip(d.note, 500)}”` : ''}`);
    }
    return out.join('\n');
  }

  // ------------------------------------------------------------------ addressed

  private addressedContent(sub: string, e: CommentEvent, reason: 'mention' | 'assigned' | 'reply', edited: boolean): string {
    const doc = this.docs.get(e.docId)!;
    const thread = this.comments.thread(e.threadId);
    const c = this.comments.get(e.commentId)!;
    const who = this.principals.label(e.actor === c.author || e.kind !== 'assigned' ? c.author : e.actor);
    const verb = reason === 'assigned' ? `${this.principals.label(e.actor)} assigned you a comment thread`
      : reason === 'reply' ? `${who} replied in a comment thread you're in`
      : `${who} mentioned you in a comment`;
    const lines = [`${verb} on “${doc.title}” (${e.docId}), thread ${e.threadId}${edited ? ' (edited)' : ''}:`];
    if (thread?.anchor && !thread.anchor.orphaned) lines.push(`  on “${clip(thread.anchor.text, 160)}” (line ${thread.anchor.line})`);
    else if (thread?.root.quote) lines.push(`  on “${clip(thread.root.quote, 160)}” (that text has since been deleted)`);
    if (thread) {
      const msgs = [thread.root, ...thread.replies];
      const idx = msgs.findIndex((m) => m.id === c.id);
      const context = msgs.slice(Math.max(0, (idx < 0 ? msgs.length : idx) - 3), idx < 0 ? msgs.length : idx);
      for (const m of context) lines.push(`  ${this.principals.label(m.author)}: ${clip(m.body, 300)}`);
    }
    lines.push(`  ${this.principals.label(c.author)}: ${clip(c.body, 2000)}`);
    lines.push(`Reply with reply_comment {"comment":"${e.threadId}","text":"…"}${reason === 'assigned' ? ' and resolve it when done (resolve: true)' : ''}.`);
    void sub;
    return lines.join('\n');
  }

  private async deliverAddressed(sub: string, e: CommentEvent, reason: 'mention' | 'assigned' | 'reply', opts: { replacement?: boolean; level?: string } = {}) {
    const p = this.principals.get(sub);
    if (!p || !this.access(sub, e.docId)) return;
    const st = this.settings(sub, e.docId);
    const levelPref = reason === 'reply' ? st.replies : st.mentions;
    // A replacement keeps its original's treatment: a typo fix must not cancel a pending wake (RFC-006 §4.2).
    const author = this.principals.get(this.comments.get(e.commentId)?.author ?? e.actor);
    const fromGuest = author?.kind === 'guest';
    // Anonymous visitors can't fill an agent's context: at most GUEST_ADDRESSED_PER_HOUR
    // separate deliveries per (agent, document); the rest stay readable with list_comments.
    if (fromGuest && !opts.replacement && !this.allowGuestDelivery(sub, e.docId)) return;
    const wake = opts.level ? opts.level === 'wake' : levelPref === 'wake' && !this.quietNow(st) && (!fromGuest || st.guests === 'wake');
    const tags = [
      'docs:comment', reason === 'assigned' ? 'docs:assigned' : reason === 'reply' ? 'chat:reply' : 'chat:mention', 'chat:addressed',
      author?.kind === 'human' || fromGuest ? 'chat:from-human' : 'chat:from-agent',
      ...(fromGuest ? ['docs:from-guest'] : []),
      ...(opts.replacement ? ['chat:edited'] : []),
      wake ? 'docs:wake' : 'docs:quiet',
    ];
    const prior = this.db.prepare('SELECT 1 FROM addressed WHERE sub = ? AND comment_id = ?').get(sub, e.commentId);
    this.db.prepare(`INSERT INTO addressed (sub, comment_id, doc_id, reason, level, at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(sub, comment_id) DO UPDATE SET at = excluded.at`).run(sub, e.commentId, e.docId, reason, wake ? 'wake' : 'quiet', Date.now());
    const params: PushParams = {
      featureSet: FEATURE_SET, eventId: eventId('adr'), timestamp: iso(), tags,
      origin: { documentId: e.docId, commentId: e.commentId, threadId: e.threadId, author: author?.sub, authorName: author?.name },
      coalesce: { key: SUBJECT_COMMENT(e.commentId), ...(prior ? {} : { initial: true }) },
      payload: { content: [{ type: 'text', text: this.addressedContent(sub, e, reason, !!opts.replacement) }] },
    };
    await this.sendOrQueue(sub, params, e.docId);
  }

  private guestDeliveries = new Map<string, number[]>();
  private allowGuestDelivery(sub: string, docId: string): boolean {
    const k = `${sub}\0${docId}`;
    const now = Date.now();
    const recent = (this.guestDeliveries.get(k) ?? []).filter((t) => now - t < 3600_000);
    if (recent.length >= GUEST_ADDRESSED_PER_HOUR) { this.guestDeliveries.set(k, recent); return false; }
    recent.push(now);
    this.guestDeliveries.set(k, recent);
    return true;
  }

  private async retractAddressed(sub: string, commentId: string, e: CommentEvent) {
    // A version still waiting in the outbox is simply withdrawn.
    this.db.prepare('DELETE FROM outbox WHERE sub = ? AND subject = ?').run(sub, SUBJECT_COMMENT(commentId));
    // If no version ever reached a host there is nothing to retract; otherwise
    // the host decides (the agent may have read it — RFC-006 §6).
    const row = this.db.prepare('SELECT delivered FROM addressed WHERE sub = ? AND comment_id = ?').get(sub, commentId) as { delivered: number } | undefined;
    if (!row?.delivered) return;
    const visible = !!this.access(sub, e.docId);
    const doc = this.docs.get(e.docId);
    const params: PushParams = {
      featureSet: FEATURE_SET, eventId: eventId('del'), timestamp: iso(), tags: ['docs:comment', 'chat:deleted', 'docs:quiet'],
      origin: visible ? { documentId: e.docId, commentId, threadId: e.threadId } : { commentId },
      coalesce: { key: SUBJECT_COMMENT(commentId), retract: true },
      payload: { content: [{ type: 'text', text: visible
        ? `${this.principals.label(e.actor)} deleted the comment ${commentId} (thread ${e.threadId}) on “${doc?.title ?? e.docId}” that was addressed to you.`
        : `The comment ${commentId} that was addressed to you has been deleted.` }] },
    };
    await this.sendOrQueue(sub, params, e.docId);
  }

  private onShare(e: { docId: string; sub: string | null; role: string; by: string }) {
    if (this.closed) return;
    // Access may have narrowed: anything queued for people who lost it is withdrawn.
    this.purgeInaccessible(e.docId);
    if (!e.sub || e.sub === e.by) return;
    const p = this.principals.get(e.sub);
    if (!p || p.kind === 'human' || p.kind === 'guest') return;
    const doc = this.docs.get(e.docId);
    if (!doc) return;
    const st = this.settings(e.sub, '*');
    if (st.shares === 'off') return;
    if (e.role === 'none') {
      this.bg(this.sendOrQueue(e.sub, {
        featureSet: FEATURE_SET, eventId: eventId('shr'), timestamp: iso(), tags: ['docs:share', 'docs:quiet'], origin: { documentId: e.docId },
        coalesce: { key: SUBJECT_SHARE(e.docId), retract: true },
        payload: { content: [{ type: 'text', text: `${this.principals.label(e.by)} removed your access to “${doc.title}” (${e.docId}).` }] },
      }, null));
      return;
    }
    const wake = st.shares === 'wake' && !this.quietNow(st);
    this.bg(this.sendOrQueue(e.sub, {
      featureSet: FEATURE_SET, eventId: eventId('shr'), timestamp: iso(), tags: ['docs:share', wake ? 'docs:wake' : 'docs:quiet'],
      origin: { documentId: e.docId, by: e.by },
      coalesce: { key: SUBJECT_SHARE(e.docId) },
      payload: { content: [{ type: 'text', text: `${this.principals.label(e.by)} shared “${doc.title}” (${e.docId}) with you as ${e.role}. Read it with read_document {"document":"${e.docId}"}; watch it with watch {"document":"${e.docId}"}.` }] },
    }, e.docId));
  }

  /** Withdraw queued deliveries about `docId` for anyone who can no longer read it. */
  private purgeInaccessible(docId: string) {
    const rows = this.db.prepare('SELECT DISTINCT sub FROM outbox WHERE doc_id = ?').all(docId) as { sub: string }[];
    for (const r of rows) if (!this.access(r.sub, docId)) this.db.prepare('DELETE FROM outbox WHERE sub = ? AND doc_id = ?').run(r.sub, docId);
  }

  // ------------------------------------------------------------------ delivery

  /** Push to every live session, or queue (agents only) until one connects. True if a host accepted it. */
  private async sendOrQueue(sub: string, params: PushParams, docId: string | null): Promise<boolean> {
    const sessions = this.live(sub);
    // While the outbox drains, new deliveries queue behind it so a newer version is never overtaken.
    if (!sessions.length || this.flushing.has(sub)) {
      this.queue(sub, params, docId);
      if (sessions.length) this.bg(this.flushOutbox(sub));
      return false;
    }
    let delivered = false;
    for (const s of sessions) if (await this.pushTo(s, params)) delivered = true;
    if (delivered) this.markDelivered(sub, params);
    else this.queue(sub, params, docId);
    return delivered;
  }

  private queue(sub: string, params: PushParams, docId: string | null) {
    const p = this.principals.get(sub);
    if (!p || p.kind === 'human' || p.kind === 'guest') return; // people see it in the web UI
    // Pre-delivery coalescing: a newer version of a queued subject replaces it in place.
    this.db.prepare(`INSERT INTO outbox (sub, doc_id, subject, event, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(sub, subject) DO UPDATE SET event = excluded.event, doc_id = excluded.doc_id, created_at = excluded.created_at`)
      .run(sub, docId, params.coalesce?.key ?? params.eventId, JSON.stringify(params), Date.now());
    this.db.prepare(`DELETE FROM outbox WHERE sub = ? AND id NOT IN (SELECT id FROM outbox WHERE sub = ? ORDER BY id DESC LIMIT 200)`).run(sub, sub);
  }

  private markDelivered(sub: string, params: PushParams) {
    const m = /^comment:(.+)$/.exec(params.coalesce?.key ?? '');
    if (m && !params.coalesce?.retract) this.db.prepare('UPDATE addressed SET delivered = 1 WHERE sub = ? AND comment_id = ?').run(sub, m[1]);
  }

  private async flushOutbox(sub: string) {
    if (this.flushing.has(sub)) return;
    this.flushing.add(sub);
    try {
      for (;;) {
        const r = this.db.prepare('SELECT id, doc_id, event FROM outbox WHERE sub = ? ORDER BY id LIMIT 1').get(sub) as { id: number; doc_id: string | null; event: string } | undefined;
        if (!r) break;
        const sessions = this.live(sub);
        if (!sessions.length) break;
        if (r.doc_id && !this.access(sub, r.doc_id)) { this.db.prepare('DELETE FROM outbox WHERE id = ?').run(r.id); continue; }
        const params = JSON.parse(r.event) as PushParams;
        let ok = false;
        for (const s of sessions) if (await this.pushTo(s, params)) ok = true;
        if (!ok) break; // keep it for the next connection
        this.markDelivered(sub, params);
        // If a newer version replaced this row while it was in flight, keep the row (the loop sends it next).
        this.db.prepare('DELETE FROM outbox WHERE id = ? AND event = ?').run(r.id, r.event);
      }
    } finally {
      this.flushing.delete(sub);
    }
  }

  /** Periodic housekeeping. */
  prune() {
    const day = 86400_000;
    for (const [k, t] of this.lastWake) if (Date.now() - t > day) this.lastWake.delete(k);
    this.db.prepare('DELETE FROM addressed WHERE at < ?').run(Date.now() - 60 * day);
    this.db.prepare('DELETE FROM outbox WHERE created_at < ?').run(Date.now() - 30 * day);
  }

  /** Adapt to the session's coalescing support and push. True if the host accepted. */
  private async pushTo(s: AgentSession, params: PushParams): Promise<boolean> {
    const caps = s.coalescing();
    let p = params;
    if (p.coalesce) {
      if (!caps.plain) {
        // Pre-RFC-006 host: no coalescing at all. Retractions become plain notices (today's behavior).
        const { coalesce: _drop, ...rest } = p;
        p = rest;
      } else if (p.coalesce.initial && !caps.initial) {
        const { initial: _i, ...c } = p.coalesce;
        p = { ...p, coalesce: c };
      }
    }
    try {
      const r = await s.push(p);
      if (!r) return false;
      if (!r.accepted) this.log(`push to ${s.sub} refused: ${r.reason ?? 'no reason'} (${p.eventId})`);
      else if (process.env.DOCS_DEBUG) this.log(`push ${p.eventId} [${p.tags.join(' ')}] ${p.coalesce?.key ?? ''} → ${r.coalesce?.outcome ?? 'accepted'}${r.inferenceId ? ` (inference ${r.inferenceId})` : ''}`);
      return r.accepted;
    } catch (e) {
      this.log(`push to ${s.sub} failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** push/render dispatch for a session. */
  async render(sub: string, key: string): Promise<string> {
    const m = /^doc:([^:]+):(edits|comments)$/.exec(key);
    if (!m) throw new Fault(400, `Unknown subject ${key}`);
    return m[2] === 'edits' ? this.renderEdits(sub, m[1]) : this.renderComments(sub, m[1]);
  }
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

export function validateSettings(p: Partial<WatchSettings> & Record<string, unknown>): Partial<WatchSettings> {
  const out: Partial<WatchSettings> = {};
  const level = (k: string, v: unknown, allowOff = true): Level => {
    if (v === 'wake' || v === 'quiet' || (allowOff && v === 'off')) return v;
    throw new Fault(400, `${k} must be ${allowOff ? 'wake, quiet or off' : 'wake or quiet'}.`);
  };
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    switch (k) {
      case 'edits': case 'comments': case 'replies': case 'shares': case 'guests': out[k] = level(k, v); break;
      case 'mentions': out.mentions = level(k, v, false) as 'wake' | 'quiet'; break;
      case 'from':
        if (v === 'anyone' || v === 'humans' || v === 'agents') out.from = v;
        else if (Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length <= 50) out.from = v as string[];
        else throw new Fault(400, 'from must be anyone, humans, agents, or a list of names/ids.');
        break;
      case 'min_chars': if (!Number.isInteger(v) || (v as number) < 0) throw new Fault(400, 'min_chars must be a non-negative integer.'); out.min_chars = v as number; break;
      case 'sections':
        if (!Array.isArray(v) || !v.every((x) => typeof x === 'string') || v.length > 50) throw new Fault(400, 'sections must be a list of heading texts.');
        out.sections = v as string[]; break;
      case 'keywords':
        if (v === null) { out.keywords = []; break; }
        if (!Array.isArray(v) || v.length > 50 || !v.every((x) => typeof x === 'string' && x.trim() && x.length <= 100)) throw new Fault(400, 'keywords must be a list of up to 50 words or phrases (≤100 chars each).');
        out.keywords = (v as string[]).map((x) => x.trim()); break;
      case 'pattern':
        throw new Fault(400, 'Use keywords (a list of words/phrases) instead of pattern: an edit wakes you if its inserted text contains any of them.');
      case 'settle_seconds': if (typeof v !== 'number' || v < 0 || v > 3600) throw new Fault(400, 'settle_seconds must be 0–3600.'); out.settle_seconds = v; break;
      case 'cooldown_seconds': if (typeof v !== 'number' || v < 0 || v > 86400) throw new Fault(400, 'cooldown_seconds must be 0–86400.'); out.cooldown_seconds = v; break;
      case 'quiet_until':
        if (v === null || v === '') { out.quiet_until = null; break; }
        if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new Fault(400, 'quiet_until must be an ISO timestamp.');
        out.quiet_until = new Date(v).toISOString(); break;
      default: throw new Fault(400, `Unknown watch setting: ${k}`);
    }
  }
  return out;
}
