// Automatic history: a checkpoint at the end of every stretch of editing.
//
// A checkpoint stores a Yjs snapshot (a state vector and a delete set, a few
// KB). Garbage collection is off, so any snapshot renders the document exactly
// as it was. The change a checkpoint records is the difference from the
// checkpoint before it.
//
// A stretch ends when editing pauses (people: 3 minutes; an agent: 1 minute),
// after 10 minutes of continuous editing, when a different kind of editor
// takes over (people vs. a particular agent), and around any labelled edit
// (an accepted suggestion, a restore), which gets a checkpoint of its own.
// Stretches close just before the change that ends them, so each checkpoint
// is exactly the state its editors left.

import * as Y from 'yjs';
import { applyPatch, structuredPatch } from 'diff';
import type { DB } from './db.js';
import { Fault } from './auth.js';
import { Documents, type ChangeOrigin, type DocChange } from './documents.js';
import type { Actor, Principals } from './principals.js';

export interface Checkpoint {
  seq: number;
  docId: string;
  start: number;
  end: number;
  /** Who changed the text in this stretch. */
  authors: string[];
  /** Characters typed and deleted in the stretch (not the net change). */
  added: number;
  removed: number;
  /** A labelled edit (an accepted suggestion, a restore); null for ordinary editing. */
  label: string | null;
  /** The state before any recorded history: no change of its own. */
  baseline: boolean;
}

interface Open {
  cls: string;
  start: number;
  last: number;
  authors: Set<string>;
  added: number;
  removed: number;
  idle: NodeJS.Timeout | null;
}

type Row = { seq: number; doc_id: string; start_at: number; end_at: number; snapshot: Buffer; authors: string; added: number; removed: number; label: string | null; kind: string };
const fromRow = (r: Row): Checkpoint => ({
  seq: r.seq, docId: r.doc_id, start: r.start_at, end: r.end_at, authors: JSON.parse(r.authors), added: r.added, removed: r.removed,
  label: r.label, baseline: r.kind === 'baseline',
});

export interface HistoryOptions {
  /** Pause that ends a stretch of people's editing. */
  idleMs?: number;
  /** Pause that ends an agent's stretch (agents edit in discrete calls). */
  agentIdleMs?: number;
  /** Longest stretch before a checkpoint is taken anyway. */
  maxMs?: number;
}

export class History {
  private open = new Map<string, Open>();
  private idleMs: number;
  private agentIdleMs: number;
  private maxMs: number;
  private closed = false;

  constructor(private db: DB, private docs: Documents, private principals: Principals, opts: HistoryOptions = {}) {
    this.idleMs = opts.idleMs ?? 3 * 60_000;
    this.agentIdleMs = opts.agentIdleMs ?? 60_000;
    this.maxMs = opts.maxMs ?? 10 * 60_000;
    docs.on('loaded', (e: { docId: string }) => this.baseline(e.docId));
    docs.on('beforeChange', (e: { docId: string; origin: ChangeOrigin }) => this.beforeChange(e.docId, e.origin));
    docs.on('change', (c: DocChange) => this.onChange(c));
  }

  // ------------------------------------------------------------------ recording

  /** Who a change belongs with: people edit together; each agent's edits are its own. */
  private classOf(o: ChangeOrigin): string {
    if (o.via === 'web') return 'people';
    const p = this.principals.get(o.sub);
    return p && (p.kind === 'human' || p.kind === 'guest') ? 'people' : `agent:${o.sub}`;
  }

  /** A document seen for the first time: its current state is where history starts. */
  private baseline(docId: string) {
    if (this.closed) return;
    const has = this.db.prepare('SELECT 1 FROM checkpoints WHERE doc_id = ? LIMIT 1').get(docId);
    if (has) return;
    const now = Date.now();
    this.db.prepare(`INSERT INTO checkpoints (doc_id, start_at, end_at, snapshot, authors, added, removed, label, kind) VALUES (?, ?, ?, ?, '[]', 0, 0, NULL, 'baseline')`)
      .run(docId, now, now, Buffer.from(Y.encodeSnapshot(this.docs.snapshot(docId))));
  }

  private beforeChange(docId: string, o: ChangeOrigin) {
    const seg = this.open.get(docId);
    if (!seg) return;
    const now = Date.now();
    if (seg.cls !== this.classOf(o) || now - seg.start >= this.maxMs || o.label) this.close(docId);
  }

