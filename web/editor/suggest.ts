// Suggesting mode: your edits become suggestions instead of changing the text.
//
// The editor shows the shared text S with your pending changes P applied
// (view = P(S)). Keystrokes compose into P and never reach the shared Y.Text;
// changes from others arrive as Yjs events and are rebased over P with
// CodeMirror change sets (operational transform, as @codemirror/collab does).
// P is kept as regions in shared coordinates, one suggestion each: created,
// revised and withdrawn on the server as you type (debounced). Your open
// suggestions are loaded back into P when you start, so you edit them in place.
//
// Everyone else's suggestions (and yours while not suggesting) are drawn as
// overlays: struck-through deletions and inserted text beside them.

import * as Y from 'yjs';
import { diffWordsWithSpace } from 'diff';
import { Annotation, ChangeSet, StateEffect, StateField, Text, Transaction, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { Thread } from '../lib/api';
import type { DocProvider } from './provider';

/** Marks transactions the suggesting engine made itself (not the user's typing). */
export const suggestAnn = Annotation.define<'remote' | 'internal'>();

/** Positions in the shared text vs in the editor (they differ only while suggesting). */
export interface Coords {
  toView(pos: number, assoc?: -1 | 1): number;
  toShared(pos: number, assoc?: -1 | 1): number;
  readonly suggesting: boolean;
}
export const sharedCoords: Coords = { toView: (p) => p, toShared: (p) => p, suggesting: false };

interface Sent { text: string; original: string }
interface Region {
  /** Local identity, stable while the region is edited. */
  key: string;
  /** Server suggestion id, once created. */
  id: string | null;
  /** Replaced range in the shared text, and the replacement. */
  from: number; to: number; text: string;
  /** Where the replacement sits in the editor. */
  vFrom: number; vTo: number;
  /** What the server last confirmed. */
  sent: Sent | null;
  failed: { state: Sent; count: number; message: string } | null;
}

interface SyncResult { key?: string; id?: string; ok: boolean; error?: string; status?: number }
type Op =
  | { op: 'create'; key: string; anchor: { start: string; end: string }; original: string; text: string }
  | { op: 'update'; key: string; id: string; anchor: { start: string; end: string }; original: string; text: string }
  | { op: 'withdraw'; id: string };

const SYNC_DEBOUNCE = 900;
const SYNC_MAX_WAIT = 4000;
const MAX_TRIES = 3;
/** The server's limit for one suggestion's original or replacement. */
const MAX_SUGGESTION = 100_000;
/** One save message carries at most this many ops and characters (the socket refuses big frames). */
const BATCH_OPS = 200;
const BATCH_CHARS = 900_000;

let keySeq = 0;
const newKey = () => `r${Date.now().toString(36)}${(++keySeq).toString(36)}`;
const b64 = (b: Uint8Array) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const same = (a: Sent | null | undefined, b: Sent) => !!a && a.text === b.text && a.original === b.original;
const WORD = /[\p{L}\p{N}_'’-]/u;
const WORD_MAX = 60;
const isWord = (c: string | undefined) => !!c && WORD.test(c);
/** Length of the word characters ending `s`. */
const wordTail = (s: string) => { let n = 0; while (n < s.length && isWord(s[s.length - 1 - n])) n++; return n; };
/** Length of the word characters starting `s`. */
const wordHead = (s: string) => { let n = 0; while (n < s.length && isWord(s[n])) n++; return n; };

/** Resolve a thread's anchor to shared-text positions (points have start === end). */
export function resolveRel(rel: { start: string; end: string }, doc: Y.Doc, ytext: Y.Text): { from: number; to: number; point: boolean } | null {
  try {
    const point = rel.start === rel.end;
    const s = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(unb64(rel.start)), doc);
    const e = point ? s : Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(unb64(rel.end)), doc);
    if (!s || !e || s.type !== ytext || e.type !== ytext) return null;
    return { from: s.index, to: point ? s.index : Math.max(s.index, e.index), point };
  } catch { return null; }
}

