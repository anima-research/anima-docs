// Live preview: the markdown source reads like a document.
//
// Inline layer (view plugin, visible ranges only): heading sizes, emphasis,
// dimmed syntax marks that hide when the cursor is off the line, bullets,
// task checkboxes, rules, code-block and quote styling.
//
// Block layer (state field, since block widgets can't come from plugins):
// images as figures under their line (or replacing an image-only line), and
// tables rendered as real tables while the cursor is outside them.

import { syntaxTree } from '@codemirror/language';
import { StateEffect, StateField, type EditorState, type Range, type Transaction } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { SyntaxNodeRef } from '@lezer/common';
import { isSafeImageSrc } from '../lib/markdown';
import { TableWidget } from './table';
import { parseAltSize, withAltSize } from '../../src/mdext';

// ------------------------------------------------------------------ focus tracking

const setFocus = StateEffect.define<boolean>();
const focusField = StateField.define<boolean>({
  create: () => false,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setFocus)) v = e.value;
    return v;
  },
});
/**
 * Keep focusField in step with view.hasFocus. (EditorView.focusChangeEffect is
 * not enough: CodeMirror drops that transaction when anything else dispatches
 * first, e.g. a collaborator's cursor arriving in the same tick.)
 */
const focusTracker = ViewPlugin.fromClass(class {
  timer = 0;
  constructor(readonly view: EditorView) { this.check(); }
  update() { this.check(); }
  check() {
    if (this.timer || this.view.state.field(focusField) === this.view.hasFocus) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      const focused = this.view.hasFocus;
      if (this.view.state.field(focusField) !== focused) this.view.dispatch({ effects: setFocus.of(focused) });
    }, 0);
  }
  destroy() { clearTimeout(this.timer); }
});

/** Line numbers the user is working on (raw markdown is shown there). */
function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  if (!state.field(focusField, false)) return lines;
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number, b = state.doc.lineAt(r.to).number;
    for (let i = a; i <= b && i - a < 2000; i++) lines.add(i);
  }
  return lines;
}

function touchesSelection(state: EditorState, from: number, to: number): boolean {
  if (!state.field(focusField, false)) return false;
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

// ------------------------------------------------------------------ widgets

class BulletWidget extends WidgetType {
  constructor(readonly depth: number) { super(); }
  eq(o: BulletWidget) { return o.depth === this.depth; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-bullet';
    s.textContent = ['•', '◦', '▪'][this.depth % 3];
    return s;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) { super(); }
  eq(o: CheckboxWidget) { return o.checked === this.checked; }
  toDOM(view: EditorView) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-task-checkbox';
    box.checked = this.checked;
    box.setAttribute('aria-label', this.checked ? 'Completed task' : 'Open task');
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('click', (e) => {
      e.preventDefault();
      if (view.state.readOnly) return;
      const pos = view.posAtDOM(box);
      const ch = view.state.sliceDoc(pos + 1, pos + 2);
      if (view.state.sliceDoc(pos, pos + 1) !== '[') return;
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: ch === ' ' ? 'x' : ' ' }, userEvent: 'input.toggle' });
    });
    return box;
  }
  ignoreEvent() { return false; }
}

class RuleWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-hr-widget';
    s.setAttribute('aria-hidden', 'true');
    return s;
  }
}

interface Img { src: string; alt: string; /** Where the alt text sits in the document (resizing rewrites it). */ altFrom: number; altTo: number }