  private onChange(c: DocChange) {
    if (this.closed) return;
    const now = Date.now();
    let seg = this.open.get(c.docId);
    if (!seg) this.open.set(c.docId, seg = { cls: this.classOf(c.origin), start: now, last: now, authors: new Set(), added: 0, removed: 0, idle: null });
    seg.last = now;
    seg.authors.add(c.origin.sub);
    seg.added += c.added;
    seg.removed += c.removed;
    if (c.origin.label) { this.close(c.docId, c.origin.label); return; }
    if (seg.idle) clearTimeout(seg.idle);
    const wait = Math.min(seg.cls === 'people' ? this.idleMs : this.agentIdleMs, Math.max(0, seg.start + this.maxMs - now));
    seg.idle = setTimeout(() => this.close(c.docId), wait);
    seg.idle.unref?.();
  }

  /** End the open stretch of `docId` with a checkpoint of the state right now. */
  private close(docId: string, label?: string) {
    const seg = this.open.get(docId);
    if (!seg) return;
    this.open.delete(docId);
    if (seg.idle) clearTimeout(seg.idle);
    try {
      if (!this.docs.get(docId)) return; // deleted meanwhile
      this.db.prepare(`INSERT INTO checkpoints (doc_id, start_at, end_at, snapshot, authors, added, removed, label, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'edit')`)
        .run(docId, seg.start, Date.now(), Buffer.from(Y.encodeSnapshot(this.docs.snapshot(docId))), JSON.stringify([...seg.authors]), seg.added, seg.removed, label ?? null);
    } catch (e) {
      console.error(`[history] ${docId}: checkpoint failed:`, (e as Error).message);
    }
  }

  /** Close every open stretch (shutting down, or before reading history so the latest edits show). */
  flush(docId?: string) {
    for (const id of docId ? [docId] : [...this.open.keys()]) this.close(id);
  }

  shutdown() {
    this.flush();
    this.closed = true;
  }

  // ------------------------------------------------------------------ reading

  list(docId: string, opts: { before?: number; limit?: number } = {}): Checkpoint[] {
    this.flush(docId);
    const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
    return (this.db.prepare(`SELECT seq, doc_id, start_at, end_at, x'' AS snapshot, authors, added, removed, label, kind FROM checkpoints
      WHERE doc_id = ? ${opts.before ? 'AND seq < ?' : ''} ORDER BY seq DESC LIMIT ?`)
      .all(...(opts.before ? [docId, opts.before, limit] : [docId, limit])) as Row[]).map(fromRow);
  }

  get(docId: string, seq: number): Checkpoint {
    const r = this.row(docId, seq);
    return fromRow(r);
  }

  private row(docId: string, seq: number): Row {
    const r = this.db.prepare('SELECT * FROM checkpoints WHERE doc_id = ? AND seq = ?').get(docId, seq) as Row | undefined;
    if (!r) throw new Fault(404, `No change h${seq} in this document.`);
    return r;
  }

  /** The state after a checkpoint. */
  snapshotAfter(docId: string, seq: number): Y.Snapshot {
    return Y.decodeSnapshot(this.row(docId, seq).snapshot);
  }

  /** The state before a checkpoint's change: the checkpoint before it (a baseline has none: itself). */
  snapshotBefore(docId: string, seq: number): Y.Snapshot {
    const r = this.row(docId, seq);
    if (r.kind === 'baseline') return Y.decodeSnapshot(r.snapshot);
    const prev = this.db.prepare('SELECT snapshot FROM checkpoints WHERE doc_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1').get(docId, seq) as { snapshot: Buffer } | undefined;
    // No earlier checkpoint (history began with this change): the empty document.
    return prev ? Y.decodeSnapshot(prev.snapshot) : Y.emptySnapshot;
  }

  /**
   * Texts to compare: before `from`'s change, and after `to`'s (to may be
   * "now"). A single change is from = to.
   */
  compare(docId: string, from: number, to: number | 'now'): { before: string; after: string; from: Checkpoint; to: Checkpoint | null } {
    this.flush(docId);
    const a = this.get(docId, from);
    const b = to === 'now' ? null : this.get(docId, to);
    if (b && b.seq < a.seq) throw new Fault(400, 'from must be the earlier change.');
    const before = this.docs.textAt(docId, this.snapshotBefore(docId, a.seq));
    const after = b ? this.docs.textAt(docId, this.snapshotAfter(docId, b.seq)) : this.docs.text(docId);
    return { before, after, from: a, to: b };
  }

