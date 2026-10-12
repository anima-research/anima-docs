// Tables edited in place. The live preview draws a GFM table as a real table
// while the cursor is outside it; here its cells are editable, and every edit
// rewrites the table's markdown (the source stays the only truth). Tab / Enter
// move between cells and add rows; a small toolbar adds and removes rows and
// columns, sets alignment, or drops into the source.

import { WidgetType, type EditorView } from '@codemirror/view';
import { renderInlineHtml } from '../lib/markdown';

export type Align = '' | 'left' | 'center' | 'right';
export interface TableModel { header: string[]; aligns: Align[]; rows: string[][] }

/** Cells of a table row, with where each starts (pipes inside code spans and escaped pipes don't split). */
export function splitRow(line: string): { text: string; start: number }[] {
  const pipes: number[] = [];
  let ticks = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') { i++; continue; }
    if (c === '`') { let n = 1; while (line[i + n] === '`') n++; ticks = ticks === 0 ? n : ticks === n ? 0 : ticks; i += n - 1; continue; }
    if (c === '|' && ticks === 0) pipes.push(i);
  }
  const bounds = [-1, ...pipes, line.length];
  const cells: { text: string; start: number }[] = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const from = bounds[k] + 1, to = bounds[k + 1];
    const raw = line.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    cells.push({ text: raw.trim(), start: from + lead });
  }
  if (cells.length && !cells[0].text && line.trimStart().startsWith('|')) cells.shift();
  if (cells.length && !cells[cells.length - 1].text && line.trimEnd().endsWith('|')) cells.pop();
  return cells;
}

export function parseTable(source: string): TableModel {
  const lines = source.split('\n');
  const header = splitRow(lines[0] ?? '').map((c) => c.text);
  const aligns: Align[] = splitRow(lines[1] ?? '').map((c) => {
    const t = c.text.replace(/\s/g, '');
    return t.startsWith(':') && t.endsWith(':') ? 'center' : t.endsWith(':') ? 'right' : t.startsWith(':') ? 'left' : '';
  });
  const cols = Math.max(header.length, aligns.length, 1);
  while (header.length < cols) header.push('');
  while (aligns.length < cols) aligns.push('');
  const rows = lines.slice(2).filter((l) => l.trim()).map((l) => { const cells = splitRow(l).map((c) => c.text); while (cells.length < cols) cells.push(''); return cells.slice(0, cols); });
  return { header, aligns, rows };
}

const cellWidth = (s: string) => [...s].length;

/** Markdown for a model: columns padded so the source reads as a table too. */
export function serializeTable(m: TableModel): string {
  const cols = m.header.length;
  const widths = Array.from({ length: cols }, (_, c) => Math.max(3, cellWidth(m.header[c] ?? ''), ...m.rows.map((r) => cellWidth(r[c] ?? ''))));
  const pad = (s: string, c: number) => s + ' '.repeat(Math.max(0, widths[c] - cellWidth(s)));
  const row = (cells: string[]) => `| ${cells.map((s, c) => pad(s ?? '', c)).join(' | ')} |`;
  const sep = `| ${m.aligns.map((a, c) => { const w = widths[c]; return a === 'center' ? `:${'-'.repeat(w - 2)}:` : a === 'right' ? `${'-'.repeat(w - 1)}:` : a === 'left' ? `:${'-'.repeat(w - 1)}` : '-'.repeat(w); }).join(' | ')} |`;
  return [row(m.header), sep, ...m.rows.map(row)].join('\n');
}

const unescapeCell = (s: string) => s.replace(/\\\|/g, '|');
const escapeCell = (s: string) => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();

/** Which cell to focus in the table widget rebuilt after an edit (keyed by the table's position). */
let pendingFocus: { start: number; r: number; c: number; atEnd?: boolean } | null = null;

export class TableWidget extends WidgetType {
  constructor(readonly source: string, readonly editable: boolean) { super(); }
  eq(o: TableWidget) { return o.source === this.source && o.editable === this.editable; }
  get estimatedHeight() { return this.source.split('\n').length * 38; }

