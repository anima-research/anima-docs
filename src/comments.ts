// Google-Docs-style comment threads anchored to text ranges.
//
// Anchors are Yjs relative positions: they follow the text through any
// concurrent edit. A thread whose anchored text is deleted entirely keeps its
// quote and is shown as "original text deleted".

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import * as Y from 'yjs';
import type { DB } from './db.js';
import { Fault } from './auth.js';
import { isGuest, type Actor, type Principal, type Principals } from './principals.js';
import { atLeast, type Documents } from './documents.js';
import { lineStarts, lineOf, occurrences } from './markdown.js';

export interface Comment {
  id: string;
  docId: string;
  threadId: string;
  author: string;
  body: string;
  mentions: string[];
  assignee: string | null;
  quote: string | null;
  resolvedAt: number | null;
  resolvedBy: string | null;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
}

export interface ResolvedAnchor { start: number; end: number; line: number; endLine: number; text: string; orphaned: boolean }

export interface Thread {
  root: Comment;
  replies: Comment[];
  anchor: ResolvedAnchor | null;
  /** base64 relative positions, for browsers to resolve against their replica. */
  rel: { start: string; end: string } | null;
}

export type CommentEventKind = 'created' | 'replied' | 'edited' | 'deleted' | 'resolved' | 'reopened' | 'assigned';

export interface CommentEvent {
  seq: number;
  docId: string;
  commentId: string;
  threadId: string;
  kind: CommentEventKind;
  actor: string;
  at: number;
  /** Principals newly mentioned or assigned by this event (wake targets). */
  newlyAddressed: { sub: string; reason: 'mention' | 'assigned' }[];
}

type Row = {
  id: string; doc_id: string; thread_id: string; author_sub: string; body: string; mentions: string; assignee_sub: string | null;
  anchor_start: Buffer | null; anchor_end: Buffer | null; quote: string | null; resolved_at: number | null; resolved_by: string | null;
  created_at: number; edited_at: number | null; deleted_at: number | null;
};
const fromRow = (r: Row): Comment => ({
  id: r.id, docId: r.doc_id, threadId: r.thread_id, author: r.author_sub, body: r.body, mentions: JSON.parse(r.mentions),
  assignee: r.assignee_sub, quote: r.quote, resolvedAt: r.resolved_at, resolvedBy: r.resolved_by,
  createdAt: r.created_at, editedAt: r.edited_at, deletedAt: r.deleted_at,
});

const MAX_BODY = 20_000;

/** Writes per principal: guests are anonymous, so they get a much smaller allowance. */
const RATE = { member: { perMinute: 30, perHour: 400 }, guest: { perMinute: 5, perHour: 40 } };

export class Comments extends EventEmitter {
  private writes = new Map<string, number[]>();
  constructor(private db: DB, private docs: Documents, private principals: Principals) { super(); this.setMaxListeners(100); }

  private throttle(actor: Actor) {
    const now = Date.now();
    const limit = isGuest(actor.sub) ? RATE.guest : RATE.member;
    const recent = (this.writes.get(actor.sub) ?? []).filter((t) => now - t < 3600_000);
    if (recent.filter((t) => now - t < 60_000).length >= limit.perMinute || recent.length >= limit.perHour) {
      throw new Fault(429, 'You are commenting too fast. Wait a little and try again.');
    }
    recent.push(now);
    this.writes.set(actor.sub, recent);
    if (this.writes.size > 5000) for (const [k, v] of this.writes) if (!v.some((t) => now - t < 3600_000)) this.writes.delete(k);
  }

