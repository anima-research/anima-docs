// The spreadsheet grid: the page of a document of type 'sheet'.
//
// A bundle of its own (public/sheet.js), fetched when a spreadsheet is first
// opened: it carries the formula engine. It works on the Y.Doc the page
// already holds and must not bring a second copy of Yjs, so everything that
// needs Yjs itself (the undo manager) is handed in by the page.
//
// Only the cells in view exist as elements; the rest of the sheet is empty
// space of the right size. Headers stay in place with position: sticky.

import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { h, rafThrottle } from './lib/dom';
import { icon } from './lib/icons';
import type { MenuItem } from './lib/ui';
import {
  addSheet, a1, colName, deleteCols, deleteRows, deleteSheet, formatOf, input, insertCols, insertRows, liveStore, parseTsv, readBook, renameSheet, reorderRows,
  setBlock, setFormat, shiftFormula, stored, toTsv, MAX_ROWS, type Book, type Rect, type Sheet,
} from '../src/sheet';
import { Calc, FORMATS, sortOrder } from '../src/sheetcalc';

export interface UndoStack { undo(): unknown; redo(): unknown; stopCapturing(): void; destroy(): void }
export interface SheetDeps {
  doc: Y.Doc;
  awareness: Awareness;
  canEdit: boolean;
  /** A Y.UndoManager over these maps, following changes made with this origin (made by the page: it owns Yjs). */
  makeUndo(maps: Y.Map<unknown>[], origin: unknown): UndoStack;
  toast(message: string, opts?: { kind?: 'info' | 'success' | 'error' }): void;
  openMenu(anchor: HTMLElement, items: MenuItem[], opts?: { align?: 'start' | 'end' }): () => void;
  promptDialog(opts: { title: string; label: string; value?: string; confirmLabel?: string; maxLength?: number }): Promise<string | null>;
  confirmDialog(opts: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean>;
  exportUrl: string;
}
export interface SheetView { el: HTMLElement; setCanEdit(canEdit: boolean): void; destroy(): void }

const ROW_H = 25, HEAD_H = 25, GUTTER = 46, COL_W = 104, MIN_W = 32, OVERSCAN = 6;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function sheetView(deps: SheetDeps): SheetView {
  const { doc } = deps;
  let canEdit = deps.canEdit;
  /** The origin of this view's own changes: what the undo stack follows. */
  const LOCAL = { sheet: 'local' };
  const maps = { sheets: doc.getMap('sheets'), names: doc.getMap('names'), rows: doc.getMap('rows'), cols: doc.getMap('cols'), cells: doc.getMap('cells'), fmt: doc.getMap('fmt'), widths: doc.getMap('widths') };
  const undo = deps.makeUndo(Object.values(maps), LOCAL);
  let book: Book = readBook(liveStore(doc));
  let calc: Calc | null = book.sheets.length ? new Calc(book) : null;
  let sheetId = book.sheets[0]?.id ?? '';
  /** Selection: from the anchor cell to the focus cell (the anchor is the active cell). Ids keep it on its cells when rows move. */
  const sel = { aR: 0, aC: 0, fR: 0, fC: 0, aRid: '', aCid: '', fRid: '', fCid: '' };
  let colX: number[] = [0];
  /** The entry being typed: its cell by id, so it lands in the right place if rows move meanwhile. */
  let editing: { rowId: string; colId: string; typed: boolean } | null = null;
  /** What was last copied here: pasting it back keeps formulas (shifted), not just values. */
  let copied: { text: string; inputs: string[][]; top: number; left: number } | null = null;
  let destroyed = false;

  const sheet = (): Sheet => book.byId.get(sheetId) ?? book.sheets[0];
  const rect = (): Rect => ({ top: Math.min(sel.aR, sel.fR), left: Math.min(sel.aC, sel.fC), bottom: Math.max(sel.aR, sel.fR), right: Math.max(sel.aC, sel.fC) });
  const change = (fn: () => void) => {
    if (!canEdit) return;
    try { doc.transact(fn, LOCAL); } catch (e) { deps.toast((e as Error).message, { kind: 'error' }); }
  };

  // ------------------------------------------------------------------ elements

  const nameBox = h('span.sheet-name', { 'aria-label': 'Selected cell' });
  const fx = h('input.sheet-fx', { type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Cell contents', placeholder: '' });
  const formatBtn = h('button.btn.ghost.sm.sheet-format', { type: 'button', 'data-tip': 'Number format' }, 'Automatic');
  const tool = (name: string, label: string, onClick: () => void) => { const b = h('button.icon-btn', { type: 'button', 'aria-label': label, 'data-tip': label, onclick: onClick }, icon(name, 18)); return b; };
  const undoBtn = tool('undo', `Undo (${isMac ? '⌘' : 'Ctrl+'}Z)`, () => { undo.undo(); sink.focus(); });
  const redoBtn = tool('redo', `Redo (${isMac ? '⇧⌘Z' : 'Ctrl+Y'})`, () => { undo.redo(); sink.focus(); });
  const bar = h('div.sheet-bar', null, undoBtn, redoBtn, h('span.sheet-bar-sep'), formatBtn, h('span.sheet-bar-sep'), nameBox, h('span.sheet-fx-mark', { 'aria-hidden': 'true' }, 'fx'), fx,
    h('a.icon-btn', { href: deps.exportUrl, download: '', 'aria-label': 'Download as Excel', 'data-tip': 'Download as Excel (.xlsx)' }, icon('download', 18)));

  const corner = h('div.sheet-corner', { 'data-tip': 'Select all' });
  const colHead = h('div.sheet-colhead', null, corner);
  const rowHead = h('div.sheet-rowhead');
  const cellsEl = h('div.sheet-cells');
  const overlay = h('div.sheet-overlay');
  const rangeEl = h('div.sheet-range');
  const activeEl = h('div.sheet-active');
  const fillEl = h('div.sheet-fill');
  const peersEl = h('div.sheet-peers');
  overlay.append(rangeEl, peersEl, activeEl, fillEl);
  const editor = h('input.sheet-editor', { type: 'text', spellcheck: 'false', autocomplete: 'off', hidden: true, 'aria-label': 'Edit cell' });
  /** Holds the keyboard while a cell is selected: keys, copy and paste arrive here. */
  const sink = h('textarea.sheet-sink', { 'aria-label': 'Spreadsheet', autocapitalize: 'off', spellcheck: 'false', tabindex: '0' });
  const menuAnchor = h('div.sheet-menu-anchor');
  const size = h('div.sheet-size', null, colHead, rowHead, cellsEl, overlay, editor, sink, menuAnchor);
  const scroll = h('div.sheet-scroll', null, size);
  const tabs = h('div.sheet-tabs', { role: 'tablist' });
  const stats = h('span.sheet-stats');
  const moreRows = h('button.btn.ghost.sm.sheet-more-rows', { type: 'button', onclick: () => change(() => { insertRows(doc, sheet(), sheet().rows.length, 100); }) }, '+ 100 rows');
  const foot = h('div.sheet-foot', null, tabs, h('span.sheet-foot-space'), stats, moreRows);
  const el = h('div.sheet-view', null, bar, scroll, foot);

  // ------------------------------------------------------------------ geometry

  function layout() {
    const s = sheet();
    colX = [0];
    if (!s) return;
    for (const id of s.cols) colX.push(colX[colX.length - 1] + Math.max(MIN_W, Number(maps.widths.get(`${s.id}:${id}`)) || COL_W));
    size.style.width = `${GUTTER + colX[colX.length - 1] + 80}px`;
    size.style.height = `${HEAD_H + s.rows.length * ROW_H + 60}px`;
    rowHead.style.height = `${s.rows.length * ROW_H}px`;
  }
  /** The column under x (pixels from the left of column A). */
  function colAt(x: number): number {
    let lo = 0, hi = colX.length - 2;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (colX[mid + 1] <= x) lo = mid + 1; else hi = mid; }
    return clamp(lo, 0, Math.max(0, colX.length - 2));
  }
  function keepSel() {
    const s = sheet();
    if (!s) return;
    const row = (id: string, was: number) => s.rowAt.get(id) ?? clamp(was, 0, s.rows.length - 1);
    const col = (id: string, was: number) => s.colAt.get(id) ?? clamp(was, 0, s.cols.length - 1);
    sel.aR = row(sel.aRid, sel.aR); sel.fR = row(sel.fRid, sel.fR); sel.aC = col(sel.aCid, sel.aC); sel.fC = col(sel.fCid, sel.fC);
    sel.aRid = s.rows[sel.aR] ?? ''; sel.fRid = s.rows[sel.fR] ?? ''; sel.aCid = s.cols[sel.aC] ?? ''; sel.fCid = s.cols[sel.fC] ?? '';
  }
  function select(aR: number, aC: number, fR = aR, fC = aC, reveal = true) {
    const s = sheet();
    if (!s) return;
    sel.aR = clamp(aR, 0, s.rows.length - 1); sel.aC = clamp(aC, 0, s.cols.length - 1);
    sel.fR = clamp(fR, 0, s.rows.length - 1); sel.fC = clamp(fC, 0, s.cols.length - 1);
    sel.aRid = s.rows[sel.aR]; sel.fRid = s.rows[sel.fR]; sel.aCid = s.cols[sel.aC]; sel.fCid = s.cols[sel.fC];
    undo.stopCapturing();
    deps.awareness.setLocalStateField('sheet', { s: s.id, r: sel.aRid, c: sel.aCid });
    if (reveal) revealCell(sel.fR, sel.fC);
    selectionChanged();
  }
  function revealCell(row: number, col: number) {
    const top = row * ROW_H, left = colX[col] ?? 0, right = colX[col + 1] ?? left;
    const viewH = scroll.clientHeight - HEAD_H, viewW = scroll.clientWidth - GUTTER;
    if (top < scroll.scrollTop) scroll.scrollTop = top;
    else if (top + ROW_H > scroll.scrollTop + viewH) scroll.scrollTop = top + ROW_H - viewH;
    if (left < scroll.scrollLeft) scroll.scrollLeft = left;
    else if (right > scroll.scrollLeft + viewW) scroll.scrollLeft = Math.max(left - viewW + (right - left), right - viewW);
  }

  // ------------------------------------------------------------------ painting

  const shownAt = (s: Sheet, r: number, c: number) => (calc ? calc.shown(s, r, c) : { text: stored(book, s, r, c), kind: stored(book, s, r, c) ? 'text' as const : 'empty' as const });

  function paintNow() {
    if (destroyed) return;
    const s = sheet();
    el.classList.toggle('no-sheets', !s);
    if (!s) { cellsEl.replaceChildren(); colHead.replaceChildren(corner); rowHead.replaceChildren(); nameBox.textContent = ''; fx.value = ''; stats.textContent = ''; return; }
    const r0 = clamp(Math.floor(scroll.scrollTop / ROW_H) - OVERSCAN, 0, s.rows.length - 1);
    const r1 = clamp(Math.ceil((scroll.scrollTop + scroll.clientHeight) / ROW_H) + OVERSCAN, 0, s.rows.length - 1);
    const c0 = clamp(colAt(scroll.scrollLeft) - 1, 0, s.cols.length - 1);
    const c1 = clamp(colAt(scroll.scrollLeft + scroll.clientWidth) + 1, 0, s.cols.length - 1);
    const sr = rect();
    const cells = document.createDocumentFragment();
    for (let c = c0; c <= c1; c++) {
      const line = document.createElement('div');
      line.className = 'sheet-vline';
      line.style.cssText = `left:${colX[c + 1] - 1}px;top:${r0 * ROW_H}px;height:${(r1 - r0 + 1) * ROW_H}px`;
      cells.append(line);
    }
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const v = shownAt(s, r, c);
        if (v.kind === 'empty') continue;
        const cell = document.createElement('div');
        cell.className = `sc ${v.kind}`;
        cell.style.cssText = `left:${colX[c]}px;top:${r * ROW_H}px;width:${colX[c + 1] - colX[c] - 1}px`;
        cell.textContent = v.text;
        cell.dataset.at = a1(r, c);
        cells.append(cell);
      }
    }
    cellsEl.replaceChildren(cells);
    const heads = document.createDocumentFragment();
    heads.append(corner);
    for (let c = c0; c <= c1; c++) {
      const hd = document.createElement('div');
      hd.className = `sheet-ch${c >= sr.left && c <= sr.right ? ' on' : ''}`;
      hd.style.cssText = `left:${GUTTER + colX[c]}px;width:${colX[c + 1] - colX[c]}px`;
      hd.textContent = colName(c);
      hd.dataset.col = String(c);
      const grip = document.createElement('span');
      grip.className = 'sheet-grip';
      grip.dataset.col = String(c);
      hd.append(grip);
      heads.append(hd);
    }
    colHead.replaceChildren(heads);
    const rowsFrag = document.createDocumentFragment();
    for (let r = r0; r <= r1; r++) {
      const hd = document.createElement('div');
      hd.className = `sheet-rh${r >= sr.top && r <= sr.bottom ? ' on' : ''}`;
      hd.style.top = `${r * ROW_H}px`;
      hd.textContent = String(r + 1);
      rowsFrag.append(hd);
    }
    rowHead.replaceChildren(rowsFrag);
    paintOverlay();
  }
  const paint = rafThrottle(paintNow);

