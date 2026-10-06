// Comment anchor highlights in the editor.

import { StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

export interface Anchored { id: string; from: number; to: number }
export interface HighlightState { ranges: Anchored[]; active: string | null; draft: { from: number; to: number } | null }

export const setHighlights = StateEffect.define<HighlightState>();

function build(s: HighlightState, docLen: number): DecorationSet {
  const out: Range<Decoration>[] = [];
  for (const r of s.ranges) {
    const from = Math.max(0, Math.min(r.from, docLen)), to = Math.max(0, Math.min(r.to, docLen));
    if (to <= from) continue;
    out.push(Decoration.mark({ class: r.id === s.active ? 'cm-comment-hl active' : 'cm-comment-hl', attributes: { 'data-thread': r.id } }).range(from, to));
  }
  if (s.draft && s.draft.to > s.draft.from) out.push(Decoration.mark({ class: 'cm-comment-draft' }).range(Math.min(s.draft.from, docLen), Math.min(s.draft.to, docLen)));
  return Decoration.set(out, true);
}

export const commentHighlights = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setHighlights)) deco = build(e.value, tr.state.doc.length);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
