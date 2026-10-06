// Formatting commands over markdown source.

import { EditorSelection, type ChangeSpec, type EditorState, type SelectionRange } from '@codemirror/state';
import type { EditorView, KeyBinding } from '@codemirror/view';

const editable = (view: EditorView) => !view.state.readOnly;

/** Does `text` start and end with exactly `marker` (so ** isn't mistaken for *)? */
function wrappedBy(text: string, marker: string): boolean {
  if (text.length < marker.length * 2 || !text.startsWith(marker) || !text.endsWith(marker)) return false;
  if (marker === '*') {
    const lead = /^\*+/.exec(text)![0].length, trail = /\*+$/.exec(text)![0].length;
    return lead % 2 === 1 && trail % 2 === 1;
  }
  return true;
}

function outerMarker(state: EditorState, r: SelectionRange, marker: string): boolean {
  const n = marker.length;
  if (state.sliceDoc(r.from - n, r.from) !== marker || state.sliceDoc(r.to, r.to + n) !== marker) return false;
  if (marker === '*') {
    // "**bold**" around the selection is bold, not italic — unless it is ***.
    const before = state.sliceDoc(Math.max(0, r.from - 3), r.from), after = state.sliceDoc(r.to, r.to + 3);
    const lead = /\**$/.exec(before)![0].length, trail = /^\**/.exec(after)![0].length;
    return lead % 2 === 1 && trail % 2 === 1;
  }
  return true;
}

export function toggleInline(view: EditorView, marker: string): boolean {
  if (!editable(view)) return false;
  const { state } = view;
  const n = marker.length;
  const tr = state.changeByRange((r) => {
    if (r.empty) {
      if (state.sliceDoc(r.from - n, r.from) === marker && state.sliceDoc(r.from, r.from + n) === marker) {
        return { changes: { from: r.from - n, to: r.from + n }, range: EditorSelection.cursor(r.from - n) };
      }
      const word = state.wordAt(r.from);
      if (word && word.from < r.from && word.to > r.from) {
        return { changes: [{ from: word.from, insert: marker }, { from: word.to, insert: marker }], range: EditorSelection.cursor(r.from + n) };
      }
      return { changes: { from: r.from, insert: marker + marker }, range: EditorSelection.cursor(r.from + n) };
    }
    const text = state.sliceDoc(r.from, r.to);
    if (wrappedBy(text, marker)) {
      return { changes: [{ from: r.from, to: r.from + n }, { from: r.to - n, to: r.to }], range: EditorSelection.range(r.from, r.to - 2 * n) };
    }
    if (outerMarker(state, r, marker)) {
      return { changes: [{ from: r.from - n, to: r.from }, { from: r.to, to: r.to + n }], range: EditorSelection.range(r.from - n, r.to - n) };
    }
    // Keep markers hugging the text: **word** not ** word **.
    const lead = text.length - text.trimStart().length, trail = text.length - text.trimEnd().length;
    const from = r.from + lead, to = r.to - trail;
    if (to <= from) return { range: r };
    return { changes: [{ from, insert: marker }, { from: to, insert: marker }], range: EditorSelection.range(from + n, to + n) };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }));
  view.focus();
  return true;
}

export type LineKind = 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'ul' | 'ol' | 'task' | 'quote';

const HEADING = /^(\s{0,3})(#{1,6})\s+/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/;
const QUOTE = /^(\s{0,3})>\s?/;

function kindOf(text: string): LineKind {
  const h = HEADING.exec(text);
  if (h) return `h${h[2].length}` as LineKind;
  const l = LIST.exec(text);
  if (l) return l[3] ? 'task' : /\d/.test(l[2]) ? 'ol' : 'ul';
  if (QUOTE.test(text)) return 'quote';
  return 'p';
}

/** Current block kind at the main cursor (for toolbar state). */
export function lineKindAt(state: EditorState): LineKind {
  return kindOf(state.doc.lineAt(state.selection.main.head).text);
}

export function setLineKind(view: EditorView, kind: LineKind): boolean {
  if (!editable(view)) return false;
  const { state } = view;
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    for (let l = state.doc.lineAt(r.from).number; l <= state.doc.lineAt(r.to).number; l++) lines.add(l);
  }
  const nums = [...lines].sort((a, b) => a - b);
  const allAlready = nums.every((n) => kindOf(state.doc.line(n).text) === kind);
  const target: LineKind = allAlready && kind !== 'p' ? 'p' : kind;
  const changes: ChangeSpec[] = [];
  let ordinal = 0;
  for (const n of nums) {
    const line = state.doc.line(n);
    if (!line.text.trim() && nums.length > 1) continue;
    const text = line.text;
    let strip = 0, indent = '';
    const h = HEADING.exec(text), l = LIST.exec(text), q = QUOTE.exec(text);
    if (h) strip = h[0].length;
    else if (l) { strip = l[0].length; indent = l[1]; }
    else if (q) strip = q[0].length;
    ordinal++;
    const prefix = target === 'p' ? indent
      : target.startsWith('h') ? `${'#'.repeat(Number(target[1]))} `
      : target === 'ul' ? `${indent}- `
      : target === 'ol' ? `${indent}${ordinal}. `
      : target === 'task' ? `${indent}- [ ] `
      : '> ';
    changes.push({ from: line.from, to: line.from + strip, insert: prefix });
  }
  view.dispatch({ changes, scrollIntoView: true, userEvent: 'input.format' });
  view.focus();
  return true;
}