class ImageWidget extends WidgetType {
  constructor(readonly images: Img[], readonly replacesLine: boolean) { super(); }
  eq(o: ImageWidget) {
    return o.replacesLine === this.replacesLine && o.images.length === this.images.length && o.images.every((im, i) => im.src === this.images[i].src && im.alt === this.images[i].alt && im.altFrom === this.images[i].altFrom);
  }
  get estimatedHeight() { return 260; }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div');
    wrap.className = `cm-image-block${this.replacesLine ? ' replaces-line' : ''}`;
    for (const im of this.images) {
      const fig = document.createElement('figure');
      fig.className = 'cm-image-figure';
      const size = parseAltSize(im.alt);
      if (!isSafeImageSrc(im.src)) {
        fig.append(placeholder(im.src ? `Images must use https:// or be uploaded (${truncate(im.src, 48)})` : 'Image has no address'));
      } else {
        const img = document.createElement('img');
        img.alt = size.alt;
        img.decoding = 'async';
        img.draggable = false;
        if (size.width) { img.style.width = `${size.width}px`; if (size.height) img.style.height = `${size.height}px`; }
        img.addEventListener('load', () => { fig.classList.add('loaded'); view.requestMeasure(); });
        img.addEventListener('error', () => { img.replaceWith(placeholder(`Couldn't load image ${truncate(im.src, 48)}`)); view.requestMeasure(); });
        img.src = im.src;
        fig.append(img);
        // A grip to resize by dragging: the size is written into the alt text (`![alt|400](url)`).
        const grip = document.createElement('span');
        grip.className = 'cm-image-grip';
        grip.title = 'Drag to resize (double-click to reset)';
        grip.setAttribute('aria-hidden', 'true');
        grip.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); this.writeSize(view, im, null); });
        grip.addEventListener('mousedown', (e) => {
          e.preventDefault(); e.stopPropagation();
          const startX = e.clientX, startW = img.getBoundingClientRect().width;
          const maxW = Math.max(80, (wrap.parentElement?.getBoundingClientRect().width ?? 800));
          let w = startW;
          const move = (ev: MouseEvent) => { w = Math.round(Math.max(40, Math.min(maxW, startW + ev.clientX - startX))); img.style.width = `${w}px`; img.style.height = ''; };
          const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); fig.classList.remove('resizing'); this.writeSize(view, im, w); };
          fig.classList.add('resizing');
          document.addEventListener('mousemove', move);
          document.addEventListener('mouseup', up);
        });
        fig.append(grip);
      }
      if (size.alt && this.replacesLine) {
        const cap = document.createElement('figcaption');
        cap.textContent = size.alt;
        fig.append(cap);
      }
      wrap.append(fig);
    }
    wrap.addEventListener('mousedown', (e) => {
      e.preventDefault();
      // Put the cursor on the image's markdown so it can be edited.
      const doc = view.state.doc;
      const pos = Math.min(view.posAtDOM(wrap), doc.length);
      let line = doc.lineAt(pos);
      if (!this.replacesLine && line.from === pos && pos > 0) line = doc.lineAt(pos - 1);
      view.focus();
      view.dispatch({ selection: { anchor: line.to } });
    });
    return wrap;
  }
  /** Rewrite the image's alt text with a size (or without one). */
  private writeSize(view: EditorView, im: Img, width: number | null) {
    const doc = view.state.doc;
    if (im.altTo > doc.length || doc.sliceString(im.altFrom, im.altTo) !== im.alt) return; // the text moved: leave it
    const next = withAltSize(im.alt, width);
    if (next === im.alt) return;
    view.dispatch({ changes: { from: im.altFrom, to: im.altTo, insert: next }, userEvent: 'input.resize' });
  }
  ignoreEvent() { return true; }
}

function placeholder(text: string) {
  const d = document.createElement('div');
  d.className = 'cm-image-missing';
  d.textContent = text;
  return d;
}
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Split a GFM table row into cells with their source offsets (relative to the row start). */
export { splitRow } from './table';

// ------------------------------------------------------------------ inline layer

const hidden = Decoration.replace({});
const markDim = Decoration.mark({ class: 'cm-md-mark' });
const inlineCode = Decoration.mark({ class: 'cm-inline-code' });
const linkText = Decoration.mark({ class: 'cm-link-text' });
const ruleWidget = Decoration.replace({ widget: new RuleWidget() });

function depthOf(node: SyntaxNodeRef, name: string): number {
  let d = 0;
  for (let p = node.node.parent; p; p = p.parent) if (p.name === name) d++;
  return d;
}