/** Relative positions for a suggestion's range, or a point (sticking to the character before it). */
function anchorFor(ytext: Y.Text, from: number, to: number) {
  if (to > from) {
    return {
      start: b64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, from, 0))),
      end: b64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, to, -1))),
    };
  }
  const p = b64(Y.encodeRelativePosition(from > 0 ? Y.createRelativePositionFromTypeIndex(ytext, from, -1) : Y.createRelativePositionFromTypeIndex(ytext, 0, 0)));
  return { start: p, end: p };
}

export class SuggestSession {
  private S: Text = Text.empty;
  private P: ChangeSet = ChangeSet.empty(0);
  private regions: Region[] = [];
  private withdraw = new Set<string>();
  private view: EditorView | null = null;
  private observer: ((e: Y.YTextEvent) => void) | null = null;
  private timer = 0;
  private firstDirty = 0;
  private inflight: Promise<boolean> | null = null;
  private again = false;
  private loaded = false;
  /** Regions or their sync state changed (layout, status line). */
  onChange: () => void = () => {};
  /** A suggestion couldn't be saved after retries. */
  onError: (message: string) => void = () => {};
  /** Something happened to your suggestions the person should know about. */
  onNotice: (message: string) => void = () => {};

  constructor(private deps: { provider: DocProvider; meSub: string }) {}

  readonly coords: Coords = {
    toView: (p, assoc = 1) => this.P.mapPos(Math.max(0, Math.min(p, this.P.length)), assoc),
    toShared: (p, assoc = 1) => this.P.invertedDesc.mapPos(Math.max(0, Math.min(p, this.P.newLength)), assoc),
    suggesting: true,
  };

  /** Server ids of the suggestions being edited here (drawn by the session, not as overlays). */
  get ids(): Set<string> { return new Set(this.regions.flatMap((r) => (r.id ? [r.id] : []))); }

  /** Where a suggestion being edited here sits in the editor. */
  viewRange(id: string): { from: number; to: number } | null {
    const r = this.regions.find((x) => x.id === id);
    return r ? { from: r.vFrom, to: r.vTo } : null;
  }

  /** Changes not yet saved as suggestions. */
  get unsaved(): number {
    return this.regions.filter((r) => !same(r.sent, this.state(r))).length + this.withdraw.size;
  }

  /** Changes that failed to save and won't be retried until edited. */
  get stuck(): number {
    return this.regions.filter((r) => r.failed && r.failed.count >= MAX_TRIES && same(r.failed.state, this.state(r))).length;
  }

  get count(): number { return this.regions.length; }

  private state(r: Region): Sent { return { text: r.text, original: this.S.sliceString(r.from, r.to) }; }

  // ------------------------------------------------------------------ editor binding