/** Insert a block (table, rule, image, code) as its own paragraph near the cursor or at `at`. */
export function insertBlock(view: EditorView, text: string, opts: { at?: number; select?: [number, number] } = {}): boolean {
  if (!editable(view)) return false;
  const { state } = view;
  const pos = opts.at ?? state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const blank = line.text.trim() === '';
  const prevBlank = line.number === 1 || state.doc.line(line.number - 1).text.trim() === '';
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
  let from: number, to: number, before: string;
  if (blank) { from = line.from; to = line.to; before = prevBlank ? '' : '\n'; }
  else { from = line.to; to = line.to; before = '\n\n'; }
  // Leave a blank line after the block (a GFM table would swallow the next line
  // otherwise) and, at the end of the document, a fresh line to keep typing on.
  const after = !next ? '\n\n' : next.text.trim() !== '' ? '\n' : '';
  const insert = before + text + after;
  const base = from + before.length;
  const selection = opts.select ? EditorSelection.range(base + opts.select[0], base + opts.select[1]) : EditorSelection.cursor(base + text.length);
  view.dispatch({ changes: { from, to, insert }, selection, scrollIntoView: true, userEvent: 'input.insert' });
  view.focus();
  return true;
}

export const TABLE_TEMPLATE = '| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| Cell | Cell | Cell |\n| Cell | Cell | Cell |';

export function insertTable(view: EditorView) {
  return insertBlock(view, TABLE_TEMPLATE, { select: [2, 10] });
}

export function insertRule(view: EditorView) {
  return insertBlock(view, '---');
}

export function toggleCodeBlock(view: EditorView): boolean {
  if (!editable(view)) return false;
  const { state } = view;
  const r = state.selection.main;
  if (r.empty) {
    const line = state.doc.lineAt(r.head);
    if (line.text.trim() === '') return insertBlock(view, '```\n\n```', { select: [4, 4] });
    // Fence the current line.
    view.dispatch({ changes: [{ from: line.from, insert: '```\n' }, { from: line.to, insert: '\n```' }], selection: EditorSelection.cursor(r.head + 4), userEvent: 'input.format' });
    view.focus();
    return true;
  }
  const a = state.doc.lineAt(r.from), b = state.doc.lineAt(r.to);
  const prev = a.number > 1 ? state.doc.line(a.number - 1).text : '';
  const next = b.number < state.doc.lines ? state.doc.line(b.number + 1).text : '';
  if (prev.trim().startsWith('```') && next.trim().startsWith('```')) {
    const pl = state.doc.line(a.number - 1), nl = state.doc.line(b.number + 1);
    view.dispatch({ changes: [{ from: pl.from, to: a.from }, { from: b.to, to: nl.to }], userEvent: 'input.format' });
  } else {
    view.dispatch({ changes: [{ from: a.from, insert: '```\n' }, { from: b.to, insert: '\n```' }], userEvent: 'input.format' });
  }
  view.focus();
  return true;
}

export function insertLink(view: EditorView, text: string, url: string, range?: { from: number; to: number }) {
  const r = range ?? view.state.selection.main;
  const label = text || url;
  const insert = `[${label}](${url})`;
  view.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: EditorSelection.cursor(r.from + insert.length), userEvent: 'input.format' });
  view.focus();
}

export function selectedText(view: EditorView): string {
  const r = view.state.selection.main;
  return view.state.sliceDoc(r.from, r.to);
}

export const formatKeymap: KeyBinding[] = [
  { key: 'Mod-b', run: (v) => toggleInline(v, '**') },
  { key: 'Mod-i', run: (v) => toggleInline(v, '*') },
  { key: 'Mod-Shift-x', run: (v) => toggleInline(v, '~~') },
  { key: 'Alt-Shift-5', run: (v) => toggleInline(v, '~~') },
  { key: 'Mod-e', run: (v) => toggleInline(v, '`') },
  { key: 'Mod-Alt-0', run: (v) => setLineKind(v, 'p') },
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ key: `Mod-Alt-${n}`, run: (v: EditorView) => setLineKind(v, `h${n}` as LineKind) })),
  { key: 'Mod-Shift-7', run: (v) => setLineKind(v, 'ol') },
  { key: 'Mod-Shift-8', run: (v) => setLineKind(v, 'ul') },
  { key: 'Mod-Shift-9', run: (v) => setLineKind(v, 'task') },
];