  function box(node: HTMLElement, r: Rect) {
    node.style.cssText += `;left:${colX[r.left]}px;top:${r.top * ROW_H}px;width:${colX[r.right + 1] - colX[r.left]}px;height:${(r.bottom - r.top + 1) * ROW_H}px`;
  }
  function paintOverlay() {
    const s = sheet();
    if (!s) return;
    const sr = rect();
    const many = sr.top !== sr.bottom || sr.left !== sr.right;
    rangeEl.hidden = !many;
    rangeEl.style.cssText = '';
    if (many) box(rangeEl, sr);
    activeEl.style.cssText = '';
    box(activeEl, { top: sel.aR, bottom: sel.aR, left: sel.aC, right: sel.aC });
    fillEl.hidden = !canEdit || !!editing;
    fillEl.style.cssText = `left:${colX[sr.right + 1] - 4}px;top:${(sr.bottom + 1) * ROW_H - 4}px`;
    const peers = document.createDocumentFragment();
    for (const [client, state] of deps.awareness.getStates() as Map<number, { sheet?: { s: string; r: string; c: string }; user?: { name?: string; color?: string } }>) {
      if (client === doc.clientID || state.sheet?.s !== s.id) continue;
      const r = s.rowAt.get(state.sheet.r), c = s.colAt.get(state.sheet.c);
      if (r === undefined || c === undefined) continue;
      const p = document.createElement('div');
      p.className = 'sheet-peer';
      p.style.cssText = `border-color:${state.user?.color ?? '#888'}`;
      box(p, { top: r, bottom: r, left: c, right: c });
      const tag = document.createElement('span');
      tag.textContent = state.user?.name ?? '';
      tag.style.background = state.user?.color ?? '#888';
      p.append(tag);
      peers.append(p);
    }
    peersEl.replaceChildren(peers);
  }

