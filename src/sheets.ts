// Spreadsheets on the server: what agents read (cells with their computed
// values), the changes they make (edit_sheet), and the Excel file.

import ExcelJS from 'exceljs';
import { DetailedCellError } from 'hyperformula';
import * as Y from 'yjs';
import { Fault } from './auth.js';
import type { Documents } from './documents.js';
import {
  MAX_CELLS, MAX_ROWS, SHEET_MAPS, a1, addSheetNamed, colIndex, colName, deleteCols, deleteRows, deleteSheet, grids, input, insertCols, insertRows, liveStore, parseRange,
  quoteSheet, readBook, renameSheet, reorderRows, setBlock, setFormat, type Book, type Rect, type Sheet,
} from './sheet.js';
import { Calc, sortOrder } from './sheetcalc.js';

/** One change of an edit_sheet call (see the tool's description). */
export type SheetEdit = Record<string, unknown>;

const KEEP = 8;
const NO_SHEETS = 'This spreadsheet has no sheets (the last one was removed). edit_sheet {"changes": [{"add_sheet": "Sheet1"}]} adds one.';
/** In a read of many cells, one cell shows at most this much (a single cell read alone shows all of it). */
const CELL_SHOWN = 2_000;
const OPS = ['set', 'append', 'insert_rows', 'delete_rows', 'insert_columns', 'delete_columns', 'sort', 'format', 'add_sheet', 'rename_sheet', 'delete_sheet'];
/** A number format as Excel takes it: a currency sign that is not "$" goes in quotes (unless it already is). */
const excelFormat = (code: string) => code.split('"').map((part, i) => (i % 2 ? part : part.replace(/[^\x00-\x7F]+/g, '"$&"'))).join('"');
const escapeCell = (s: string) => s.replace(/[\\\t\n\r]/g, (ch) => (ch === '\\' ? '\\\\' : ch === '\t' ? '\\t' : ch === '\n' ? '\\n' : '\\r'));
/** What an agent passes for a cell -> what a person would have typed. */
const typed = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export class Sheets {
  /** Calculators of the spreadsheets read last, each good until its document changes. */
  private calcs = new Map<string, Calc>();

  constructor(private docs: Documents) {
    docs.on('update', (e: { docId: string }) => this.drop(e.docId));
    docs.on('meta', (e: { docId: string; kind: string }) => { if (e.kind === 'deleted') this.drop(e.docId); });
    // A calculator reads the document it was built over: it goes when that document is put away.
    docs.on('unloaded', (e: { docId: string }) => this.drop(e.docId));
  }

  private drop(docId: string) {
    this.calcs.get(docId)?.destroy();
    this.calcs.delete(docId);
  }

  book(docId: string): Book { return readBook(liveStore(this.docs.ydoc(docId))); }

  /** The spreadsheet's values as they stand now. */
  calc(docId: string): Calc {
    let c = this.calcs.get(docId);
    if (c) { this.calcs.delete(docId); this.calcs.set(docId, c); return c; }
    c = new Calc(this.book(docId));
    this.calcs.set(docId, c);
    if (this.calcs.size > KEEP) this.drop(this.calcs.keys().next().value!);
    return c;
  }

  close() { for (const id of [...this.calcs.keys()]) this.drop(id); }

  private sheetNamed(book: Book, name: unknown): Sheet {
    if (!book.sheets.length) throw new Fault(409, NO_SHEETS);
    if (name === undefined || name === null || name === '') return book.sheets[0];
    const s = book.byName.get(String(name).toLowerCase());
    if (!s) throw new Fault(404, `No sheet “${name}”. Sheets: ${book.sheets.map((x) => x.name).join(', ')}.`);
    return s;
  }

  /** The rows and columns of each sheet that hold anything. */
  extents(book: Book): Map<string, { rows: number; cols: number }> {
    const g = grids(book);
    return new Map(book.sheets.map((s) => [s.id, { rows: g.get(s.id)!.length, cols: g.get(s.id)!.reduce((n, r) => Math.max(n, r.length), 0) }]));
  }

  // ------------------------------------------------------------------ reading

  /**
   * A spreadsheet as text for an agent: every sheet as far as it is filled, or
   * with `range` one sheet or part of one. Each block has a header line of
   * column letters, then one line per row starting with its number, cells
   * between tabs. Values by default; `formulas` shows what was typed instead.
   * `partial` says the read did not show everything the book holds.
   */
  read(docId: string, opts: { range?: string; formulas?: boolean; maxRows?: number; maxChars?: number } = {}): { text: string; partial: boolean } {
    const calc = this.calc(docId);
    const book = calc.book;
    if (!book.sheets.length) return { text: NO_SHEETS, partial: false };
    const ext = this.extents(book);
    const whole: Rect = { top: 0, left: 0, bottom: -1, right: -1 };
    let parts: { sheet: Sheet; rect: Rect }[] = book.sheets.map((sheet) => ({ sheet, rect: whole }));
    if (opts.range) {
      // A sheet's name first: sheets are called Q1, Jan and Tax, which also read as cells and columns.
      const text = opts.range.trim();
      const named = book.byName.get(text.toLowerCase()) ?? book.byName.get(text.replace(/^'|'$/g, '').replace(/''/g, "'").toLowerCase());
      const parsed = named ? { sheet: named.name, rect: whole } : parseRange(text);
      if (!parsed) throw new Fault(400, `range must be a sheet name or cells like "B2:D40", "B:D" or "Ledger!A1:F90" (got "${opts.range}").`);
      parts = [{ sheet: this.sheetNamed(book, parsed.sheet), rect: parsed.rect }];
    }
    const list = book.sheets.map((s) => { const e = ext.get(s.id)!; return `${s.name} (${e.rows ? `${plural(e.rows, 'row')} × ${plural(e.cols, 'column')} filled` : 'empty'}; ${s.rows.length} × ${s.cols.length} in all)`; }).join(', ');
    const out = [`Sheets: ${list}`, `${opts.formulas ? 'What was typed (formulas as written)' : 'Values (pass formulas: true for what was typed)'}. In each block the first line is the column letters, each row starts with its number, cells are separated by tabs.`];
    let rowsLeft = opts.maxRows ?? 500, charsLeft = opts.maxChars ?? 40_000, cut = false;
    for (const { sheet, rect: asked } of parts) {
      const used = ext.get(sheet.id)!;
      const name = quoteSheet(sheet.name);
      const rect: Rect = { top: asked.top, left: asked.left, bottom: asked.bottom < 0 ? used.rows - 1 : Math.min(asked.bottom, sheet.rows.length - 1), right: asked.right < 0 ? used.cols - 1 : Math.min(asked.right, sheet.cols.length - 1) };
      if (rect.bottom < rect.top || rect.right < rect.left) { out.push(`${name} holds nothing${opts.range ? ' there' : ' yet'}.`); continue; }
      if (rowsLeft <= 0 || charsLeft <= 0) { cut = true; out.push(`${name} is not shown (this read is full): pass range "${name}".`); continue; }
      const alone = rect.top === rect.bottom && rect.left === rect.right;
      const shown = (v: string) => (alone || v.length <= CELL_SHOWN ? v : `${v.slice(0, CELL_SHOWN)}… (${(v.length - CELL_SHOWN).toLocaleString('en')} more characters: read this cell alone)`);
      const lines = [`\t${Array.from({ length: rect.right - rect.left + 1 }, (_, i) => colName(rect.left + i)).join('\t')}`];
      let r = rect.top;
      for (; r <= rect.bottom && rowsLeft > 0 && charsLeft > 0; r++, rowsLeft--) {
        const cells: string[] = [];
        for (let c = rect.left; c <= rect.right; c++) cells.push(escapeCell(shown(opts.formulas ? input(book, sheet, r, c) : calc.shown(sheet, r, c).text)));
        while (cells.length && cells[cells.length - 1] === '') cells.pop();
        const line = `${r + 1}\t${cells.join('\t')}`;
        lines.push(line);
        charsLeft -= line.length + 1;
      }
      out.push(`<<<SHEET ${name}!${a1(rect.top, rect.left)}:${a1(r - 1, rect.right)}\n${lines.join('\n')}\nSHEET>>>`);
      if (r <= rect.bottom) { cut = true; out.push(`Rows ${r + 1}–${rect.bottom + 1} of ${name} are not shown: pass range, e.g. "${name}!A${r + 1}:${colName(rect.right)}${rect.bottom + 1}".`); }
    }
    return { text: out.join('\n'), partial: !!opts.range || cut };
  }

  /** A sheet's values as markdown tables, one per sheet (a published page shows a spreadsheet this way). */
  markdown(docId: string): string {
    const calc = this.calc(docId);
    const book = calc.book;
    const ext = this.extents(book);
    // A cell shows as what it holds: nothing in it is markup.
    const cell = (s: string) => s.replace(/[\\`*_{}[\]()#+\-.!|~$<>&]/g, '\\$&').replace(/\r\n?|\n/g, '<br>');
    const MAX = 2000;
    return book.sheets.map((s) => {
      const e = ext.get(s.id)!;
      const head = book.sheets.length > 1 ? `## ${cell(s.name)}\n\n` : '';
      if (!e.rows) return `${head}*(empty)*`;
      const row = (r: number) => `| ${Array.from({ length: e.cols }, (_, c) => cell(calc.shown(s, r, c).text)).join(' | ')} |`;
      const align = `| ${Array.from({ length: e.cols }, (_, c) => { let nums = 0, filled = 0; for (let r = 1; r < Math.min(e.rows, 50); r++) { const k = calc.shown(s, r, c).kind; if (k !== 'empty') filled++; if (k === 'number') nums++; } return nums * 2 > filled ? '--:' : '---'; }).join(' | ')} |`;
      return `${head}${row(0)}\n${align}\n${Array.from({ length: Math.min(e.rows, MAX) - 1 }, (_, i) => row(i + 1)).join('\n')}${e.rows > MAX ? `\n\n*${(e.rows - MAX).toLocaleString('en')} more rows are not shown here.*` : ''}`;
    }).join('\n\n');
  }

  // ------------------------------------------------------------------ changing

  /**
   * Apply an agent's changes in order, as one edit: all of them or none.
   * They are tried on a copy of the sheet first, so a change that cannot be
   * made (a sheet that is not there, a bad range) leaves the document untouched.
   * Returns a line per change saying what it did, and the edit itself (for the caller's "since you last looked").
   */
  apply(docId: string, actor: { sub: string; via?: 'web' | 'mcpl' | 'http' | 'system' }, edits: SheetEdit[], defaultSheet?: string): { done: string[]; client: number; deleteSet: ReturnType<Documents['editSheet']>['deleteSet'] } {
    if (!Array.isArray(edits) || !edits.length) throw new Fault(400, 'changes must be a non-empty list.');
    const live = this.docs.ydoc(docId);
    const scratch = new Y.Doc();
    try {
      scratch.transact(() => { for (const m of SHEET_MAPS) { const to = scratch.getMap(m); for (const [k, v] of live.getMap(m).entries()) to.set(k, v); } });
      edits.forEach((edit, i) => {
        try { scratch.transact(() => { this.applyOne(scratch, edit, defaultSheet); }); }
        catch (e) { throw new Fault(e instanceof Fault ? e.status : 400, `Change ${i + 1}: ${(e as Error).message} Nothing was changed.`); }
      });
      if (scratch.getMap('cells').size > MAX_CELLS) throw new Fault(413, `A spreadsheet holds at most ${MAX_CELLS.toLocaleString('en')} filled cells. Nothing was changed.`);
    } finally { scratch.destroy(); }
    const done: string[] = [];
    const { client, deleteSet } = this.docs.editSheet(docId, { sub: actor.sub, via: actor.via ?? 'mcpl' }, (doc) => { for (const edit of edits) done.push(this.applyOne(doc, edit, defaultSheet)); });
    return { done, client, deleteSet };
  }

  private applyOne(doc: Y.Doc, edit: SheetEdit, defaultSheet?: string): string {
    if (!edit || typeof edit !== 'object') throw new Error('each change is an object.');
    const ops = OPS.filter((k) => k in edit);
    if (ops.length > 1) throw new Error(`one change does one thing; this one has ${ops.join(' and ')}. Make them separate changes.`);
    const book = readBook(liveStore(doc));
    const named = (edit.sheet ?? defaultSheet) as string | undefined;
    const where = (text: unknown, what: string) => {
      const p = parseRange(String(text ?? ''));
      if (!p) throw new Error(`${what} must be a cell or range like "B2" or "B2:D9" (got ${JSON.stringify(text)}).`);
      return { sheet: this.sheetNamed(book, p.sheet ?? named), rect: p.rect };
    };
    const count = (v: unknown) => { const n = v === undefined ? 1 : Number(v); if (!Number.isInteger(n) || n < 1 || n > MAX_ROWS) throw new Error(`count must be a whole number from 1 to ${MAX_ROWS.toLocaleString('en')}.`); return n; };
    const tag = (s: Sheet) => (book.sheets.length > 1 ? `${quoteSheet(s.name)}!` : '');

    if ('set' in edit) {
      const { sheet, rect } = where(edit.set, 'set');
      const block = 'values' in edit ? edit.values : [[edit.value]];
      if (!Array.isArray(block) || !block.length || !block.every((r) => Array.isArray(r))) throw new Error('values must be a list of rows, each a list of cells: [["Rent", 1200], ["Food", 300]].');
      const rows = (block as unknown[][]).map((r) => r.map(typed));
      setBlock(doc, book, sheet.id, rect.top, rect.left, rows);
      const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
      return `Wrote ${tag(sheet)}${a1(rect.top, rect.left)}${rows.length > 1 || width > 1 ? `:${a1(rect.top + rows.length - 1, rect.left + width - 1)}` : ''}.`;
    }
    if ('append' in edit) {
      const sheet = this.sheetNamed(book, named);
      const block = edit.append;
      if (!Array.isArray(block) || !block.length || !block.every((r) => Array.isArray(r))) throw new Error('append must be a list of rows, each a list of cells.');
      const at = grids(book).get(sheet.id)!.length;
      setBlock(doc, book, sheet.id, at, 0, (block as unknown[][]).map((r) => r.map(typed)));
      return `Appended ${plural(block.length, 'row')} to ${quoteSheet(sheet.name)} at row${block.length === 1 ? '' : 's'} ${at + 1}${block.length === 1 ? '' : `–${at + block.length}`}.`;
    }
    for (const [key, rows] of [['insert_rows', true], ['delete_rows', true], ['insert_columns', false], ['delete_columns', false]] as const) {
      if (!(key in edit)) continue;
      const sheet = this.sheetNamed(book, named);
      let n = count(edit.count);
      const raw = edit[key];
      const at = rows ? Number(raw) - 1 : /^[A-Za-z]{1,3}$/.test(String(raw)) ? colIndex(String(raw)) : NaN;
      const size = rows ? sheet.rows.length : sheet.cols.length;
      const inserting = key.startsWith('insert');
      if (!Number.isInteger(at) || at < 0 || at > (inserting ? size : size - 1)) throw new Error(rows ? `${key} is the row number (1–${size}).` : `${key} is the column letter (A–${colName(size - 1)}).`);
      if (inserting) (rows ? insertRows : insertCols)(doc, sheet, at, n);
      else {
        n = Math.min(n, size - at); // what is there to delete
        if (n >= size) throw new Error(`A sheet keeps at least one ${rows ? 'row' : 'column'}.`);
        (rows ? deleteRows : deleteCols)(doc, book, sheet, at, n);
      }
      const span = rows ? `${at + 1}${n > 1 ? `–${at + n}` : ''}` : `${colName(at)}${n > 1 ? `–${colName(at + n - 1)}` : ''}`;
      return inserting ? `Inserted ${plural(n, rows ? 'row' : 'column')} in ${quoteSheet(sheet.name)}: ${rows ? 'row' : 'column'}${n > 1 ? 's' : ''} ${span} ${n > 1 ? 'are' : 'is'} new and empty.` : `Deleted ${rows ? 'row' : 'column'}${n > 1 ? 's' : ''} ${span} of ${quoteSheet(sheet.name)}.`;
    }
    if ('sort' in edit) {
      const { sheet, rect } = where(edit.sort, 'sort');
      const used = this.extents(book).get(sheet.id)!;
      const bottom = Math.min(rect.bottom < 0 ? used.rows - 1 : rect.bottom, sheet.rows.length - 1);
      if (edit.by !== undefined && !/^[A-Za-z]{1,3}$/.test(String(edit.by))) throw new Error(`by is a column letter such as "C" (got ${JSON.stringify(edit.by)}).`);
      const by = edit.by === undefined ? rect.left : colIndex(String(edit.by));
      if (bottom <= rect.top) return `Nothing to sort in ${tag(sheet)}${String(edit.sort)}.`;
      // Sorting reads values, and the calculator for this document predates this call's earlier changes: build one for now.
      const calc = new Calc(book);
      try { reorderRows(doc, book, sheet, rect.top, sortOrder(calc, sheet, rect.top, bottom, by, edit.descending === true)); } finally { calc.destroy(); }
      return `Sorted rows ${rect.top + 1}–${bottom + 1} of ${quoteSheet(sheet.name)} by column ${colName(by)}${edit.descending === true ? ', largest first' : ''}. Whole rows moved.`;
    }
    if ('format' in edit) {
      const { sheet, rect } = where(edit.format, 'format');
      const code = String(edit.as ?? '');
      if (code.length > 60) throw new Error('as is an Excel number format such as "#,##0.00", "0%" or "yyyy-mm-dd", at most 60 characters.');
      setFormat(doc, sheet, { ...rect, bottom: rect.bottom < 0 ? sheet.rows.length - 1 : rect.bottom, right: rect.right < 0 ? sheet.cols.length - 1 : rect.right }, code);
      return `${tag(sheet)}${String(edit.format).replace(/^.*!/, '')} now shows numbers as ${code || 'they come (automatic)'}.`;
    }
    if ('add_sheet' in edit) {
      const name = String(edit.add_sheet ?? '').trim();
      if (!name) throw new Error('add_sheet is the new sheet’s name.');
      return `Added sheet “${addSheetNamed(doc, book, name).name}”.`;
    }
    if ('rename_sheet' in edit) {
      const sheet = this.sheetNamed(book, edit.rename_sheet || '?');
      const to = String(edit.to ?? '').trim();
      if (!to) throw new Error('to is the new name.');
      return `Renamed sheet “${sheet.name}” to “${renameSheet(doc, book, sheet, to)}”; formulas that name it follow.`;
    }
    if ('delete_sheet' in edit) {
      const sheet = this.sheetNamed(book, edit.delete_sheet || '?');
      deleteSheet(doc, book, sheet);
      return `Deleted sheet “${sheet.name}”.`;
    }
    throw new Error(`not a change I know (${Object.keys(edit).join(', ') || 'empty'}): use set, append, insert_rows, delete_rows, insert_columns, delete_columns, sort, format, add_sheet, rename_sheet or delete_sheet.`);
  }

  // ------------------------------------------------------------------ Excel

  /** The spreadsheet as an .xlsx file: values, formulas (with the results they have now), number formats, column widths. */
  async xlsx(docId: string): Promise<Buffer> {
    const calc = this.calc(docId);
    const book = calc.book;
    const g = grids(book);
    const wb = new ExcelJS.Workbook();
    if (!book.sheets.length) wb.addWorksheet('Sheet1'); // Excel opens no file without a sheet
    for (const s of book.sheets) {
      const ws = wb.addWorksheet(s.name);
      g.get(s.id)!.forEach((row, r) => row.forEach((text, c) => {
        if (text === '') return;
        const v = calc.value(s, r, c);
        const result = v instanceof DetailedCellError ? { error: v.value } : v ?? undefined;
        const cell = ws.getCell(r + 1, c + 1);
        cell.value = (text.startsWith('=') ? { formula: text.slice(1), result } : result ?? text) as ExcelJS.CellValue;
        const code = typeof v === 'number' ? calc.formatFor(s, r, c) : '';
        if (code) cell.numFmt = excelFormat(code);
      }));
      s.cols.forEach((id, c) => {
        const w = Number(book.store.get('widths', `${s.id}:${id}`));
        if (w > 0) ws.getColumn(c + 1).width = Math.round(w / 7.5 * 10) / 10;
        // A column's own format goes with the column, so cells filled in later in Excel show the same way.
        const code = String(book.store.get('fmt', `${s.id}::${id}`) ?? '');
        if (code) ws.getColumn(c + 1).numFmt = excelFormat(code);
      });
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}