  toDOM(view: EditorView) {
    const model = parseTable(this.source);
    const cols = model.header.length;
    const wrap = document.createElement('div');
    wrap.className = `cm-table-widget${this.editable ? ' editable' : ''}`;
    const table = document.createElement('table');
    let current = { r: 0, c: 0 };
    const cellsByPos = new Map<string, HTMLElement>();

    const textOf = (r: number, c: number) => (r === 0 ? model.header[c] : model.rows[r - 1][c]) ?? '';
    const setText = (r: number, c: number, v: string) => { if (r === 0) model.header[c] = v; else model.rows[r - 1][c] = v; };
    const render = (el: HTMLElement, r: number, c: number) => { el.replaceChildren(renderInlineHtml(unescapeCell(textOf(r, c)))); if (!el.textContent) el.innerHTML = '<br>'; };

    const start = () => view.posAtDOM(wrap);
    /** Replace the table's markdown with the model's; focus (r, c) in the widget that replaces this one. */
    const write = (next: TableModel, focus: { r: number; c: number; atEnd?: boolean } | null) => {
      const from = start();
      const src = serializeTable(next);
      if (view.state.doc.sliceString(from, from + this.source.length) !== this.source) { console.warn('[table] source moved; edit dropped'); return false; }
      if (src === this.source) { if (focus) focusCell(focus.r, focus.c, focus.atEnd); return true; }
      pendingFocus = focus ? { start: from, ...focus } : null;
      view.dispatch({ changes: { from, to: from + this.source.length, insert: src }, userEvent: 'input.table' });
      return true;
    };
    /** Edit a cell in a real input (never a nested contenteditable: CodeMirror's own editable surrounds us). */
    let active: { r: number; c: number; input: HTMLInputElement; td: HTMLElement } | null = null;
    const endEdit = (how: 'commit' | 'cancel', focus: { r: number; c: number; atEnd?: boolean } | null) => {
      const a = active;
      if (!a) { if (focus) focusCell(focus.r, focus.c, focus.atEnd); return; }
      active = null;
      wrap.classList.remove('focused');
      if (how === 'cancel') { render(a.td, a.r, a.c); return; }
      const raw = escapeCell(a.input.value);
      if (raw === textOf(a.r, a.c)) { render(a.td, a.r, a.c); if (focus) focusCell(focus.r, focus.c, focus.atEnd); return; }
      setText(a.r, a.c, raw);
      if (!write(model, focus)) render(a.td, a.r, a.c);
    };
    const focusCell = (r: number, c: number, atEnd = false) => {
      const td = cellsByPos.get(`${r},${c}`);
      if (!td || !this.editable) return;
      if (active && active.td === td) { active.input.focus(); return; }
      if (active) endEdit('commit', null);
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'cm-table-input';
      input.value = unescapeCell(textOf(r, c));
      input.setAttribute('aria-label', `Row ${r + 1}, column ${c + 1}`);
      input.style.width = `${Math.max(80, td.clientWidth - 28)}px`;
      td.replaceChildren(input);
      active = { r, c, input, td };
      current = { r, c };
      wrap.classList.add('focused');
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Tab') {
          e.preventDefault();
          const back = e.shiftKey;
          let nr = r, nc = c + (back ? -1 : 1);
          if (nc >= cols) { nc = 0; nr = r + 1; }
          if (nc < 0) { nc = cols - 1; nr = r - 1; }
          if (nr < 0) { endEdit('commit', null); return; }
          if (nr > model.rows.length) { model.rows.push(Array.from({ length: cols }, () => '')); setText(r, c, escapeCell(input.value)); active = null; write(model, { r: nr, c: nc }); return; }
          endEdit('commit', { r: nr, c: nc, atEnd: true });
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const nr = r + 1;
          if (nr > model.rows.length) { model.rows.push(Array.from({ length: cols }, () => '')); setText(r, c, escapeCell(input.value)); active = null; write(model, { r: nr, c }); return; }
          endEdit('commit', { r: nr, c, atEnd: true });
        } else if (e.key === 'Escape') { e.preventDefault(); endEdit('cancel', null); view.focus(); }
      });
      input.addEventListener('blur', () => { if (active && active.input === input) endEdit('commit', null); });
      input.focus();
      if (atEnd) input.setSelectionRange(input.value.length, input.value.length); else input.select();
    };

    const mkCell = (tag: 'th' | 'td', r: number, c: number) => {
      const el = document.createElement(tag);
      if (model.aligns[c]) el.style.textAlign = model.aligns[c];
      el.dataset.r = String(r); el.dataset.c = String(c);
      render(el, r, c);
      cellsByPos.set(`${r},${c}`, el);
      if (!this.editable) return el;
      el.addEventListener('mousedown', (e) => {
        if ((e.target as HTMLElement).closest('a, input')) return;
        e.preventDefault(); e.stopPropagation();
        focusCell(r, c, true);
      });
      return el;
    };

    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    for (let c = 0; c < cols; c++) htr.append(mkCell('th', 0, c));
    thead.append(htr);
    table.append(thead);
    const tbody = document.createElement('tbody');
    model.rows.forEach((_, i) => { const tr = document.createElement('tr'); for (let c = 0; c < cols; c++) tr.append(mkCell('td', i + 1, c)); tbody.append(tr); });
    if (tbody.childElementCount) table.append(tbody);
    wrap.append(table);

    const toSource = (off = 0) => {
      const anchor = Math.min(view.state.doc.length, start() + off);
      view.focus();
      view.dispatch({ selection: { anchor } });
    };

    if (this.editable) {
      // Toolbar: acts on the cell last focused (row 0 is the header).
      const bar = document.createElement('div');
      bar.className = 'cm-table-bar';
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', 'Table');
      const btn = (label: string, title: string, run: () => void) => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = label; b.title = title; b.setAttribute('aria-label', title);
        b.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
        b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
        bar.append(b);
        return b;
      };
      const flushCurrent = () => { if (active) { setText(active.r, active.c, escapeCell(active.input.value)); active = null; } };
      btn('+ row', 'Add a row below', () => { flushCurrent(); const at = Math.max(0, current.r); model.rows.splice(at, 0, Array.from({ length: cols }, () => '')); write(model, { r: at + 1, c: current.c }); });
      btn('+ col', 'Add a column to the right', () => { flushCurrent(); const at = current.c + 1; model.header.splice(at, 0, ''); model.aligns.splice(at, 0, ''); for (const row of model.rows) row.splice(at, 0, ''); write(model, { r: current.r, c: at }); });
      btn('− row', 'Delete this row', () => { if (current.r === 0 || !model.rows.length) return; flushCurrent(); model.rows.splice(current.r - 1, 1); write(model, { r: Math.min(current.r, model.rows.length), c: current.c }); });
      btn('− col', 'Delete this column', () => { if (cols <= 1) return; flushCurrent(); model.header.splice(current.c, 1); model.aligns.splice(current.c, 1); for (const row of model.rows) row.splice(current.c, 1); write(model, { r: current.r, c: Math.min(current.c, cols - 2) }); });
      btn('⇤⇥', 'Column alignment: left, centre, right', () => { flushCurrent(); const order: Align[] = ['', 'left', 'center', 'right']; model.aligns[current.c] = order[(order.indexOf(model.aligns[current.c]) + 1) % order.length]; write(model, { r: current.r, c: current.c }); });
      btn('Source', 'Edit the markdown', () => toSource());
      wrap.append(bar);
    }

    wrap.addEventListener('mousedown', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('a') || target.closest('.cm-table-bar')) return;
      if (this.editable && target.closest('td, th, input')) return; // editing in place
      e.preventDefault();
      const cell = target.closest<HTMLElement>('[data-r]');
      toSource(cell ? this.offsetOf(Number(cell.dataset.r), Number(cell.dataset.c)) : 0);
    });

    // An edit rebuilt the widget: continue in the cell the person was heading for.
    if (this.editable && pendingFocus) {
      const want = pendingFocus;
      requestAnimationFrame(() => {
        if (pendingFocus !== want || !wrap.isConnected) return;
        if (start() !== want.start) return;
        pendingFocus = null;
        focusCell(want.r, want.c, want.atEnd);
      });
    }
    return wrap;
  }

  /** Offset in the source of a cell's text (for placing the cursor in the markdown). */
  private offsetOf(r: number, c: number): number {
    const lines = this.source.split('\n');
    const li = r === 0 ? 0 : r + 1;
    let off = 0;
    for (let i = 0; i < li && i < lines.length; i++) off += lines[i].length + 1;
    const cell = splitRow(lines[li] ?? '')[c];
    return off + (cell ? cell.start : (lines[li]?.length ?? 0));
  }

  ignoreEvent() { return true; }
}