  function selectionChanged() {
    const s = sheet();
    if (!s) return;
    const sr = rect();
    nameBox.textContent = sr.top === sr.bottom && sr.left === sr.right ? a1(sel.aR, sel.aC) : `${a1(sr.top, sr.left)}:${a1(sr.bottom, sr.right)}`;
    if (!editing && document.activeElement !== fx) fx.value = input(book, s, sel.aR, sel.aC);
    const code = formatOf(book, s, sel.aR, sel.aC);
    formatBtn.textContent = FORMATS.find((f) => f.code === code)?.label ?? code;
    // What the selected numbers come to (skipped for very large selections).
    let text = '';
    const n = (sr.bottom - sr.top + 1) * (sr.right - sr.left + 1);
    if (calc && n > 1 && n <= 50_000) {
      let sum = 0, count = 0;
      for (let r = sr.top; r <= sr.bottom; r++) for (let c = sr.left; c <= sr.right; c++) { const v = calc.value(s, r, c); if (typeof v === 'number') { sum += v; count++; } }
      if (count > 1) { const f = (x: number) => String(Number(x.toPrecision(12))); text = `Sum ${f(sum)} · Average ${f(sum / count)} · Count ${count}`; }
    }
    stats.textContent = text;
    sink.style.left = `${GUTTER + (colX[sel.aC] ?? 0)}px`;
    sink.style.top = `${HEAD_H + sel.aR * ROW_H}px`;
    paint();
  }