  /** The editor extension while suggesting: binds this session to the view. */
  extension() {
    const session = this;
    return [
      ViewPlugin.fromClass(class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          session.attach(view);
          this.decorations = session.decorations(view.state.doc);
        }
        update(u: ViewUpdate) {
          for (const tr of u.transactions) {
            if (!tr.docChanged || tr.annotation(suggestAnn)) continue;
            session.local(tr.changes);
          }
          if (u.docChanged || u.transactions.some((tr) => tr.annotation(suggestAnn))) this.decorations = session.decorations(u.state.doc);
        }
        destroy() { session.detach(); }
      }, { decorations: (v) => v.decorations }),
    ];
  }

  private attach(view: EditorView) {
    this.view = view;
    const ytext = this.deps.provider.ytext;
    // In editing mode the editor mirrors the shared text exactly.
    this.S = view.state.doc;
    if (this.S.toString() !== ytext.toString()) console.warn('[suggest] editor and shared text differ at start');
    this.P = ChangeSet.empty(this.S.length);
    this.regions = [];
    this.observer = (e) => this.remote(e);
    ytext.observe(this.observer);
  }

  private detach() {
    if (this.observer) this.deps.provider.ytext.unobserve(this.observer);
    this.observer = null;
    this.view = null;
    clearTimeout(this.timer);
    this.timer = 0;
  }

  /** The user typed: their change composes into P. */
  private local(changes: ChangeSet) {
    this.P = this.P.compose(changes);
    this.derive(this.regions);
    this.schedule();
  }

  /** Someone else changed the shared text: rebase P over it and show their change. */
  private remote(event: Y.YTextEvent) {
    const specs: { from: number; to?: number; insert?: string }[] = [];
    let pos = 0;
    for (const d of event.delta) {
      if (d.insert != null) specs.push({ from: pos, insert: typeof d.insert === 'string' ? d.insert : '' });
      else if (d.delete != null) { specs.push({ from: pos, to: pos + d.delete }); pos += d.delete; }
      else pos += d.retain ?? 0;
    }
    const R = ChangeSet.of(specs, this.S.length);
    const forView = R.map(this.P, true);
    // Regions whose original text the change deleted entirely: what they replaced is gone.
    const collapsed = new Set<string>();
    const before = this.regions.map((r) => {
      const from = R.mapPos(r.from, 1), to = Math.max(from, R.mapPos(r.to, -1));
      if (r.to > r.from && to <= from) collapsed.add(r.key);
      return { ...r, from, to };
    });
    this.P = this.P.map(R);
    this.S = R.apply(this.S);
    this.derive(before);
    this.view?.dispatch({ changes: forView, annotations: [suggestAnn.of('remote'), Transaction.addToHistory.of(false)] });
    if (collapsed.size) {
      // Don't let the replacement drift onto the next word: drop it here. A saved
      // one stays on the server, where it now shows as outdated.
      this.rebuild(this.regions.filter((r) => !collapsed.has(r.key)));
      this.onNotice('Someone deleted text you were suggesting a change to, so that suggestion no longer applies.');
      return;
    }
    // Someone edited text a suggestion of yours covers: it needs a fresh anchor.
    if (this.regions.some((r) => r.sent && !same(r.sent, this.state(r)))) this.schedule();
    else this.onChange();
  }

  /**
   * Recompute regions from P (trimmed to what actually differs), carrying
   * identity over from the previous regions they overlap. Previous regions
   * that vanished (reverted, or merged into another) are withdrawn.
   */
  private derive(previous: Region[]) {
    // 1. P's changes, trimmed to what actually differs.
    const raw: { from: number; to: number; text: string; vFrom: number; vTo: number }[] = [];
    // Touching changes report as one (a deletion plus what you typed in its place is one replacement).
    this.P.iterChanges((fromA, toA, fromB, toB, ins) => {
      const orig = this.S.sliceString(fromA, toA);
      const text = ins.toString();
      let p = 0;
      while (p < orig.length && p < text.length && orig[p] === text[p]) p++;
      let q = 0;
      while (q < orig.length - p && q < text.length - p && orig[orig.length - 1 - q] === text[text.length - 1 - q]) q++;
      if (orig.length - p - q === 0 && text.length - p - q === 0) return;
      raw.push({ from: fromA + p, to: toA - q, text: text.slice(p, text.length - q), vFrom: fromB + p, vTo: toB - q });
    });
    // 2. Widened to whole words (so "October" → "September" reads as a word
    //    change, not "Octo" → "Septem"); changes that share a word merge.
    const groups: { from: number; to: number; raws: typeof raw }[] = [];
    for (const r of raw) {
      const orig = this.S.sliceString(r.from, r.to);
      const startsInWord = isWord(orig[0]) || isWord(r.text[0]);
      const endsInWord = isWord(orig[orig.length - 1]) || isWord(r.text[r.text.length - 1]);
      const from = r.from - (startsInWord ? wordTail(this.S.sliceString(Math.max(0, r.from - WORD_MAX), r.from)) : 0);
      const to = r.to + (endsInWord ? wordHead(this.S.sliceString(r.to, Math.min(this.S.length, r.to + WORD_MAX))) : 0);
      const prev = groups[groups.length - 1];
      if (prev && from < prev.to) { prev.to = Math.max(prev.to, to); prev.raws.push(r); }
      else groups.push({ from, to, raws: [r] });
    }
    const next: Region[] = groups.map((g) => {
      let text = '', pos = g.from;
      for (const r of g.raws) { text += this.S.sliceString(pos, r.from) + r.text; pos = r.to; }
      text += this.S.sliceString(pos, g.to);
      const first = g.raws[0], last = g.raws[g.raws.length - 1];
      return { key: '', id: null, from: g.from, to: g.to, text, vFrom: first.vFrom - (first.from - g.from), vTo: last.vTo + (g.to - last.to), sent: null, failed: null };
    });
    // Identity: first by real overlap, then (for what's left) by touching.
    const used = new Set<Region>();
    const overlaps = (n: { from: number; to: number }, o: { from: number; to: number }) =>
      (n.from < o.to && o.from < n.to)
      || (n.from === n.to && o.from < n.from && n.from < o.to)
      || (o.from === o.to && n.from < o.from && o.from < n.to)
      || (n.from === n.to && o.from === o.to && n.from === o.from);
    const touches = (n: { from: number; to: number }, o: { from: number; to: number }) => n.from <= o.to && o.from <= n.to;
    const adopt = (n: Region, test: typeof overlaps) => {
      const keep = previous.filter((o) => !used.has(o) && test(n, o)).sort((a, b) => (a.id ? 0 : 1) - (b.id ? 0 : 1) || a.from - b.from)[0];
      if (!keep) return false;
      used.add(keep); n.key = keep.key; n.id = keep.id; n.sent = keep.sent; n.failed = keep.failed;
      return true;
    };
    const unmatched = next.filter((n) => !adopt(n, overlaps));
    for (const n of unmatched) if (!adopt(n, touches)) n.key = newKey();
    for (const o of previous) if (!used.has(o) && o.id && !next.some((n) => n.id === o.id)) this.withdraw.add(o.id);
    this.regions = next;
  }

  /**
   * Replace P with these regions and move the editor to match. Regions that
   * truly overlap an earlier one are dropped (and withdrawn, if saved).
   */
  private rebuild(regions: Region[]) {
    if (!this.view) return;
    const sorted = [...regions].sort((a, b) => a.from - b.from || a.to - b.to);
    const keep: Region[] = [];
    for (const r of sorted) {
      const prev = keep[keep.length - 1];
      const clash = prev && (r.from < prev.to || (r.from === r.to && prev.from === prev.to && r.from === prev.from));
      if (clash) { if (r.id) this.withdraw.add(r.id); continue; }
      keep.push(r);
    }
    const nextP = ChangeSet.of(keep.map((r) => ({ from: r.from, to: r.to, insert: r.text })), this.S.length);
    const step = this.P.invert(this.S).compose(nextP);
    this.P = nextP;
    this.derive(keep);
    this.view.dispatch({ changes: step, annotations: [suggestAnn.of('internal'), Transaction.addToHistory.of(false)] });
    this.onChange();
  }

  // ------------------------------------------------------------------ threads

  /**
   * New thread list from the server: load your open suggestions on the first
   * one (so you edit them in place), and drop regions whose suggestion was
   * accepted, rejected or deleted since.
   */
  onThreads(threads: Thread[]) {
    if (!this.view) return;
    if (!this.loaded) {
      this.loaded = true;
      const p = this.deps.provider;
      const add: Region[] = [];
      for (const t of threads) {
        const sg = t.suggestion;
        if (!sg || sg.status !== 'open' || sg.outdated || !t.rel || t.comments[0]?.author.sub !== this.deps.meSub) continue;
        if (this.regions.some((r) => r.id === t.id)) continue;
        const at = resolveRel(t.rel, p.doc, p.ytext);
        if (!at || this.S.sliceString(at.from, at.to) !== sg.original) continue;
        add.push({ key: newKey(), id: t.id, from: at.from, to: at.to, text: sg.text, vFrom: 0, vTo: 0, sent: { text: sg.text, original: sg.original }, failed: null });
      }
      if (add.length) this.rebuild([...this.regions, ...add]);
      return;
    }
    // A suggestion of yours the server announced before acknowledging the save: adopt its id now.
    const p = this.deps.provider;
    for (const t of threads) {
      const sg = t.suggestion;
      if (!sg || sg.status !== 'open' || !t.rel || t.comments[0]?.author.sub !== this.deps.meSub || this.regions.some((r) => r.id === t.id)) continue;
      const at = resolveRel(t.rel, p.doc, p.ytext);
      const r = at && this.regions.find((x) => !x.id && x.from === at.from && x.to === at.to && x.text === sg.text);
      if (r) r.id = t.id;
    }
    const byId = new Map(threads.map((t) => [t.id, t]));
    const gone = this.regions.filter((r) => r.id && byId.get(r.id)?.suggestion?.status !== 'open');
    if (gone.length) {
      for (const r of gone) this.withdraw.delete(r.id!);
      this.rebuild(this.regions.filter((r) => !gone.includes(r)));
    }
  }

  // ------------------------------------------------------------------ saving

  private schedule() {
    clearTimeout(this.timer);
    const now = Date.now();
    if (!this.firstDirty) this.firstDirty = now;
    const wait = Math.max(0, Math.min(SYNC_DEBOUNCE, this.firstDirty + SYNC_MAX_WAIT - now));
    this.timer = window.setTimeout(() => { this.timer = 0; void this.sync(); }, wait);
    this.onChange();
  }

  /** Save pending changes now. Resolves true if everything is saved. */
  sync(): Promise<boolean> {
    clearTimeout(this.timer);
    this.timer = 0;
    if (this.inflight) { this.again = true; return this.inflight.then(() => this.sync()); }
    this.inflight = this.syncOnce().finally(() => { this.inflight = null; });
    return this.inflight.then((ok) => {
      if (this.again) { this.again = false; return this.sync(); }
      return ok;
    });
  }

  private async syncOnce(): Promise<boolean> {
    this.firstDirty = 0;
    const ytext = this.deps.provider.ytext;
    const ops: Op[] = [];
    const states = new Map<string, Sent>();
    for (const r of this.regions) {
      const st = this.state(r);
      if (same(r.sent, st)) continue;
      if (r.failed && r.failed.count >= MAX_TRIES && same(r.failed.state, st)) continue;
      if (r.from === r.to && !r.text) continue;
      if (st.text.length > MAX_SUGGESTION || st.original.length > MAX_SUGGESTION) {
        // The server would refuse it: say so once, don't send it.
        r.failed = { state: st, count: MAX_TRIES, message: `This change is too large to suggest (over ${MAX_SUGGESTION.toLocaleString()} characters). Split it into smaller changes.` };
        this.onError(r.failed.message);
        continue;
      }
      states.set(r.key, st);
      const anchor = anchorFor(ytext, r.from, r.to);
      ops.push(r.id ? { op: 'update', key: r.key, id: r.id, anchor, original: st.original, text: st.text } : { op: 'create', key: r.key, anchor, original: st.original, text: st.text });
    }
    for (const id of this.withdraw) ops.push({ op: 'withdraw', id });
    if (!ops.length) { this.onChange(); this.redraw(); return true; }
    // Batches small enough for one socket frame.
    const batches: Op[][] = [];
    let cur: Op[] = [], chars = 0;
    for (const op of ops) {
      const size = op.op === 'withdraw' ? 64 : op.text.length + op.original.length + 256;
      if (cur.length && (cur.length >= BATCH_OPS || chars + size > BATCH_CHARS)) { batches.push(cur); cur = []; chars = 0; }
      cur.push(op); chars += size;
    }
    if (cur.length) batches.push(cur);
    let all = true;
    const fail = (op: Op, message: string) => {
      all = false;
      if (op.op === 'withdraw') return;
      const r = this.regions.find((y) => y.key === op.key);
      const st = states.get(op.key)!;
      if (!r) return;
      const count = r.failed && same(r.failed.state, st) ? r.failed.count + 1 : 1;
      r.failed = { state: st, count, message };
      if (count === MAX_TRIES) this.onError(message);
    };
    try {
      for (const batch of batches) {
        let res: { results: SyncResult[] };
        try {
          res = await this.deps.provider.request<{ results: SyncResult[] }>({ type: 'suggestion.sync', ops: batch });
        } catch (e) {
          if (this.deps.provider.status !== 'online') return false; // offline: saved when the connection is back (the page calls sync)
          // The server refused the whole message: count it against each change, so it can't loop.
          for (const op of batch) fail(op, (e as Error).message || 'Couldn’t save this suggestion.');
          continue;
        }
        res.results.forEach((x, i) => {
          const op = batch[i];
          if (op.op === 'withdraw') { if (x.ok) this.withdraw.delete(op.id); else all = false; return; }
          const r = this.regions.find((y) => y.key === op.key);
          if (x.ok) {
            if (r) { if (x.id) r.id = x.id; r.sent = states.get(op.key)!; r.failed = null; }
            else if (op.op === 'create' && x.id) this.withdraw.add(x.id); // the region vanished while saving
            return;
          }
          fail(op, x.error ?? 'Couldn’t save this suggestion.');
        });
      }
    } finally {
      this.redraw();
      this.onChange();
    }
    // A failure that may succeed on a later try (the text moved under it): try again soon.
    if (this.regions.some((r) => r.failed && r.failed.count < MAX_TRIES && same(r.failed.state, this.state(r)))) this.schedule();
    return all;
  }

  /** Redraw the regions (their saved state changed; the text didn't). */
  private redraw() {
    this.view?.dispatch({ annotations: suggestAnn.of('internal') });
  }

  /** Leave suggesting mode: save what's pending, then show the shared text again. Resolves the number of changes that couldn't be saved. */
  async finish(): Promise<number> {
    await this.sync();
    const lost = this.unsaved;
    if (this.view) {
      this.view.dispatch({ changes: this.P.invert(this.S), annotations: [suggestAnn.of('internal'), Transaction.addToHistory.of(false)] });
    }
    this.P = ChangeSet.empty(this.S.length);
    this.regions = [];
    return lost;
  }

  /** Drop pending changes that couldn't be saved (and stop retrying). */
  discardStuck() {
    const stuck = this.regions.filter((r) => r.failed && r.failed.count >= MAX_TRIES && same(r.failed.state, this.state(r)));
    if (stuck.length) this.rebuild(this.regions.filter((r) => !stuck.includes(r)));
  }

  // ------------------------------------------------------------------ drawing

  private decorations(doc: Text): DecorationSet {
    const out: Range<Decoration>[] = [];
    const len = doc.length;
    for (const r of this.regions) {
      const st = this.state(r);
      const saved = same(r.sent, st);
      const stuck = !!r.failed && r.failed.count >= MAX_TRIES && same(r.failed.state, st);
      const attrs: Record<string, string> = r.id ? { 'data-thread': r.id } : {};
      const from = Math.min(r.vFrom, len), to = Math.min(r.vTo, len);
      if (st.original) out.push(Decoration.widget({ widget: new StruckWidget(st.original, r.id, saved ? 'mine' : stuck ? 'mine stuck' : 'mine pending'), side: -1 }).range(from));
      if (to > from) out.push(Decoration.mark({ class: `cm-sugg-ins mine${saved ? '' : stuck ? ' stuck' : ' pending'}`, attributes: attrs }).range(from, to));
    }
    return Decoration.set(out, true);
  }
}