function buildInline(view: EditorView): DecorationSet {
  const state = view.state;
  const doc = state.doc;
  const active = activeLines(state);
  const isActive = (pos: number) => active.has(doc.lineAt(pos).number);
  const out: Range<Decoration>[] = [];
  const lineClass = (pos: number, cls: string) => out.push(Decoration.line({ class: cls }).range(doc.lineAt(pos).from));
  const eachLine = (from: number, to: number, fn: (lineFrom: number, idx: number, last: boolean) => void) => {
    const a = doc.lineAt(from).number, b = doc.lineAt(to).number;
    for (let i = a; i <= b; i++) fn(doc.line(i).from, i - a, i === b);
  };
  /** Hide a mark plus the whitespace after it. */
  const hideWithSpace = (from: number, to: number) => {
    let end = to;
    while (end < doc.length && end - to < 4 && doc.sliceString(end, end + 1) === ' ') end++;
    out.push(hidden.range(from, end));
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: (node) => {
        const name = node.name;
        const m = /^(ATX|Setext)Heading(\d)$/.exec(name);
        if (m) {
          const level = Number(m[2]);
          if (m[1] === 'ATX') lineClass(node.from, `cm-h cm-h${level}`);
          else {
            const mark = node.node.getChild('HeaderMark');
            eachLine(node.from, mark ? Math.max(node.from, mark.from - 1) : node.to, (lf) => out.push(Decoration.line({ class: `cm-h cm-h${level}` }).range(lf)));
          }
          return;
        }
        switch (name) {
          case 'HeaderMark': {
            const parent = node.node.parent?.name ?? '';
            if (parent.startsWith('Setext')) { out.push(markDim.range(node.from, node.to)); return; }
            if (isActive(node.from)) out.push(markDim.range(node.from, node.to));
            else if (node.from === doc.lineAt(node.from).from || /^\s*$/.test(doc.sliceString(doc.lineAt(node.from).from, node.from))) hideWithSpace(node.from, node.to);
            else out.push(hidden.range(Math.max(doc.lineAt(node.from).from, node.from - 1), node.to)); // closing ###
            return;
          }
          case 'EmphasisMark':
          case 'StrikethroughMark':
            if (isActive(node.from)) out.push(markDim.range(node.from, node.to));
            else out.push(hidden.range(node.from, node.to));
            return;
          case 'InlineCode': {
            out.push(inlineCode.range(node.from, node.to));
            const act = isActive(node.from);
            const c = node.node.cursor();
            if (c.firstChild()) do {
              if (c.name === 'CodeMark') out.push((act ? markDim : hidden).range(c.from, c.to));
            } while (c.nextSibling());
            return false;
          }
          case 'FencedCode':
          case 'CodeBlock': {
            eachLine(node.from, node.to, (lf, i, last) => out.push(Decoration.line({ class: `cm-code-line${i === 0 ? ' cm-code-first' : ''}${last ? ' cm-code-last' : ''}${name === 'FencedCode' && (i === 0 || last) ? ' cm-code-fence' : ''}` }).range(lf)));
            const c = node.node.cursor();
            if (c.firstChild()) do {
              if (c.name === 'CodeMark' || c.name === 'CodeInfo') out.push(markDim.range(c.from, c.to));
            } while (c.nextSibling());
            return false;
          }
          case 'Blockquote': {
            eachLine(node.from, node.to, (lf) => out.push(Decoration.line({ class: 'cm-quote-line' }).range(lf)));
            return;
          }
          case 'QuoteMark':
            if (isActive(node.from)) out.push(markDim.range(node.from, node.to));
            else hideWithSpace(node.from, node.to);
            return;
          case 'ListMark': {
            const item = node.node.parent;
            const list = item?.parent;
            const task = item?.getChild('Task');
            if (isActive(node.from)) { out.push(markDim.range(node.from, node.to)); return; }
            if (task) { hideWithSpace(node.from, node.to); return; }
            if (list?.name === 'BulletList') out.push(Decoration.replace({ widget: new BulletWidget(depthOf(node, 'BulletList') - 1) }).range(node.from, node.to));
            else out.push(Decoration.mark({ class: 'cm-ordered-mark' }).range(node.from, node.to));
            return;
          }
          case 'TaskMarker': {
            const checked = /x/i.test(doc.sliceString(node.from, node.to));
            if (isActive(node.from)) out.push(markDim.range(node.from, node.to));
            else out.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(node.from, node.to));
            if (checked) {
              const line = doc.lineAt(node.from);
              if (node.to < line.to) out.push(Decoration.mark({ class: 'cm-task-done' }).range(node.to, line.to));
            }
            return;
          }
          case 'HorizontalRule':
            lineClass(node.from, 'cm-hr-line');
            if (!isActive(node.from)) out.push(ruleWidget.range(node.from, node.to));
            else out.push(markDim.range(node.from, node.to));
            return;
          case 'Link': {
            const marks = node.node.getChildren('LinkMark');
            const url = node.node.getChild('URL');
            if (marks.length >= 2 && doc.sliceString(marks[0].from, marks[0].to) === '[') {
              const labelFrom = marks[0].to, labelTo = marks[1].from;
              if (labelTo > labelFrom) out.push(linkText.range(labelFrom, labelTo));
              if (!isActive(node.from) && url) {
                out.push(hidden.range(marks[0].from, marks[0].to));
                out.push(hidden.range(marks[1].from, node.to));
                return false;
              }
            }
            for (const mk of marks) out.push(markDim.range(mk.from, mk.to));
            if (url) out.push(Decoration.mark({ class: 'cm-md-url' }).range(url.from, url.to));
            return;
          }
          case 'Image': {
            out.push(Decoration.mark({ class: 'cm-md-image-src' }).range(node.from, node.to));
            return false;
          }
          case 'Table': {
            // Only reached when the raw table is showing (cursor inside): align columns.
            eachLine(node.from, node.to, (lf) => out.push(Decoration.line({ class: 'cm-table-line' }).range(lf)));
            return false;
          }
          case 'HTMLBlock':
          case 'CommentBlock':
            eachLine(node.from, node.to, (lf) => out.push(Decoration.line({ class: 'cm-html-line' }).range(lf)));
            return false;
          case 'Escape':
            if (!isActive(node.from)) out.push(hidden.range(node.from, node.from + 1));
            return;
        }
        return;
      },
    });
  }
  return Decoration.set(out, true);
}