  function paintTabs() {
    const add = canEdit ? [h('button.icon-btn.sheet-add', { type: 'button', 'aria-label': 'Add a sheet', 'data-tip': 'Add a sheet', onclick: () => {
      let n = book.sheets.length + 1;
      while (book.byName.has(`sheet${n}`)) n++;
      let made = '';
      change(() => { made = addSheet(doc, book, `Sheet${n}`); });
      if (made) showSheet(made);
    } }, icon('plus', 16))] : [];
    tabs.replaceChildren(...book.sheets.map((s) => h('button.sheet-tab', {
      type: 'button', role: 'tab', class: s.id === sheetId ? 'on' : '', 'aria-selected': String(s.id === sheetId), 'data-sheet': s.id,
      onclick: () => showSheet(s.id), ondblclick: () => void renameTab(s.id),
      oncontextmenu: (e: MouseEvent) => { e.preventDefault(); tabMenu(s.id, e.currentTarget as HTMLElement); },
    }, s.name)), ...add);
  }
  function showSheet(id: string) {
    commitEdit();
    sheetId = id;
    sel.aRid = sel.aCid = sel.fRid = sel.fCid = '';
    layout();
    scroll.scrollTop = 0; scroll.scrollLeft = 0;
    select(0, 0);
    paintTabs();
    sink.focus();
  }
  async function renameTab(id: string) {
    const s = book.byId.get(id);
    if (!s || !canEdit) return;
    const name = await deps.promptDialog({ title: 'Rename sheet', label: 'Name', value: s.name, confirmLabel: 'Rename', maxLength: 31 });
    if (name && name.trim() && name.trim() !== s.name) change(() => { const now = book.byId.get(id); if (now) renameSheet(doc, book, now, name); });
  }
  function tabMenu(id: string, anchor: HTMLElement) {
    if (!canEdit) return;
    deps.openMenu(anchor, [
      { label: 'Rename…', icon: 'pencil', onSelect: () => void renameTab(id) },
      { label: 'Delete sheet', icon: 'trash', danger: true, disabled: book.sheets.length <= 1, onSelect: () => {
        const s = book.byId.get(id);
        if (!s) return;
        void deps.confirmDialog({ title: `Delete “${s.name}”?`, message: 'The sheet and everything in it goes. Formulas on other sheets that point into it will read #REF!. History keeps it: it can be restored.', confirmLabel: 'Delete', danger: true })
          .then((ok) => { if (ok) change(() => { const now = book.byId.get(id); if (now) deleteSheet(doc, book, now); }); });
      } },
    ]);
  }

  // ------------------------------------------------------------------ following the document

  function onTransaction(txn: Y.Transaction) {
    if (destroyed) return;
    const changed = (m: Y.Map<unknown>) => txn.changed.get(m as unknown as Y.AbstractType<Y.YEvent<any>>);
    const shape = changed(maps.sheets) || changed(maps.names) || changed(maps.rows) || changed(maps.cols);
    const cells = changed(maps.cells);
    if (!shape && !cells && !changed(maps.fmt) && !changed(maps.widths)) return;
    if (shape || !calc) {
      book = readBook(liveStore(doc));
      if (!book.byId.has(sheetId)) sheetId = book.sheets[0]?.id ?? '';
      if (book.sheets.length) { if (calc) calc.rebuild(book); else calc = new Calc(book); }
      layout();
      keepSel();
      paintTabs();
    } else if (cells) {
      const list: { sheet: Sheet; row: number; col: number }[] = [];
      for (const key of cells) {
        if (key === null) continue;
        const [sid, rid, cid] = key.split(':');
        const s = book.byId.get(sid);
        const row = s?.rowAt.get(rid), col = s?.colAt.get(cid);
        if (s && row !== undefined && col !== undefined) list.push({ sheet: s, row, col });
      }
      calc.update(book, list);
    }
    if (changed(maps.widths)) layout();
    placeEditor();
    if (sheet()) selectionChanged(); else { if (editing) endEdit(false); paint(); }
  }
  doc.on('afterTransaction', onTransaction);
  const onAwareness = () => paintOverlay();
  deps.awareness.on('change', onAwareness);

  // ------------------------------------------------------------------ editing a cell