// ------------------------------------------------------------------ overlays (others' suggestions)

export interface OverlayItem {
  id: string;
  /** Editor range of the original text (equal for an insertion point). */
  from: number; to: number;
  original: string; text: string;
  outdated: boolean;
  active: boolean;
}

export const setOverlays = StateEffect.define<OverlayItem[]>();

export interface DiffPart { value: string; added?: boolean; removed?: boolean }

/**
 * A readable word diff: matches of mere spacing (or a character or two)
 * between changes are folded into the change, so "Launch notes (draft)" →
 * "Beta launch notes" reads as one replacement, not five interleaved pieces.
 * Concatenating the non-added parts still gives the original exactly.
 */
export function wordDiff(original: string, text: string): DiffPart[] | undefined {
  if (original.length + text.length > 20_000) return undefined;
  const parts = diffWordsWithSpace(original, text, { timeout: 50 }) as DiffPart[] | undefined;
  if (!parts) return undefined;
  const out: DiffPart[] = [];
  let del = '', ins = '';
  const flush = () => { if (del) out.push({ value: del, removed: true }); if (ins) out.push({ value: ins, added: true }); del = ins = ''; };
  parts.forEach((p, i) => {
    if (p.added) { ins += p.value; return; }
    if (p.removed) { del += p.value; return; }
    const between = (del || ins) && i < parts.length - 1;
    if (between && !p.value.includes('\n') && (!p.value.trim() || p.value.length <= 2)) { del += p.value; ins += p.value; return; }
    flush();
    out.push(p);
  });
  flush();
  return out;
}

