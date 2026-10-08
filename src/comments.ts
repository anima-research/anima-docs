// Google-Docs-style comment threads anchored to text ranges, and suggestions.
//
// Anchors are Yjs relative positions: they follow the text through any
// concurrent edit. A thread whose anchored text is deleted entirely keeps its
// quote and is shown as "original text deleted".
//
// A suggestion is a thread whose root proposes replacing its anchored text
// (kept in full as the original) with new text. An empty original is an
// insertion at a point anchor. Editors accept (the replacement is applied as
// their edit) or reject; the author can change or withdraw it while open. A
// suggestion whose anchored text no longer matches its original is outdated
// and can't be accepted.

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import * as Y from 'yjs';
import type { DB } from './db.js';
import { Fault } from './auth.js';
import { isGuest, type Actor, type Principal, type Principals } from './principals.js';
import { atLeast, Documents, MAX_DOC_CHARS, type ChangeOrigin, type DeleteSet } from './documents.js';
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
  /** Roots of suggestion threads only. */
  suggestion: Suggestion | null;
}

export type SuggestionStatus = 'open' | 'accepted' | 'rejected';
export interface Suggestion { original: string; text: string; status: SuggestionStatus }

export interface ResolvedAnchor {
  start: number; end: number; line: number; endLine: number; text: string; orphaned: boolean;
  /** An insertion point (suggestions that add text): start === end, never orphaned. */
  point: boolean;
  /** For points: the text just around it, so an insertion can be described. */
  context?: { before: string; after: string };
}

export interface Anchor { start: Uint8Array; end: Uint8Array; quote: string }

export interface Thread {
  root: Comment;
  replies: Comment[];
  anchor: ResolvedAnchor | null;
  /** base64 relative positions, for browsers to resolve against their replica. */
  rel: { start: string; end: string } | null;
  /** For suggestions: whether the anchored text still matches the original (only open ones can be outdated). */
  suggestion: (Suggestion & { outdated: boolean }) | null;
}

export type CommentEventKind = 'created' | 'replied' | 'edited' | 'deleted' | 'resolved' | 'reopened' | 'assigned' | 'accepted' | 'rejected';
export type AddressReason = 'mention' | 'assigned' | 'suggestion' | 'decision';

export interface CommentEvent {
  seq: number;
  docId: string;
  commentId: string;
  threadId: string;
  kind: CommentEventKind;
  actor: string;
  at: number;
  /**
   * Principals this event is addressed to (wake targets): newly mentioned or
   * assigned, the document owner for a new suggestion, the author of a
   * suggestion that was accepted or rejected.
   */
  newlyAddressed: { sub: string; reason: AddressReason }[];
}

type Row = {
  id: string; doc_id: string; thread_id: string; author_sub: string; body: string; mentions: string; assignee_sub: string | null;
  anchor_start: Buffer | null; anchor_end: Buffer | null; quote: string | null; resolved_at: number | null; resolved_by: string | null;
  created_at: number; edited_at: number | null; deleted_at: number | null;
  sugg_text: string | null; sugg_orig: string | null; sugg_status: SuggestionStatus | null;
};
const fromRow = (r: Row): Comment => ({
  id: r.id, docId: r.doc_id, threadId: r.thread_id, author: r.author_sub, body: r.body, mentions: JSON.parse(r.mentions),
  assignee: r.assignee_sub, quote: r.quote, resolvedAt: r.resolved_at, resolvedBy: r.resolved_by,
  createdAt: r.created_at, editedAt: r.edited_at, deletedAt: r.deleted_at,
  suggestion: r.sugg_status ? { original: r.sugg_orig ?? '', text: r.sugg_text ?? '', status: r.sugg_status } : null,
});

const MAX_BODY = 20_000;
/** Longest original or replacement a single suggestion may carry. */
export const MAX_SUGGESTION = 100_000;
/** Open suggestions one principal may have on one document. */
const MAX_OPEN_SUGGESTIONS = 300;