  /** Who changed what between two states, for authors of a range. */
  authorsBetween(docId: string, from: number, to: number | 'now'): string[] {
    const rows = this.db.prepare(`SELECT authors FROM checkpoints WHERE doc_id = ? AND seq >= ? ${to === 'now' ? '' : 'AND seq <= ?'}`)
      .all(...(to === 'now' ? [docId, from] : [docId, from, to])) as { authors: string }[];
    return [...new Set(rows.flatMap((r) => JSON.parse(r.authors) as string[]))];
  }

  // ------------------------------------------------------------------ going back

  /** Make the document what it was before or after a checkpoint (a new, labelled edit; history is kept). */
  restore(docId: string, actor: Actor & { via?: ChangeOrigin['via'] }, seq: number, at: 'before' | 'after') {
    this.docs.require(docId, actor, 'editor');
    this.flush(docId);
    const cp = this.get(docId, seq);
    const target = this.docs.textAt(docId, at === 'after' ? this.snapshotAfter(docId, seq) : this.snapshotBefore(docId, seq));
    if (target === this.docs.text(docId)) throw new Fault(409, 'The document already reads exactly like that.');
    void cp;
    return this.docs.edit(docId, { sub: actor.sub, via: actor.via ?? 'mcpl', label: `Restored to ${at === 'after' ? 'just after' : 'just before'} h${seq}` },
      (t) => Documents.replaceMinimal(t, 0, t.length, target));
  }

  /**
   * Undo just one checkpoint's change, keeping everything since. Refused if
   * later edits touched the same lines.
   */
  undo(docId: string, actor: Actor & { via?: ChangeOrigin['via'] }, seq: number) {
    this.docs.require(docId, actor, 'editor');
    this.flush(docId);
    const cp = this.get(docId, seq);
    if (cp.baseline) throw new Fault(400, 'That is where the history starts; there is no change to undo.');
    const before = this.docs.textAt(docId, this.snapshotBefore(docId, seq));
    const after = this.docs.textAt(docId, this.snapshotAfter(docId, seq));
    if (before === after) throw new Fault(409, 'That change left the text as it was; there is nothing to undo.');
    const current = this.docs.text(docId);
    // The change reversed, as a patch, applied to today's text.
    const patch = structuredPatch('doc', 'doc', after, before, '', '', { context: 3 });
    const result = applyPatch(current, patch);
    if (result === false) throw new Fault(409, 'Later edits changed the same lines, so this change can’t be undone on its own. Restore an earlier state instead, or undo it by hand.');
    if (result === current) throw new Fault(409, 'That change is no longer in the document.');
    return this.docs.edit(docId, { sub: actor.sub, via: actor.via ?? 'mcpl', label: `Undid h${seq}` },
      (t) => Documents.replaceMinimal(t, 0, t.length, result));
  }

  // ------------------------------------------------------------------ housekeeping

  /**
   * Thin old history: past a week, one checkpoint per hour per document;
   * past a month, one per day. Merged checkpoints fold their authors and
   * counts into the one kept (the last of the period). Labelled ones stay.
   */
  prune(now = Date.now()) {
    const week = 7 * 86400_000, month = 30 * 86400_000;
    const thin = (olderThan: number, bucketMs: number) => {
      const rows = this.db.prepare(`SELECT seq, doc_id, start_at, end_at, authors, added, removed FROM checkpoints
        WHERE kind = 'edit' AND label IS NULL AND end_at < ? ORDER BY doc_id, seq`).all(now - olderThan) as Row[];
      const update = this.db.prepare('UPDATE checkpoints SET start_at = ?, authors = ?, added = ?, removed = ? WHERE seq = ?');
      const del = this.db.prepare('DELETE FROM checkpoints WHERE seq = ?');
      this.db.transaction(() => {
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i], next = rows[i + 1];
          if (!next || next.doc_id !== r.doc_id || Math.floor(next.end_at / bucketMs) !== Math.floor(r.end_at / bucketMs)) continue;
          // Fold r into next (same document, same period).
          const authors = [...new Set([...JSON.parse(r.authors), ...JSON.parse(next.authors)])];
          update.run(Math.min(r.start_at, next.start_at), JSON.stringify(authors), r.added + next.added, r.removed + next.removed, next.seq);
          next.start_at = Math.min(r.start_at, next.start_at); next.authors = JSON.stringify(authors); next.added += r.added; next.removed += r.removed;
          del.run(r.seq);
        }
      })();
    };
    thin(month, 86400_000);
    thin(week, 3600_000);
  }
}

/** "h123" (as shown to agents) → 123. */
export function parseCheckpointId(ref: unknown): number | null {
  const m = /^h?(\d{1,12})$/.exec(String(ref ?? '').trim());
  return m ? Number(m[1]) : null;
}