/** Word-level diff spans of one suggestion, in the coordinates of its original. */
function diffSpans(original: string, text: string): { del: [number, number][]; ins: { at: number; text: string }[] } {
  const del: [number, number][] = [];
  const ins: { at: number; text: string }[] = [];
  const parts = wordDiff(original, text);
  if (!parts) {
    if (original) del.push([0, original.length]);
    if (text) ins.push({ at: original.length, text });
    return { del, ins };
  }
  let off = 0;
  for (const p of parts) {
    if (p.removed) { del.push([off, off + p.value.length]); off += p.value.length; }
    else if (p.added) ins.push({ at: off, text: p.value });
    else off += p.value.length;
  }
  return { del, ins };
}

function buildOverlays(items: OverlayItem[], doc: Text): DecorationSet {
  const out: Range<Decoration>[] = [];
  const len = doc.length;
  for (const it of items) {
    const from = Math.max(0, Math.min(it.from, len)), to = Math.max(from, Math.min(it.to, len));
    const attrs = { 'data-thread': it.id };
    const act = it.active ? ' active' : '';
    if (it.outdated) {
      if (to > from) out.push(Decoration.mark({ class: `cm-sugg-outdated${act}`, attributes: attrs }).range(from, to));
      continue;
    }
    // The editor may not show the original verbatim (your own pending change overlaps it): fall back to whole-range marks.
    const spans = doc.sliceString(from, to) === it.original ? diffSpans(it.original, it.text)
      : { del: to > from ? [[0, to - from] as [number, number]] : [], ins: it.text ? [{ at: to - from, text: it.text }] : [] };
    for (const [a, b] of spans.del) if (b > a) out.push(Decoration.mark({ class: `cm-sugg-del${act}`, attributes: attrs }).range(from + a, from + b));
    for (const s of spans.ins) out.push(Decoration.widget({ widget: new InsertWidget(s.text, it.id, it.active), side: 1 }).range(from + s.at));
  }
  return Decoration.set(out, true);
}