/** Writes per principal: guests are anonymous, so they get a much smaller allowance. */
const RATE = { member: { perMinute: 30, perHour: 400 }, guest: { perMinute: 5, perHour: 40 } };
/** Revisions of open suggestions (a browser in suggesting mode saves them as you type). */
const REVISE_RATE = { member: { perMinute: 120, perHour: 3000 }, guest: { perMinute: 30, perHour: 400 } };

const newId = () => `c${randomBytes(6).toString('base64url').replace(/[-_]/g, 'x')}`;

export class Comments extends EventEmitter {
  private writes = new Map<string, number[]>();
  private revisions = new Map<string, number[]>();
  constructor(private db: DB, private docs: Documents, private principals: Principals) { super(); this.setMaxListeners(100); }

  private throttle(actor: Actor, kind: 'write' | 'revise' = 'write') {
    const now = Date.now();
    const limits = kind === 'write' ? RATE : REVISE_RATE;
    const log = kind === 'write' ? this.writes : this.revisions;
    const limit = isGuest(actor.sub) ? limits.guest : limits.member;
    const recent = (log.get(actor.sub) ?? []).filter((t) => now - t < 3600_000);
    if (recent.filter((t) => now - t < 60_000).length >= limit.perMinute || recent.length >= limit.perHour) {
      throw new Fault(429, kind === 'write' ? 'You are commenting too fast. Wait a little and try again.' : 'You are changing suggestions too fast. Wait a little and try again.');
    }
    recent.push(now);
    log.set(actor.sub, recent);
    if (log.size > 5000) for (const [k, v] of log) if (!v.some((t) => now - t < 3600_000)) log.delete(k);
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
  anchorFromRange(docId: string, start: number, end: number): Anchor {
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

  /**
   * An insertion point at `index`: one relative position, stored as both ends.
   * It sticks to the character before it, so text typed later at the same
   * spot lands after the suggestion's point.
   */
  anchorPoint(docId: string, index: number): Anchor {
    const ytext = this.docs.ydoc(docId).getText('body');
    if (!(Number.isInteger(index) && index >= 0 && index <= ytext.length)) throw new Fault(400, `Position ${index} is outside the document (length ${ytext.length}).`);
    const rel = Y.encodeRelativePosition(index > 0 ? Y.createRelativePositionFromTypeIndex(ytext, index, -1) : Y.createRelativePositionFromTypeIndex(ytext, 0, 0));
    return { start: rel, end: rel, quote: '' };
  }

  /** A range anchor, or an insertion point when the range is empty. */
  anchorFor(docId: string, start: number, end: number): Anchor {
    return end > start ? this.anchorFromRange(docId, start, end) : this.anchorPoint(docId, start);
  }

  resolveAnchor(docId: string, r: Pick<Row, 'anchor_start' | 'anchor_end' | 'quote'>): ResolvedAnchor | null {
    if (!r.anchor_start || !r.anchor_end) return null;
    const doc = this.docs.ydoc(docId);
    const point = Buffer.from(r.anchor_start).equals(Buffer.from(r.anchor_end));
    const s = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(r.anchor_start), doc);
    const e = point ? s : Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(r.anchor_end), doc);
    const text = doc.getText('body').toString();
    const starts = lineStarts(text);
    if (!s || !e) return { start: 0, end: 0, line: 1, endLine: 1, text: '', orphaned: !point, point };
    // end is anchored to the last character (assoc −1); its absolute index is just past it.
    const start = s.index, end = point ? start : Math.max(e.index, start);
    const orphaned = !point && end <= start;
    return {
      start, end, line: lineOf(starts, start), endLine: lineOf(starts, Math.max(start, end - 1)), text: text.slice(start, end), orphaned, point,
      ...(point ? { context: { before: text.slice(Math.max(0, start - 40), start), after: text.slice(start, start + 40) } } : {}),
    };
  }