  get(id: string): Comment | null {
    const r = this.db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  private row(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as Row | undefined;
  }

  // ------------------------------------------------------------------ anchors

  /** Relative positions for [start, end) in the live text. */
  anchorFromRange(docId: string, start: number, end: number): { start: Uint8Array; end: Uint8Array; quote: string } {
    const ytext = this.docs.ydoc(docId).getText('body');
    const len = ytext.length;
    if (!(start >= 0 && end > start && end <= len)) throw new Fault(400, `Anchor range ${start}–${end} is outside the document (length ${len}).`);
    return {
      start: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, start, 0)),
      end: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, end, -1)),
      quote: ytext.toString().slice(start, end),
    };
  }

  /**
   * Anchor by quoting: the quoted text must occur exactly once, or `occurrence`
   * (1-based) picks one, or `nearLine` picks the closest.
   */
  anchorFromQuote(docId: string, quote: string, opts: { occurrence?: number; nearLine?: number } = {}) {
    const text = this.docs.text(docId);
    const hits = occurrences(text, quote);
    if (!quote) throw new Fault(400, 'quote must be non-empty.');
    if (!hits.length) throw new Fault(404, 'The quoted text does not occur in the document. Quote it exactly (re-read if it changed).');
    let at: number;
    if (opts.occurrence) {
      if (opts.occurrence < 1 || opts.occurrence > hits.length) throw new Fault(400, `occurrence must be 1–${hits.length}.`);
      at = hits[opts.occurrence - 1];
    } else if (hits.length === 1) at = hits[0];
    else if (opts.nearLine) {
      const starts = lineStarts(text);
      at = hits.reduce((best, h) => (Math.abs(lineOf(starts, h) - opts.nearLine!) < Math.abs(lineOf(starts, best) - opts.nearLine!) ? h : best));
    } else {
      const starts = lineStarts(text);
      throw new Fault(409, `The quoted text occurs ${hits.length} times (lines ${hits.map((h) => lineOf(starts, h)).join(', ')}). Quote more context, or pass occurrence or near_line.`);
    }
    return this.anchorFromRange(docId, at, at + quote.length);
  }

  resolveAnchor(docId: string, r: Pick<Row, 'anchor_start' | 'anchor_end' | 'quote'>): ResolvedAnchor | null {
    if (!r.anchor_start || !r.anchor_end) return null;
    const doc = this.docs.ydoc(docId);
    const s = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(r.anchor_start), doc);
    const e = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(r.anchor_end), doc);
    const text = doc.getText('body').toString();
    const starts = lineStarts(text);
    if (!s || !e) return { start: 0, end: 0, line: 1, endLine: 1, text: '', orphaned: true };
    // end is anchored to the last character (assoc −1); its absolute index is just past it.
    const start = s.index, end = Math.max(e.index, start);
    const orphaned = end <= start;
    return { start, end, line: lineOf(starts, start), endLine: lineOf(starts, Math.max(start, end - 1)), text: text.slice(start, end), orphaned };
  }

  // ------------------------------------------------------------------ mutations

  create(docId: string, actor: Actor, p: {
    body: string;
    anchor?: { start: Uint8Array; end: Uint8Array; quote: string } | null;
    assignee?: string | null;
  }): { comment: Comment; warnings: string[] } {
    this.docs.require(docId, actor, 'commenter');
    const body = this.cleanBody(p.body);
    this.throttle(actor);
    const id = `c${randomBytes(6).toString('base64url').replace(/[-_]/g, 'x')}`;
    const { mentions, warnings } = this.mentionsIn(docId, body, actor);
    if (p.assignee && isGuest(actor.sub)) throw new Fault(403, 'Sign in with Archipelago to assign comments.');
    const assignee = p.assignee ? this.assignable(docId, p.assignee, warnings) : null;
    const now = Date.now();
    this.db.prepare(`INSERT INTO comments (id, doc_id, thread_id, author_sub, body, mentions, assignee_sub, anchor_start, anchor_end, quote, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, docId, id, actor.sub, body, JSON.stringify(mentions.map((m) => m.sub)), assignee?.sub ?? null,
        p.anchor ? Buffer.from(p.anchor.start) : null, p.anchor ? Buffer.from(p.anchor.end) : null, p.anchor?.quote.slice(0, 2000) ?? null, now);
    const addressed = [
      ...mentions.filter((m) => m.sub !== actor.sub).map((m) => ({ sub: m.sub, reason: 'mention' as const })),
      ...(assignee && assignee.sub !== actor.sub ? [{ sub: assignee.sub, reason: 'assigned' as const }] : []),
    ];
    this.record(docId, id, id, 'created', actor.sub, dedupe(addressed));
    return { comment: this.get(id)!, warnings };
  }

  reply(commentId: string, actor: Actor, bodyIn: string, opts: { resolve?: boolean; reopen?: boolean } = {}): { comment: Comment; warnings: string[] } {
    const target = this.get(commentId);
    if (!target || target.deletedAt) throw new Fault(404, `No comment ${commentId}.`);
    this.requireFor(target, actor);
    const root = this.get(target.threadId)!;
    const body = this.cleanBody(bodyIn);
    this.throttle(actor);
    const id = `c${randomBytes(6).toString('base64url').replace(/[-_]/g, 'x')}`;
    const { mentions, warnings } = this.mentionsIn(target.docId, body, actor);
    const now = Date.now();
    this.db.prepare(`INSERT INTO comments (id, doc_id, thread_id, author_sub, body, mentions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, target.docId, root.id, actor.sub, body, JSON.stringify(mentions.map((m) => m.sub)), now);
    this.record(target.docId, id, root.id, 'replied', actor.sub,
      mentions.filter((m) => m.sub !== actor.sub).map((m) => ({ sub: m.sub, reason: 'mention' as const })));
    if (opts.resolve && !root.resolvedAt) this.resolve(root.id, actor, true);
    if (opts.reopen && root.resolvedAt) this.resolve(root.id, actor, false);
    return { comment: this.get(id)!, warnings };
  }

  editBody(commentId: string, actor: Actor, bodyIn: string): { comment: Comment; warnings: string[] } {
    const c = this.get(commentId);
    if (!c || c.deletedAt) throw new Fault(404, `No comment ${commentId}.`);
    this.requireFor(c, actor);
    if (c.author !== actor.sub) throw new Fault(403, 'Only the author can edit a comment.');
    this.throttle(actor);
    const body = this.cleanBody(bodyIn);
    const { mentions, warnings } = this.mentionsIn(c.docId, body, actor);
    this.db.prepare('UPDATE comments SET body = ?, mentions = ?, edited_at = ? WHERE id = ?').run(body, JSON.stringify(mentions.map((m) => m.sub)), Date.now(), c.id);
    // Wake only people newly mentioned by the edit; existing mentions are re-delivered as a replacement.
    const before = new Set(c.mentions);
    this.record(c.docId, c.id, c.threadId, 'edited', actor.sub,
      mentions.filter((m) => m.sub !== actor.sub && !before.has(m.sub)).map((m) => ({ sub: m.sub, reason: 'mention' as const })));
    return { comment: this.get(c.id)!, warnings };
  }

  remove(commentId: string, actor: Actor): void {
    const c = this.get(commentId);
    if (!c || c.deletedAt) throw new Fault(404, `No comment ${commentId}.`);
    const { role } = this.requireFor(c, actor);
    if (c.author !== actor.sub && !atLeast(role, 'owner')) throw new Fault(403, 'Only the author or a document owner can delete a comment.');
    const now = Date.now();
    // Deleting a root deletes its thread.
    if (c.id === c.threadId) this.db.prepare('UPDATE comments SET deleted_at = ? WHERE thread_id = ? AND deleted_at IS NULL').run(now, c.id);
    else this.db.prepare('UPDATE comments SET deleted_at = ? WHERE id = ?').run(now, c.id);
    this.record(c.docId, c.id, c.threadId, 'deleted', actor.sub, []);
  }

  resolve(threadOrComment: string, actor: Actor, resolved: boolean): Comment {
    const c = this.get(threadOrComment);
    if (!c || c.deletedAt) throw new Fault(404, `No comment ${threadOrComment}.`);
    this.requireFor(c, actor);
    const root = this.get(c.threadId)!;
    if (!!root.resolvedAt === resolved) return root;
    this.db.prepare('UPDATE comments SET resolved_at = ?, resolved_by = ? WHERE id = ?').run(resolved ? Date.now() : null, resolved ? actor.sub : null, root.id);
    this.record(root.docId, root.id, root.id, resolved ? 'resolved' : 'reopened', actor.sub, []);
    return this.get(root.id)!;
  }

  assign(threadOrComment: string, actor: Actor, assigneeRef: string | null): { comment: Comment; warnings: string[] } {
    const c = this.get(threadOrComment);
    if (!c || c.deletedAt) throw new Fault(404, `No comment ${threadOrComment}.`);
    this.requireFor(c, actor);
    if (isGuest(actor.sub)) throw new Fault(403, 'Sign in with Archipelago to assign comments.');
    const warnings: string[] = [];
    const who = assigneeRef ? this.assignable(c.docId, assigneeRef, warnings) : null;
    this.db.prepare('UPDATE comments SET assignee_sub = ? WHERE id = ?').run(who?.sub ?? null, c.threadId);
    this.record(c.docId, c.threadId, c.threadId, 'assigned', actor.sub, who && who.sub !== actor.sub ? [{ sub: who.sub, reason: 'assigned' }] : []);
    return { comment: this.get(c.threadId)!, warnings };
  }

  // ------------------------------------------------------------------ reads

  threads(docId: string, opts: { includeResolved?: boolean; threadId?: string } = {}): Thread[] {
    const rows = this.db.prepare(`SELECT * FROM comments WHERE doc_id = ? AND deleted_at IS NULL ${opts.threadId ? 'AND thread_id = ?' : ''} ORDER BY created_at`)
      .all(...(opts.threadId ? [docId, opts.threadId] : [docId])) as Row[];
    const byThread = new Map<string, { root?: Row; replies: Row[] }>();
    for (const r of rows) {
      const t = byThread.get(r.thread_id) ?? { replies: [] };
      if (r.id === r.thread_id) t.root = r; else t.replies.push(r);
      byThread.set(r.thread_id, t);
    }
    const out: Thread[] = [];
    for (const t of byThread.values()) {
      if (!t.root) continue;
      if (t.root.resolved_at && !opts.includeResolved) continue;
      out.push({
        root: fromRow(t.root),
        replies: t.replies.map(fromRow),
        anchor: this.resolveAnchor(docId, t.root),
        rel: t.root.anchor_start && t.root.anchor_end
          ? { start: Buffer.from(t.root.anchor_start).toString('base64'), end: Buffer.from(t.root.anchor_end).toString('base64') } : null,
      });
    }
    out.sort((a, b) => (a.anchor?.start ?? Infinity) - (b.anchor?.start ?? Infinity) || a.root.createdAt - b.root.createdAt);
    return out;
  }

  thread(threadId: string): Thread | null {
    const root = this.get(threadId);
    if (!root || root.deletedAt) return null;
    return this.threads(root.docId, { includeResolved: true, threadId: root.threadId })[0] ?? null;
  }

  /** Has `sub` authored anything in this thread? */
  participates(threadId: string, sub: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM comments WHERE thread_id = ? AND author_sub = ? LIMIT 1').get(threadId, sub);
  }

  eventsSince(docId: string, seq: number, limit = 200): CommentEvent[] {
    return (this.db.prepare('SELECT * FROM comment_events WHERE doc_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(docId, seq, limit) as any[])
      .map((r) => ({ seq: r.seq, docId: r.doc_id, commentId: r.comment_id, threadId: r.thread_id, kind: r.kind, actor: r.actor_sub, at: r.at, newlyAddressed: [] }));
  }

  lastSeq(docId: string): number {
    return (this.db.prepare('SELECT max(seq) AS s FROM comment_events WHERE doc_id = ?').get(docId) as { s: number | null }).s ?? 0;
  }

  openCount(docId: string): number {
    return (this.db.prepare('SELECT count(*) AS n FROM comments WHERE doc_id = ? AND id = thread_id AND deleted_at IS NULL AND resolved_at IS NULL').get(docId) as { n: number }).n;
  }

  // ------------------------------------------------------------------ internals

  /** Access check for an operation on an existing comment: an inaccessible document reads as "no such comment". */
  private requireFor(c: Comment, actor: Actor) {
    try { return this.docs.require(c.docId, actor, 'commenter'); } catch (e) {
      if (e instanceof Fault && e.status === 404) throw new Fault(404, `No comment ${c.id}.`);
      throw e;
    }
  }

  private cleanBody(body: string): string {
    const b = String(body ?? '').trim();
    if (!b) throw new Fault(400, 'Comment text cannot be empty.');
    if (b.length > MAX_BODY) throw new Fault(413, `Comment is too long (max ${MAX_BODY} chars).`);
    return b;
  }

  private mentionsIn(docId: string, body: string, actor: Actor): { mentions: Principal[]; warnings: string[] } {
    const mentions = this.principals.findMentions(body);
    const warnings: string[] = [];
    for (const m of mentions) {
      if (m.sub !== actor.sub && !this.docs.role(docId, { sub: m.sub, admin: m.role === 'admin' })) {
        warnings.push(`${m.name} has no access to this document, so they won't be notified. Share it with them first.`);
      }
    }
    return { mentions: mentions.filter((m) => this.docs.role(docId, { sub: m.sub, admin: m.role === 'admin' })), warnings };
  }

  private assignable(docId: string, ref: string, warnings: string[]): Principal {
    const p = this.principals.resolve(ref);
    if (!atLeast(this.docs.role(docId, { sub: p.sub, admin: p.role === 'admin' }), 'commenter')) {
      throw new Fault(409, `${p.name} needs at least commenter access to be assigned. Share the document with them first.`);
    }
    void warnings;
    return p;
  }

  private record(docId: string, commentId: string, threadId: string, kind: CommentEventKind, actor: string, newlyAddressed: CommentEvent['newlyAddressed']) {
    const at = Date.now();
    const r = this.db.prepare('INSERT INTO comment_events (doc_id, comment_id, thread_id, kind, actor_sub, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(docId, commentId, threadId, kind, actor, at);
    const ev: CommentEvent = { seq: Number(r.lastInsertRowid), docId, commentId, threadId, kind, actor, at, newlyAddressed };
    this.emit('event', ev);
  }
}

function dedupe<T extends { sub: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.sub) ? false : (seen.add(x.sub), true)));
}