export const suggestionOverlays = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setOverlays)) deco = buildOverlays(e.value, tr.state.doc);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const SHOW_MAX = 1200;
const clipShown = (s: string) => (s.length > SHOW_MAX ? `${s.slice(0, SHOW_MAX)} … (${(s.length - SHOW_MAX).toLocaleString()} more characters)` : s);

class InsertWidget extends WidgetType {
  constructor(readonly text: string, readonly id: string, readonly active: boolean) { super(); }
  toDOM() {
    const el = document.createElement('span');
    el.className = `cm-sugg-ins-widget${this.active ? ' active' : ''}`;
    el.dataset.thread = this.id;
    el.textContent = clipShown(this.text);
    return el;
  }
  eq(o: InsertWidget) { return o.text === this.text && o.id === this.id && o.active === this.active; }
  ignoreEvent() { return false; }
}

class StruckWidget extends WidgetType {
  constructor(readonly text: string, readonly id: string | null, readonly kind: string) { super(); }
  toDOM() {
    const el = document.createElement('span');
    el.className = `cm-sugg-del-widget ${this.kind}`;
    if (this.id) el.dataset.thread = this.id;
    el.textContent = clipShown(this.text);
    el.setAttribute('aria-label', `Suggested deletion: ${this.text.slice(0, 200)}`);
    return el;
  }
  eq(o: StruckWidget) { return o.text === this.text && o.id === this.id && o.kind === this.kind; }
  ignoreEvent() { return false; }
}