  /** Is an open suggestion's anchored text no longer its original? */
  private outdated(c: Comment, anchor: ResolvedAnchor | null): boolean {
    const sg = c.suggestion;
    if (!sg || sg.status !== 'open') return false;
    if (!anchor) return true;
    if (anchor.point) return sg.original !== '';
    return anchor.orphaned || anchor.text !== sg.original;
  }

  // ------------------------------------------------------------------ mutations

  create(docId: string, actor: Actor, p: {
    body: string;
    anchor?: Anchor | null;
    assignee?: string | null;
    /** Make this a suggestion: replace the anchored text (its quote, in full) with `text`. */
    suggestion?: { text: string } | null;
  }, internal: { throttled?: boolean } = {}): { comment: Comment; warnings: string[] } {
    const { doc } = this.docs.require(docId, actor, 'commenter');
    const sugg = p.suggestion ? this.checkSuggestion(docId, actor, p.anchor ?? null, p.suggestion.text) : null;
    const body = sugg ? this.cleanNote(p.body) : this.cleanBody(p.body);
    if (!internal.throttled) this.throttle(actor);
    const id = newId();
    const { mentions, warnings } = this.mentionsIn(docId, body, actor);
    if (p.assignee && isGuest(actor.sub)) throw new Fault(403, 'Sign in with Archipelago to assign comments.');
    const assignee = p.assignee ? this.assignable(docId, p.assignee, warnings) : null;
    const now = Date.now();
    this.db.prepare(`INSERT INTO comments (id, doc_id, thread_id, author_sub, body, mentions, assignee_sub, anchor_start, anchor_end, quote, created_at, sugg_text, sugg_orig, sugg_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, docId, id, actor.sub, body, JSON.stringify(mentions.map((m) => m.sub)), assignee?.sub ?? null,
        p.anchor ? Buffer.from(p.anchor.start) : null, p.anchor ? Buffer.from(p.anchor.end) : null, p.anchor?.quote.slice(0, 2000) ?? null, now,
        sugg?.text ?? null, sugg?.original ?? null, sugg ? 'open' : null);
    const addressed = [
      ...mentions.filter((m) => m.sub !== actor.sub).map((m) => ({ sub: m.sub, reason: 'mention' as const })),
      ...(assignee && assignee.sub !== actor.sub ? [{ sub: assignee.sub, reason: 'assigned' as const }] : []),
      // A suggestion asks the owner for a decision.
      ...(sugg && doc.ownerSub !== actor.sub ? [{ sub: doc.ownerSub, reason: 'suggestion' as const }] : []),
    ];
    this.record(docId, id, id, 'created', actor.sub, dedupe(addressed));
    return { comment: this.get(id)!, warnings };
  }

  /** Propose replacing the anchored text (an insertion when the anchor is a point). */
  suggest(docId: string, actor: Actor, p: { anchor: Anchor; text: string; note?: string }): { comment: Comment; warnings: string[] } {
    return this.create(docId, actor, { body: p.note ?? '', anchor: p.anchor, suggestion: { text: p.text } });
  }

  /**
   * Several suggestions from one request (an agent's suggest_edit): counted as
   * one write, and all-or-nothing on validation. The note goes on the first.
   */
  suggestMany(docId: string, actor: Actor, items: { anchor: Anchor; text: string }[], note?: string): { comments: Comment[]; warnings: string[] } {
    this.docs.require(docId, actor, 'commenter');
    for (const it of items) this.checkSuggestion(docId, actor, it.anchor, it.text);
    const open = (this.db.prepare(`SELECT count(*) AS n FROM comments WHERE doc_id = ? AND author_sub = ? AND sugg_status = 'open' AND deleted_at IS NULL`).get(docId, actor.sub) as { n: number }).n;
    if (open + items.length > MAX_OPEN_SUGGESTIONS) throw new Fault(429, `That would make ${open + items.length} open suggestions from you on this document (limit ${MAX_OPEN_SUGGESTIONS}). Wait for some to be reviewed.`);
    this.throttle(actor);
    const comments: Comment[] = [];
    const warnings: string[] = [];
    this.db.transaction(() => {
      items.forEach((it, i) => {
        const r = this.create(docId, actor, { body: i === 0 ? note ?? '' : '', anchor: it.anchor, suggestion: { text: it.text } }, { throttled: true });
        comments.push(r.comment);
        warnings.push(...r.warnings);
      });
    })();
    return { comments, warnings };
  }

  /**
   * The author revises an open suggestion: new replacement text, and
   * optionally a new anchor (its original is the anchored text as it is now).
   */
  revise(threadId: string, actor: Actor, p: { text: string; anchor?: Anchor | null }): Comment {
    const root = this.openSuggestion(threadId, actor);
    if (root.author !== actor.sub) throw new Fault(403, 'Only the author can change a suggestion.');
    const original = p.anchor ? p.anchor.quote : root.suggestion!.original;
    if (!p.anchor) {
      // Text only: the anchored text must still be what the suggestion was made on.
      const t = this.thread(root.id);
      if (t?.suggestion?.outdated) throw new Fault(409, 'The text this suggestion was made on has changed. Make a new suggestion instead.');
    }
    this.checkSuggestionText(original, p.text, !!p.anchor && Buffer.from(p.anchor.start).equals(Buffer.from(p.anchor.end)));
    this.throttle(actor, 'revise');
    if (p.anchor) {
      this.db.prepare('UPDATE comments SET anchor_start = ?, anchor_end = ?, quote = ?, sugg_orig = ?, sugg_text = ?, edited_at = ? WHERE id = ?')
        .run(Buffer.from(p.anchor.start), Buffer.from(p.anchor.end), original.slice(0, 2000), original, p.text, Date.now(), root.id);
    } else {
      this.db.prepare('UPDATE comments SET sugg_text = ?, edited_at = ? WHERE id = ?').run(p.text, Date.now(), root.id);
    }
    this.record(root.docId, root.id, root.id, 'edited', actor.sub, []);
    return this.get(root.id)!;
  }

  /**
   * Accept or reject an open suggestion (editors). Accepting applies the
   * replacement as the decider's edit; it fails if the suggestion is outdated.
   * An optional note is kept as a reply and carried by the decision event.
   */
  decide(threadId: string, actor: Actor & { via?: ChangeOrigin['via'] }, decision: 'accept' | 'reject', opts: { note?: string } = {}):
    { comment: Comment; applied: { client: number; deleteSet: DeleteSet } | null } {
    const root = this.openSuggestion(threadId, actor);
    this.docs.require(root.docId, actor, 'editor');
    const sg = root.suggestion!;
    let range: { start: number; end: number; current: string } | null = null;
    if (decision === 'accept') {
      const anchor = this.resolveAnchor(root.docId, this.row(root.id)!);
      if (!anchor || this.outdated(root, anchor)) {
        throw new Fault(409, `Suggestion ${root.id} is outdated: the text it was made on has changed${anchor && !anchor.point ? ` (it now reads “${anchor.text.slice(0, 200)}”)` : ''}. Reject it, or ask for a fresh suggestion.`);
      }
      const text = this.docs.text(root.docId);
      if (text.length - (anchor.end - anchor.start) + sg.text.length > MAX_DOC_CHARS) throw new Fault(413, 'Accepting this would make the document too long.');
      range = { start: anchor.start, end: anchor.end, current: text };
    }
    const note = opts.note?.trim() ? this.cleanBody(opts.note) : null;
    this.throttle(actor);
    const now = Date.now();
    let eventComment = root.id;
    const mentioned: { sub: string; reason: AddressReason }[] = [];
    if (note) {
      eventComment = newId();
      const { mentions } = this.mentionsIn(root.docId, note, actor);
      for (const m of mentions) if (m.sub !== actor.sub && m.sub !== root.author) mentioned.push({ sub: m.sub, reason: 'mention' });
      this.db.prepare('INSERT INTO comments (id, doc_id, thread_id, author_sub, body, mentions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(eventComment, root.docId, root.id, actor.sub, note, JSON.stringify(mentions.map((m) => m.sub)), now);
    }
    const status: SuggestionStatus = decision === 'accept' ? 'accepted' : 'rejected';
    this.db.prepare('UPDATE comments SET sugg_status = ?, resolved_at = ?, resolved_by = ? WHERE id = ?').run(status, now, actor.sub, root.id);
    // The decision goes out before the text changes, so a suggester's browser
    // drops its pending copy before the accepted text arrives.
    this.record(root.docId, eventComment, root.id, status, actor.sub, dedupe([...(root.author !== actor.sub ? [{ sub: root.author, reason: 'decision' as const }] : []), ...mentioned]));
    let applied: { client: number; deleteSet: DeleteSet } | null = null;
    if (range) {
      try {
        applied = this.docs.edit(root.docId, { sub: actor.sub, via: actor.via ?? 'mcpl' }, (t) => Documents.replaceMinimal(t, range!.start, range!.end, sg.text, range!.current));
      } catch (e) {
        this.db.prepare("UPDATE comments SET sugg_status = 'open', resolved_at = NULL, resolved_by = NULL WHERE id = ?").run(root.id);
        this.record(root.docId, root.id, root.id, 'reopened', actor.sub, []);
        throw e;
      }
    }
    return { comment: this.get(root.id)!, applied };
  }

  private openSuggestion(threadId: string, actor: Actor): Comment {
    const c = this.get(threadId);
    if (!c || c.deletedAt) throw new Fault(404, `No suggestion ${threadId}.`);
    this.requireFor(c, actor);
    const root = c.id === c.threadId ? c : this.get(c.threadId)!;
    if (!root.suggestion) throw new Fault(400, `${root.id} is a comment, not a suggestion.`);
    if (root.suggestion.status !== 'open') throw new Fault(409, `Suggestion ${root.id} was already ${root.suggestion.status}.`);
    return root;
  }

  /** Validate a new suggestion: anchored, a real change, within limits. */
  private checkSuggestion(docId: string, actor: Actor, anchor: Anchor | null, text: unknown): { text: string; original: string } {
    if (!anchor) throw new Fault(400, 'A suggestion needs a place in the document: quote the text to change, or a point to insert at.');
    if (typeof text !== 'string') throw new Fault(400, 'Suggested text must be a string.');
    const point = Buffer.from(anchor.start).equals(Buffer.from(anchor.end));
    this.checkSuggestionText(anchor.quote, text, point);
    const open = (this.db.prepare(`SELECT count(*) AS n FROM comments WHERE doc_id = ? AND author_sub = ? AND sugg_status = 'open' AND deleted_at IS NULL`).get(docId, actor.sub) as { n: number }).n;
    if (open >= MAX_OPEN_SUGGESTIONS) throw new Fault(429, `You have ${open} open suggestions on this document. Wait for some to be reviewed.`);
    return { text, original: anchor.quote };
  }

  private checkSuggestionText(original: string, text: string, point: boolean) {
    if (typeof text !== 'string') throw new Fault(400, 'Suggested text must be a string.');
    if (point && !text) throw new Fault(400, 'An insertion needs some text.');
    if (text === original) throw new Fault(400, 'The suggestion doesn\'t change anything.');
    if (text.length > MAX_SUGGESTION || original.length > MAX_SUGGESTION) throw new Fault(413, `A suggestion can cover at most ${MAX_SUGGESTION.toLocaleString('en')} characters; split it up.`);
  }

  reply(commentId: string, actor: Actor, bodyIn: string, opts: { resolve?: boolean; reopen?: boolean } = {}): { comment: Comment; warnings: string[] } {
    const target = this.get(commentId);
    if (!target || target.deletedAt) throw new Fault(404, `No comment ${commentId}.`);
    this.requireFor(target, actor);
    const root = this.get(target.threadId)!;
    const body = this.cleanBody(bodyIn);
    this.throttle(actor);
    const id = newId();
    const { mentions, warnings } = this.mentionsIn(target.docId, body, actor);
    const now = Date.now();
    this.db.prepare(`INSERT INTO comments (id, doc_id, thread_id, author_sub, body, mentions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, target.docId, root.id, actor.sub, body, JSON.stringify(mentions.map((m) => m.sub)), now);
    this.record(target.docId, id, root.id, 'replied', actor.sub,
      mentions.filter((m) => m.sub !== actor.sub).map((m) => ({ sub: m.sub, reason: 'mention' as const })));
    if (!root.suggestion) {
      if (opts.resolve && !root.resolvedAt) this.resolve(root.id, actor, true);
      if (opts.reopen && root.resolvedAt) this.resolve(root.id, actor, false);
    }
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
    if (root.suggestion) {
      throw new Fault(409, root.suggestion.status === 'open'
        ? `${root.id} is a suggestion: accept or reject it instead of resolving it.`
        : `Suggestion ${root.id} was ${root.suggestion.status}; it can't be reopened. Make a new suggestion instead.`);
    }
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
      const root = fromRow(t.root);
      const anchor = this.resolveAnchor(docId, t.root);
      out.push({
        root,
        replies: t.replies.map(fromRow),
        anchor,
        rel: t.root.anchor_start && t.root.anchor_end
          ? { start: Buffer.from(t.root.anchor_start).toString('base64'), end: Buffer.from(t.root.anchor_end).toString('base64') } : null,
        suggestion: root.suggestion ? { ...root.suggestion, outdated: this.outdated(root, anchor) } : null,
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

  openSuggestionCount(docId: string): number {
    return (this.db.prepare(`SELECT count(*) AS n FROM comments WHERE doc_id = ? AND id = thread_id AND deleted_at IS NULL AND sugg_status = 'open'`).get(docId) as { n: number }).n;
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

  /** A suggestion's note is optional. */
  private cleanNote(body: string | null | undefined): string {
    const b = String(body ?? '').trim();
    if (b.length > MAX_BODY) throw new Fault(413, `Note is too long (max ${MAX_BODY} chars).`);
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

/** Quote text for a one-line summary: newlines shown as ⏎, clipped in the middle. */
export function quoteText(x: string, max: number): string {
  const one = x.replace(/\r?\n/g, '⏎').replace(/[ \t]+/g, ' ');
  if (one.length <= max) return `“${one}”`;
  const head = Math.ceil((max - 1) * 0.6), tail = max - 1 - head;
  return `“${one.slice(0, head)}…${tail > 0 ? one.slice(-tail) : ''}”`;
}

/**
 * A suggestion in one line, for agents: replace “a” with “b”, insert “b”
 * after “…”, or delete “a”.
 */
export function suggestionSummary(s: { original: string; text: string }, max = 300, anchor?: ResolvedAnchor | null): string {
  if (!s.original) {
    const ctx = anchor?.context;
    const where = ctx ? (ctx.before.trim() ? ` after ${quoteText(ctx.before.slice(-30), 40)}` : ctx.after.trim() ? ` before ${quoteText(ctx.after.slice(0, 30), 40)}` : '') : '';
    return `insert ${quoteText(s.text, max)}${where}`;
  }
  if (!s.text) return `delete ${quoteText(s.original, max)}`;
  return `replace ${quoteText(s.original, max)} with ${quoteText(s.text, max)}`;
}

function dedupe<T extends { sub: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.sub) ? false : (seen.add(x.sub), true)));
}