const inlinePreview = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = buildInline(view); }
  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.state) !== syntaxTree(u.startState)
      || u.transactions.some((t) => t.effects.some((e) => e.is(setFocus)))) {
      this.decorations = buildInline(u.view);
    }
  }
}, { decorations: (v) => v.decorations });

// ------------------------------------------------------------------ block layer

function buildBlocks(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  const doc = state.doc;
  const byLine = new Map<number, { line: { from: number; to: number; text: string }; imgs: (Img & { from: number; to: number })[] }>();
  syntaxTree(state).iterate({
    enter: (node) => {
      switch (node.name) {
        case 'Document': case 'BulletList': case 'OrderedList': case 'ListItem': case 'Blockquote': case 'Task': case 'TaskList':
          return;
        case 'Paragraph': case 'ATXHeading1': case 'ATXHeading2': case 'ATXHeading3': case 'ATXHeading4': case 'ATXHeading5': case 'ATXHeading6':
        case 'Link': case 'Emphasis': case 'StrongEmphasis': case 'Strikethrough':
          // Only descend where an image could be.
          return doc.sliceString(node.from, node.to).includes('![') ? undefined : false;
        case 'Table': {
          const from = doc.lineAt(node.from).from, to = doc.lineAt(node.to).to;
          if (!touchesSelection(state, from, to)) {
            out.push(Decoration.replace({ widget: new TableWidget(doc.sliceString(from, to), !state.readOnly), block: true }).range(from, to));
          }
          return false;
        }
        case 'Image': {
          const url = node.node.getChild('URL');
          const marks = node.node.getChildren('LinkMark');
          const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : '';
          const altFrom = marks.length >= 2 ? marks[0].to : node.from, altTo = marks.length >= 2 ? marks[1].from : node.from;
          let src = url ? doc.sliceString(url.from, url.to) : '';
          if (src.startsWith('<') && src.endsWith('>')) src = src.slice(1, -1);
          const line = doc.lineAt(node.from);
          const entry = byLine.get(line.number) ?? { line: { from: line.from, to: line.to, text: line.text }, imgs: [] };
          entry.imgs.push({ src, alt, altFrom, altTo, from: node.from, to: node.to });
          byLine.set(line.number, entry);
          return false;
        }
        default:
          return false;
      }
    },
  });
  for (const { line, imgs } of byLine.values()) {
    const only = imgs.length === 1 && line.text.trim() === doc.sliceString(imgs[0].from, imgs[0].to);
    const images = imgs.map(({ src, alt, altFrom, altTo }) => ({ src, alt, altFrom, altTo }));
    if (only && !touchesSelection(state, line.from, line.to)) {
      out.push(Decoration.replace({ widget: new ImageWidget(images, true), block: true }).range(line.from, line.to));
    } else {
      out.push(Decoration.widget({ widget: new ImageWidget(images, false), block: true, side: 1 }).range(line.to));
    }
  }
  return Decoration.set(out, true);
}

function blocksChanged(tr: Transaction) {
  return tr.docChanged || !!tr.selection || tr.effects.some((e) => e.is(setFocus)) || syntaxTree(tr.state) !== syntaxTree(tr.startState);
}

const blockPreview = StateField.define<DecorationSet>({
  create: (state) => buildBlocks(state),
  update: (value, tr) => (blocksChanged(tr) ? buildBlocks(tr.state) : value),
  provide: (f) => EditorView.decorations.from(f),
});

export const livePreview = [focusField, focusTracker, inlinePreview, blockPreview];