  function startEdit(text: string | null, typed: boolean) {
    const s = sheet();
    if (!canEdit || !s) return;
    editing = { rowId: sel.aRid, colId: sel.aCid, typed };
    editor.value = text ?? input(book, s, sel.aR, sel.aC);
    fx.value = editor.value;
    revealCell(sel.aR, sel.aC);
    editor.hidden = false;
    placeEditor();
    editor.focus();
    if (text === null) editor.setSelectionRange(editor.value.length, editor.value.length);
    paintOverlay();
  }
  /** Where the cell being typed into is now (null: its row or column is gone). */
  const editingAt = () => { const s = sheet(), r = editing && s?.rowAt.get(editing.rowId), c = editing && s?.colAt.get(editing.colId); return typeof r === 'number' && typeof c === 'number' ? { row: r, col: c } : null; };
  function placeEditor() {
    const at = editingAt();
    if (!at || editor.hidden) return;
    editor.style.left = `${GUTTER + colX[at.col]}px`;
    editor.style.top = `${HEAD_H + at.row * ROW_H}px`;
    editor.style.width = `${Math.max(colX[at.col + 1] - colX[at.col], Math.min(600, editor.value.length * 7.6 + 18)) + 1}px`;
  }
  const fitEditor = placeEditor;
  function endEdit(save: boolean, value = editor.value) {
    if (!editing) return;
    const at = editingAt();
    editing = null;
    editor.hidden = true;
    const s = sheet();
    if (save && !at && value !== '') deps.toast('The cell you were typing in was removed by someone else; your entry was not kept.', { kind: 'info' });
    else if (save && s && at && value !== input(book, s, at.row, at.col)) change(() => { setBlock(doc, book, s.id, at.row, at.col, [[value]]); });
    selectionChanged();
  }
  /** Finish the entry in hand, from wherever it was typed: the cell's own editor, or the formula bar. */
  const commitEdit = () => endEdit(true, editor.hidden ? fx.value : editor.value);
  editor.addEventListener('input', () => { fx.value = editor.value; fitEditor(); });
  editor.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const step = (dr: number, dc: number) => { e.preventDefault(); commitEdit(); select(sel.aR + dr, sel.aC + dc); sink.focus(); };
    if (e.key === 'Enter') step(e.shiftKey ? -1 : 1, 0);
    else if (e.key === 'Tab') step(0, e.shiftKey ? -1 : 1);
    else if (e.key === 'Escape') { e.preventDefault(); endEdit(false); sink.focus(); }
    // Typed straight over a cell: the arrows finish the entry, as in any spreadsheet. Opened to edit: they move the caret.
    else if (editing?.typed && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) step(e.key === 'ArrowDown' ? 1 : -1, 0);
  });
  editor.addEventListener('blur', () => { if (editing && document.activeElement !== fx) commitEdit(); });
  // The formula bar edits the active cell too.
  fx.addEventListener('focus', () => { if (!canEdit) fx.blur(); else if (!editing) editing = { rowId: sel.aRid, colId: sel.aCid, typed: false }; });
  fx.addEventListener('input', () => { if (!editor.hidden) editor.value = fx.value; });
  fx.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); endEdit(true, fx.value); select(sel.aR + 1, sel.aC); sink.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); endEdit(false); sink.focus(); }
  });
  fx.addEventListener('blur', () => { if (editing && document.activeElement !== editor) endEdit(true, fx.value); });

  // ------------------------------------------------------------------ keys

  /** Ctrl+arrow: to the edge of the block of filled cells, or the next filled cell, or the end of the sheet. */
  function jump(r: number, c: number, dr: number, dc: number): [number, number] {
    const s = sheet();
    const filled = (rr: number, cc: number) => maps.cells.get(`${s.id}:${s.rows[rr]}:${s.cols[cc]}`) !== undefined;
    const inside = (rr: number, cc: number) => rr >= 0 && cc >= 0 && rr < s.rows.length && cc < s.cols.length;
    if (!inside(r + dr, c + dc)) return [r, c];
    const along = filled(r, c) && filled(r + dr, c + dc);
    for (;;) {
      const nr = r + dr, nc = c + dc;
      if (!inside(nr, nc)) break;
      if (along && !filled(nr, nc)) break;
      r = nr; c = nc;
      if (!along && filled(r, c)) break;
    }
    return [r, c];
  }
  function move(dr: number, dc: number, extend: boolean, far: boolean) {
    // Extending moves the far corner of the selection; otherwise the active cell moves.
    const [fromR, fromC] = extend ? [sel.fR, sel.fC] : [sel.aR, sel.aC];
    const [r, c] = far ? jump(fromR, fromC, dr, dc) : [fromR + dr, fromC + dc];
    if (extend) select(sel.aR, sel.aC, r, c); else select(r, c);
  }
  function clearSelection() {
    const s = sheet(), sr = rect();
    change(() => { for (let r = sr.top; r <= sr.bottom; r++) for (let c = sr.left; c <= sr.right; c++) { const key = `${s.id}:${s.rows[r]}:${s.cols[c]}`; if (maps.cells.has(key)) maps.cells.delete(key); } });
  }
  /** Fill `target` from the cells of `source`, repeating them, with formulas shifted to where they land. */
  function fill(source: Rect, target: Rect) {
    const s = sheet();
    const h0 = source.bottom - source.top + 1, w0 = source.right - source.left + 1;
    const block: string[][] = [];
    for (let r = target.top; r <= target.bottom; r++) {
      const line: string[] = [];
      for (let c = target.left; c <= target.right; c++) {
        const sr = source.top + ((r - target.top) % h0), sc = source.left + ((c - target.left) % w0);
        line.push(shiftFormula(input(book, s, sr, sc), r - sr, c - sc));
      }
      block.push(line);
    }
    change(() => { setBlock(doc, book, s.id, target.top, target.left, block); });
  }
  function onKey(e: KeyboardEvent) {
    if (e.isComposing || !sheet()) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const far = mod, k = e.key;
    const done = () => e.preventDefault();
    if (k === 'ArrowDown') { done(); move(1, 0, e.shiftKey, far); }
    else if (k === 'ArrowUp') { done(); move(-1, 0, e.shiftKey, far); }
    else if (k === 'ArrowLeft') { done(); move(0, -1, e.shiftKey, far); }
    else if (k === 'ArrowRight') { done(); move(0, 1, e.shiftKey, far); }
    else if (k === 'Tab') { done(); select(sel.aR, sel.aC + (e.shiftKey ? -1 : 1)); }
    else if (k === 'Enter') { done(); select(sel.aR + (e.shiftKey ? -1 : 1), sel.aC); }
    else if (k === 'PageDown' || k === 'PageUp') { done(); const page = Math.max(1, Math.floor((scroll.clientHeight - HEAD_H) / ROW_H) - 1); move(k === 'PageDown' ? page : -page, 0, e.shiftKey, false); }
    else if (k === 'Home') { done(); select(mod ? 0 : sel.aR, 0); }
    else if (k === 'F2') { done(); startEdit(null, false); }
    else if (k === 'Delete' || k === 'Backspace') { done(); clearSelection(); }
    else if (mod && (k === 'z' || k === 'Z')) { done(); if (e.shiftKey) undo.redo(); else undo.undo(); }
    else if (mod && (k === 'y' || k === 'Y')) { done(); undo.redo(); }
    else if (mod && (k === 'a' || k === 'A')) { done(); select(0, 0, sheet().rows.length - 1, sheet().cols.length - 1, false); }
    else if (mod && (k === 'd' || k === 'D')) { done(); const sr = rect(); if (sr.bottom > sr.top) fill({ ...sr, bottom: sr.top }, { ...sr, top: sr.top + 1 }); }
    // Anything that types a character starts an entry; the character itself lands in the editor, which now has the keyboard.
    else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && canEdit) startEdit('', true);
  }
  sink.addEventListener('keydown', onKey);
  // With nothing else holding the keyboard (a dialog just closed, a click landed on empty page), keys are for the grid.
  const onDocKey = (e: KeyboardEvent) => {
    if (document.activeElement !== document.body || !el.isConnected || el.offsetParent === null || document.querySelector('dialog[open]:not(.closing), .menu')) return;
    sink.focus({ preventScroll: true });
    onKey(e);
  };
  document.addEventListener('keydown', onDocKey);
  sink.addEventListener('compositionstart', () => { if (!editing && canEdit) startEdit('', true); });

  // ------------------------------------------------------------------ copy and paste

  function onCopy(e: ClipboardEvent, cut: boolean) {
    const s = sheet();
    if (!s || !e.clipboardData) return;
    const sr = rect();
    const shown: string[][] = [], inputs: string[][] = [];
    for (let r = sr.top; r <= sr.bottom; r++) {
      const a: string[] = [], b: string[] = [];
      for (let c = sr.left; c <= sr.right; c++) { a.push(shownAt(s, r, c).text); b.push(input(book, s, r, c)); }
      shown.push(a); inputs.push(b);
    }
    const text = toTsv(shown);
    copied = { text, inputs, top: sr.top, left: sr.left };
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
    if (cut) clearSelection();
  }
  sink.addEventListener('copy', (e) => onCopy(e, false));
  sink.addEventListener('cut', (e) => onCopy(e, true));
  sink.addEventListener('paste', (e) => {
    e.preventDefault();
    const s = sheet();
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!canEdit || !s || text === '') return;
    const sr = rect();
    // Copied here: the cells as typed, their formulas moved with them. From elsewhere: the text, as rows and cells.
    const same = copied && copied.text === text.replace(/\r\n/g, '\n').replace(/\n$/, '') ? copied : null;
    let block = same ? same.inputs.map((line) => line.map((v) => shiftFormula(v, sr.top - same.top, sr.left - same.left))) : parseTsv(text);
    const rows = block.length, cols = block.reduce((n, r) => Math.max(n, r.length), 0);
    // One copied cell (or a block that fits a whole number of times) fills the selection.
    const selRows = sr.bottom - sr.top + 1, selCols = sr.right - sr.left + 1;
    if ((selRows > rows || selCols > cols) && selRows % rows === 0 && selCols % cols === 0) {
      const src = same ? same.inputs : block;
      block = Array.from({ length: selRows }, (_, i) => Array.from({ length: selCols }, (_, j) => {
        const v = src[i % rows][j % cols] ?? '';
        return same ? shiftFormula(v, sr.top + i - (same.top + (i % rows)), sr.left + j - (same.left + (j % cols))) : v;
      }));
    }
    if (sr.top + block.length > MAX_ROWS) { deps.toast('That is more rows than a sheet holds.', { kind: 'error' }); return; }
    change(() => { setBlock(doc, book, s.id, sr.top, sr.left, block); });
    select(sr.top, sr.left, sr.top + block.length - 1, sr.left + Math.max(1, block.reduce((n, r) => Math.max(n, r.length), 0)) - 1, false);
  });

  // ------------------------------------------------------------------ pointer

  const at = (e: MouseEvent) => {
    const b = scroll.getBoundingClientRect();
    const x = e.clientX - b.left, y = e.clientY - b.top;
    const s = sheet();
    return { inCols: y < HEAD_H, inRows: x < GUTTER, row: clamp(Math.floor((y + scroll.scrollTop - HEAD_H) / ROW_H), 0, Math.max(0, s.rows.length - 1)), col: colAt(x + scroll.scrollLeft - GUTTER) };
  };
  let drag: null | { kind: 'cells' | 'rows' | 'cols' | 'fill'; from: Rect } | { kind: 'resize'; col: number; startX: number; startW: number } = null;
  scroll.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !sheet()) return;
    const t = e.target as HTMLElement;
    if (t === editor || t === fx) return;
    const p = at(e);
    if (editing) commitEdit();
    const lastRow = sheet().rows.length - 1, lastCol = sheet().cols.length - 1;
    if (t.classList.contains('sheet-grip') && canEdit) {
      const col = Number(t.dataset.col);
      drag = { kind: 'resize', col, startX: e.clientX, startW: colX[col + 1] - colX[col] };
    } else if (t === fillEl && canEdit) {
      drag = { kind: 'fill', from: rect() };
    } else if (t === corner || (p.inCols && p.inRows)) {
      select(0, 0, lastRow, lastCol, false);
    } else if (p.inCols) {
      if (e.shiftKey) select(0, sel.aC, lastRow, p.col, false); else select(0, p.col, lastRow, p.col, false);
      drag = { kind: 'cols', from: rect() };
    } else if (p.inRows) {
      if (e.shiftKey) select(sel.aR, 0, p.row, lastCol, false); else select(p.row, 0, p.row, lastCol, false);
      drag = { kind: 'rows', from: rect() };
    } else {
      if (e.shiftKey) select(sel.aR, sel.aC, p.row, p.col); else select(p.row, p.col);
      drag = { kind: 'cells', from: rect() };
    }
    scroll.setPointerCapture(e.pointerId);
    e.preventDefault();
    sink.focus({ preventScroll: true });
  });
  scroll.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.kind === 'resize') {
      const w = Math.max(MIN_W, drag.startW + e.clientX - drag.startX);
      const delta = w - (colX[drag.col + 1] - colX[drag.col]);
      for (let c = drag.col + 1; c < colX.length; c++) colX[c] += delta; // shown now, stored when the drag ends
      paint();
      return;
    }
    const p = at(e);
    const lastRow = sheet().rows.length - 1, lastCol = sheet().cols.length - 1;
    if (drag.kind === 'cells') select(sel.aR, sel.aC, p.row, p.col);
    else if (drag.kind === 'cols') select(0, sel.aC, lastRow, p.col, false);
    else if (drag.kind === 'rows') select(sel.aR, 0, p.row, lastCol, false);
    else {
      // Dragging the corner handle: the selection grows down or to the right, whichever the pointer went further.
      const f = drag.from;
      const down = p.row - f.bottom, right = p.col - f.right;
      if (down > 0 && down * ROW_H >= (right > 0 ? colX[p.col] - colX[f.right] : 0)) select(f.top, f.left, p.row, f.right);
      else if (right > 0) select(f.top, f.left, f.bottom, p.col);
      else select(f.top, f.left, f.bottom, f.right, false);
    }
  });
  const endDrag = (e: PointerEvent) => {
    const d = drag;
    drag = null;
    if (!d) return;
    try { scroll.releasePointerCapture(e.pointerId); } catch { /* not held */ }
    const s = sheet();
    if (d.kind === 'resize') {
      const w = Math.round(colX[d.col + 1] - colX[d.col]);
      change(() => { maps.widths.set(`${s.id}:${s.cols[d.col]}`, w); });
      layout(); paint();
    } else if (d.kind === 'fill') {
      const to = rect(), f = d.from;
      if (to.bottom > f.bottom) fill(f, { ...f, top: f.bottom + 1, bottom: to.bottom });
      else if (to.right > f.right) fill(f, { ...f, left: f.right + 1, right: to.right });
    }
  };
  scroll.addEventListener('pointerup', endDrag);
  scroll.addEventListener('pointercancel', endDrag);
  scroll.addEventListener('dblclick', (e) => { const p = at(e); if (!p.inCols && !p.inRows && e.target !== editor) startEdit(null, false); });
  scroll.addEventListener('scroll', paint, { passive: true });

  // ------------------------------------------------------------------ menus

  function sortBy(col: number, descending: boolean) {
    const s = sheet(), sr = rect();
    if (!calc) return;
    // Several rows selected (not whole columns): those rows. Otherwise the block of rows below row 1 (which stays as the
    // headings), down to the first empty row: a total kept under a gap is not sorted into the data.
    const some = sr.bottom > sr.top && !(sr.top === 0 && sr.bottom === s.rows.length - 1);
    const top = some ? sr.top : 1;
    let bottom = some ? sr.bottom : 0;
    if (!some) {
      const filled = new Set<number>();
      for (const key of maps.cells.keys()) { const p = key.split(':'); if (p[0] === s.id) { const r = s.rowAt.get(p[1]); if (r !== undefined) filled.add(r); } }
      while (filled.has(bottom + 1)) bottom++;
    }
    if (bottom <= top) return;
    const order = sortOrder(calc, s, top, bottom, col, descending);
    change(() => { reorderRows(doc, book, s, top, order); });
  }
  scroll.addEventListener('contextmenu', (e) => {
    const s = sheet();
    if (!s || e.target === editor) return;
    e.preventDefault();
    const p = at(e);
    const sr0 = rect();
    if (p.inCols && !(p.col >= sr0.left && p.col <= sr0.right && sr0.top === 0 && sr0.bottom === s.rows.length - 1)) select(0, p.col, s.rows.length - 1, p.col, false);
    else if (p.inRows && !(p.row >= sr0.top && p.row <= sr0.bottom && sr0.left === 0 && sr0.right === s.cols.length - 1)) select(p.row, 0, p.row, s.cols.length - 1, false);
    else if (!p.inCols && !p.inRows && !(p.row >= sr0.top && p.row <= sr0.bottom && p.col >= sr0.left && p.col <= sr0.right)) select(p.row, p.col);
    if (!canEdit) return;
    const sr = rect();
    const nRows = sr.bottom - sr.top + 1, nCols = sr.right - sr.left + 1;
    const rowsLabel = nRows === 1 ? `row ${sr.top + 1}` : `rows ${sr.top + 1}–${sr.bottom + 1}`;
    const colsLabel = nCols === 1 ? `column ${colName(sr.left)}` : `columns ${colName(sr.left)}–${colName(sr.right)}`;
    const wholeCols = sr.top === 0 && sr.bottom === s.rows.length - 1, wholeRows = sr.left === 0 && sr.right === s.cols.length - 1;
    const rowItems: MenuItem[] = [
      { label: `Insert ${nRows === 1 ? 'a row' : `${nRows} rows`} above`, onSelect: () => change(() => { insertRows(doc, s, sr.top, nRows); }) },
      { label: `Insert ${nRows === 1 ? 'a row' : `${nRows} rows`} below`, onSelect: () => change(() => { insertRows(doc, s, sr.bottom + 1, nRows); }) },
      { label: `Delete ${rowsLabel}`, danger: true, disabled: nRows >= s.rows.length, onSelect: () => change(() => { deleteRows(doc, book, s, sr.top, nRows); }) },
    ];
    const colItems: MenuItem[] = [
      { label: `Insert ${nCols === 1 ? 'a column' : `${nCols} columns`} left`, onSelect: () => change(() => { insertCols(doc, s, sr.left, nCols); }) },
      { label: `Insert ${nCols === 1 ? 'a column' : `${nCols} columns`} right`, onSelect: () => change(() => { insertCols(doc, s, sr.right + 1, nCols); }) },
      { label: `Delete ${colsLabel}`, danger: true, disabled: nCols >= s.cols.length, onSelect: () => change(() => { deleteCols(doc, book, s, sr.left, nCols); }) },
    ];
    const sortItems: MenuItem[] = [
      { label: `Sort by column ${colName(p.col)}, A → Z`, hint: nRows > 1 && !wholeCols ? 'the selected rows' : 'rows below row 1', onSelect: () => sortBy(p.col, false) },
      { label: `Sort by column ${colName(p.col)}, Z → A`, hint: nRows > 1 && !wholeCols ? 'the selected rows' : 'rows below row 1', onSelect: () => sortBy(p.col, true) },
    ];
    const items: MenuItem[] = wholeCols && !wholeRows ? [...colItems, 'separator', ...sortItems] : wholeRows && !wholeCols ? rowItems : [...rowItems, 'separator', ...colItems, 'separator', ...sortItems];
    items.push('separator', { label: 'Clear contents', onSelect: clearSelection });
    const b = scroll.getBoundingClientRect();
    menuAnchor.style.left = `${e.clientX - b.left + scroll.scrollLeft}px`;
    menuAnchor.style.top = `${e.clientY - b.top + scroll.scrollTop}px`;
    deps.openMenu(menuAnchor, items);
  });
  formatBtn.addEventListener('click', () => {
    if (!canEdit) return;
    // The sheet and the selection as they are when the menu opens: what the person is looking at when choosing.
    const s = sheet(), where = rect(), current = formatOf(book, s, sel.aR, sel.aC);
    deps.openMenu(formatBtn, FORMATS.map((f) => ({ label: f.label, hint: f.sample, checked: f.code === current, onSelect: () => { change(() => { setFormat(doc, s, where, f.code); }); sink.focus(); } })));
  });

  // ------------------------------------------------------------------ life

  const resize = new ResizeObserver(() => paint());
  resize.observe(scroll);
  function applyCanEdit() {
    el.classList.toggle('read-only', !canEdit);
    fx.readOnly = !canEdit;
    undoBtn.hidden = redoBtn.hidden = moreRows.hidden = !canEdit;
    formatBtn.disabled = !canEdit;
    paintTabs();
    paintOverlay();
  }
  layout();
  applyCanEdit();
  if (book.sheets.length) select(0, 0, 0, 0, false);
  requestAnimationFrame(() => { if (!destroyed) { paintNow(); sink.focus({ preventScroll: true }); } });

  return {
    el,
    setCanEdit(next) { if (next === canEdit) return; canEdit = next; if (!next && editing) endEdit(false); applyCanEdit(); },
    destroy() {
      destroyed = true;
      doc.off('afterTransaction', onTransaction);
      document.removeEventListener('keydown', onDocKey);
      deps.awareness.off('change', onAwareness);
      resize.disconnect();
      undo.destroy();
      calc?.destroy();
      deps.awareness.setLocalStateField('sheet', null);
    },
  };
}
