// Spreadsheets: the content of a document of type 'sheet'.
//
// A sheet is stored cell by cell, so that people working in one sheet at the
// same moment merge the way a spreadsheet should: two writes to one cell leave
// one of them (never a mixture), and a row inserted by one person does not
// disturb what another is typing below it.
//
// The Y.Doc holds eight root maps of plain strings and numbers, nothing nested:
//
//   sheets  <sheet>                -> order key        (the sheet exists)
//   names   <sheet>                -> its name
//   rows    <sheet>:<row>          -> order key        (the row exists)
//   cols    <sheet>:<col>          -> order key
//   cells   <sheet>:<row>:<col>    -> what was typed   (a formula starts with "=")
//   fmt     <sheet>:<row>:<col>    -> number format    (<sheet>::<col> for a whole column)
//   widths  <sheet>:<col>          -> column width, px
//   charts  <sheet>:<chart>        -> a chart placed on the sheet (JSON: its settings, its range, where it sits)
//
// Rows, columns and sheets have ids; their place is an order key (fractional
// indexing), so moving one is a single write and two people inserting at the
// same place both keep their rows.
//
// Formulas are stored with their references as ids, not addresses:
// "=SUM(C2:C9)" is kept as "=SUM(⟦r1.c3⟧:⟦r8.c3⟧)". A reference therefore
// follows its cell when rows are inserted or removed, with nothing to rewrite,
// and it stays right when that happens while someone else is editing the
// formula. (Removing the end of a range, and sorting, do write formulas: see
// deleteLines and reorderRows.) Addresses exist only at the edges: what a person or an agent
// reads and types, what the formula engine is given, what goes into Excel.
//
// This module runs in the server and in the browser; it imports nothing that
// runs (the Y.Doc it works on comes from its caller).

import type * as Y from 'yjs';
import { generateNKeysBetween } from 'fractional-indexing';

/** The type of a document that is a spreadsheet. */
export const SHEET = 'sheet';
export const SHEET_MAPS = ['sheets', 'names', 'rows', 'cols', 'cells', 'fmt', 'widths', 'charts'] as const;
export type SheetMap = typeof SHEET_MAPS[number];

export const MAX_ROWS = 100_000;
export const MAX_COLS = 1_000;
export const MAX_SHEETS = 50;
/** Excel's limit for the text of one cell. */
export const MAX_CELL_CHARS = 32_767;
/** Filled cells in one spreadsheet, all sheets together. */
export const MAX_CELLS = 1_000_000;
export const NEW_ROWS = 100;
export const NEW_COLS = 26;

/** Where a book is read from: the live document, or the document as it was at a snapshot. */
export interface Store {
  get(map: SheetMap, key: string): unknown;
  entries(map: SheetMap): Iterable<[string, unknown]>;
}
export const liveStore = (doc: Y.Doc): Store => ({
  get: (m, k) => doc.getMap(m).get(k),
  entries: (m) => doc.getMap(m).entries() as Iterable<[string, unknown]>,
});

export interface Sheet {
  id: string;
  name: string;
  /** Row ids in order, and each one's order key. */
  rows: string[]; rowKeys: string[];
  cols: string[]; colKeys: string[];
  rowAt: Map<string, number>;
  colAt: Map<string, number>;
}
export interface Book {
  store: Store;
  sheets: Sheet[];
  byId: Map<string, Sheet>;
  /** By name, lower case (names are matched the way Excel matches them). */
  byName: Map<string, Sheet>;
}

/** A sheet name people can use in formulas and Excel accepts: no \ / ? * [ ] :, no apostrophe at either end, at most 31 characters. */
export const validName = (name: string) => name.replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^'+|'+$/g, '').trim().slice(0, 31).trim() || 'Sheet';

type Keyed = { id: string; key: string };
const inOrder = (a: Keyed, b: Keyed) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function readBook(store: Store): Book {
  const lines = (map: 'rows' | 'cols') => {
    const by = new Map<string, Keyed[]>();
    for (const [k, v] of store.entries(map)) {
      const cut = k.indexOf(':');
      if (cut < 0 || typeof v !== 'string') continue;
      const sheet = k.slice(0, cut);
      let list = by.get(sheet);
      if (!list) by.set(sheet, list = []);
      list.push({ id: k.slice(cut + 1), key: v });
    }
    for (const list of by.values()) list.sort(inOrder);
    return by;
  };
  const rows = lines('rows'), cols = lines('cols');
  const ids: Keyed[] = [];
  for (const [id, key] of store.entries('sheets')) if (typeof key === 'string') ids.push({ id, key });
  ids.sort(inOrder);
  const book: Book = { store, sheets: [], byId: new Map(), byName: new Map() };
  for (const { id } of ids) {
    const r = rows.get(id) ?? [], c = cols.get(id) ?? [];
    // Two people may have given two sheets one name at the same moment: the later one gets a number.
    const wanted = validName(String(store.get('names', id) ?? ''));
    let name = wanted;
    for (let n = 2; book.byName.has(name.toLowerCase()); n++) name = `${wanted.slice(0, 31 - ` (${n})`.length)} (${n})`;
    const sheet: Sheet = {
      id, name,
      rows: r.map((x) => x.id), rowKeys: r.map((x) => x.key),
      cols: c.map((x) => x.id), colKeys: c.map((x) => x.key),
      rowAt: new Map(r.map((x, i) => [x.id, i])), colAt: new Map(c.map((x, i) => [x.id, i])),
    };
    book.sheets.push(sheet);
    book.byId.set(id, sheet);
    book.byName.set(name.toLowerCase(), sheet);
  }
  return book;
}

export const cellKey = (sheet: string, row: string, col: string) => `${sheet}:${row}:${col}`;
/** What was typed into a cell, as it is stored ('' when empty). */
export function stored(book: Book, sheet: Sheet, row: number, col: number): string {
  const r = sheet.rows[row], c = sheet.cols[col];
  if (r === undefined || c === undefined) return '';
  const v = book.store.get('cells', cellKey(sheet.id, r, c));
  return v === undefined || v === null ? '' : String(v);
}
/** What was typed into a cell, as a person reads it (a formula with addresses). */
export const input = (book: Book, sheet: Sheet, row: number, col: number) => decodeFormula(book, sheet, stored(book, sheet, row, col));

/** A cell's number format: its own, or its column's ('' = automatic). */
export function formatOf(book: Book, sheet: Sheet, row: number, col: number): string {
  const r = sheet.rows[row], c = sheet.cols[col];
  if (c === undefined) return '';
  const own = r === undefined ? undefined : book.store.get('fmt', cellKey(sheet.id, r, c));
  return String(own ?? book.store.get('fmt', `${sheet.id}::${c}`) ?? '');
}

// ------------------------------------------------------------------ addresses

/** 0 -> "A", 25 -> "Z", 26 -> "AA". */
export function colName(index: number): string {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
export function colIndex(name: string): number {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export const a1 = (row: number, col: number) => `${colName(col)}${row + 1}`;
/** A sheet's name as a formula writes it. */
export const quoteSheet = (name: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/^([A-Za-z]{1,3}\d+|[Rr]\d*[Cc]?\d*|true|false)$/i.test(name) ? name : `'${name.replace(/'/g, "''")}'`);

export interface Rect { top: number; left: number; bottom: number; right: number }
/** "B2", "B2:D9", "B:D" or "Ledger!B2:D9" -> the sheet (null: none named) and a rectangle, bottom/right -1 for an open end. */
export function parseRange(text: string): { sheet: string | null; rect: Rect } | null {
  const m = /^(?:(?:'((?:[^']|'')+)'|([^'!:]+))!)?\$?([A-Za-z]{1,3})?\$?(\d{1,7})?(?::\$?([A-Za-z]{1,3})?\$?(\d{1,7})?)?$/.exec(text.trim());
  if (!m || (!m[3] && !m[4])) return null;
  const sheet = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2] ?? null;
  const c1 = m[3] ? colIndex(m[3]) : null, r1 = m[4] ? Number(m[4]) - 1 : null;
  const ranged = text.includes(':') && (m[5] !== undefined || m[6] !== undefined);
  const c2 = ranged ? (m[5] ? colIndex(m[5]) : null) : c1, r2 = ranged ? (m[6] ? Number(m[6]) - 1 : null) : r1;
  if ((r1 !== null && r1 < 0) || (r2 !== null && r2 < 0)) return null;
  const top = r1 ?? 0, left = c1 ?? 0;
  // An open end ("B:D", "2:5", "B2:D") runs to the end of the sheet.
  const bottom = r1 === null || (ranged && r2 === null) ? -1 : Math.max(top, r2 ?? top);
  const right = c1 === null || (ranged && c2 === null) ? -1 : Math.max(left, c2 ?? left);
  return { sheet, rect: { top: r2 === null ? top : Math.min(top, r2), left: c2 === null ? left : Math.min(left, c2), bottom, right } };
}

// ------------------------------------------------------------------ references in formulas

interface Corner { col: number | null; row: number | null; absCol: boolean; absRow: boolean }
/** One reference found in a formula written with addresses. */
export interface Ref { sheet: string | null; a: Corner; b: Corner | null }

const WORD = /[$_\p{L}][$_.\p{L}\p{N}]*/uy;
const NUMBER = /\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+/y;
const CELL = /^(\$?)([A-Za-z]{1,3})(\$?)([1-9][0-9]{0,6})$/;
const COL = /^(\$?)([A-Za-z]{1,3})$/;
const cornerOf = (word: string): Corner | null => {
  const m = CELL.exec(word);
  return m ? { col: colIndex(m[2]), row: Number(m[4]) - 1, absCol: !!m[1], absRow: !!m[3] } : null;
};
const colOf = (word: string): Corner | null => {
  const m = COL.exec(word);
  return m ? { col: colIndex(m[2]), row: null, absCol: !!m[1], absRow: false } : null;
};
const ROWS = /(\$?)([1-9]\d{0,6}):(\$?)([1-9]\d{0,6})(?![\d.:])/y;
const wordAt = (text: string, at: number): string => { WORD.lastIndex = at; return WORD.exec(text)?.[0] ?? ''; };
/** The end of the quoted run starting at `at` (the quote doubled is a quote inside it). */
const quotedEnd = (text: string, at: number, quote: string): number => {
  let j = at + 1;
  while (j < text.length && (text[j] !== quote || text[j + 1] === quote)) j += text[j] === quote ? 2 : 1;
  return j;
};

/**
 * Rewrite every cell reference of a formula written with addresses. Text in
 * quotes, function names, numbers ("1E5") and names are left as they are.
 */
export function mapRefs(formula: string, fn: (ref: Ref, text: string) => string): string {
  let out = '';
  let i = 0;
  const n = formula.length;
  /** A reference starting at `at` (after any sheet prefix): its end and what it is. */
  const refAt = (at: number): { end: number; a: Corner; b: Corner | null } | null => {
    // Whole rows: "2:5", "$2:$5".
    ROWS.lastIndex = at;
    const rows = ROWS.exec(formula);
    if (rows) return { end: at + rows[0].length, a: { col: null, row: Number(rows[2]) - 1, absCol: false, absRow: !!rows[1] }, b: { col: null, row: Number(rows[4]) - 1, absCol: false, absRow: !!rows[3] } };
    const w = wordAt(formula, at);
    if (!w) return null;
    const end = at + w.length;
    if (formula[end] === '(' || formula[end] === '!') return null;
    const next = formula[end] === ':' ? wordAt(formula, end + 1) : '';
    const second = next && formula[end + 1 + next.length] !== '(' ? next : '';
    const a = cornerOf(w);
    if (a) {
      const b = second ? cornerOf(second) : null;
      return b ? { end: end + 1 + second.length, a, b } : { end, a, b: null };
    }
    const ca = colOf(w), cb = second ? colOf(second) : null;
    return ca && cb ? { end: end + 1 + second.length, a: ca, b: cb } : null;
  };
  while (i < n) {
    const ch = formula[i];
    if (ch === '"') { const j = quotedEnd(formula, i, '"'); out += formula.slice(i, j + 1); i = j + 1; continue; } // text, copied whole
    let sheet: string | null = null, at = i;
    if (ch === "'") { // 'A sheet''s name'!
      const j = quotedEnd(formula, i, "'");
      if (formula[j + 1] !== '!') { out += formula.slice(i, j + 1); i = j + 1; continue; }
      sheet = formula.slice(i + 1, j).replace(/''/g, "'"); at = j + 2;
    } else if (wordAt(formula, i)) {
      const w = wordAt(formula, i);
      if (formula[i + w.length] === '!') { sheet = w; at = i + w.length + 1; }
    } else if (!(ROWS.lastIndex = i, ROWS.test(formula))) {
      NUMBER.lastIndex = i;
      const num = NUMBER.exec(formula)?.[0] ?? ch;
      out += num; i += num.length; continue;
    }
    const ref = refAt(at);
    if (ref) { out += fn({ sheet, a: ref.a, b: ref.b }, formula.slice(i, ref.end)); i = ref.end; continue; }
    // Not a reference: a function, a name, TRUE. Copy the word (and any sheet prefix) as it is.
    const end = Math.max(i + 1, at + wordAt(formula, at).length);
    out += formula.slice(i, end);
    i = end;
  }
  return out;
}

const OPEN = '⟦', CLOSE = '⟧';
const TOKEN = /⟦([^⟧]*)⟧(?::⟦([^⟧]*)⟧)?/g;
const REF_ERROR = '#REF!';

/** How far past its end a formula's reference may grow a sheet (a reference further out stays an address). */
const GROW_ROWS = 1_000, GROW_COLS = 100;
/** The furthest row and column of `sheet` that a formula written with addresses refers to, within what a formula may grow it to (-1: none). */
function reach(formula: string, sheet: Sheet): { row: number; col: number } {
  let row = -1, col = -1;
  if (formula.startsWith('=')) mapRefs(formula, (ref, text) => {
    if (ref.sheet !== null && ref.sheet.toLowerCase() !== sheet.name.toLowerCase()) return text;
    for (const c of [ref.a, ref.b]) {
      if (!c || (c.row ?? 0) >= sheet.rows.length + GROW_ROWS || (c.col ?? 0) >= sheet.cols.length + GROW_COLS) continue;
      row = Math.max(row, c.row ?? -1); col = Math.max(col, c.col ?? -1);
    }
    return text;
  });
  return { row, col };
}

/** A formula as a person typed it -> as it is stored: every reference that names an existing row and column becomes ids. */
export function encodeFormula(book: Book, sheet: Sheet, text: string): string {
  if (!text.startsWith('=')) return text;
  return mapRefs(text, (ref, original) => {
    const target = ref.sheet === null ? sheet : book.byName.get(ref.sheet.toLowerCase());
    if (!target) return original;
    const corner = (c: Corner): string | null => {
      const row = c.row === null ? '' : target.rows[c.row], col = c.col === null ? '' : target.cols[c.col];
      return row === undefined || col === undefined ? null : `${c.absRow ? '$' : ''}${row}.${c.absCol ? '$' : ''}${col}`;
    };
    const a = corner(ref.a), b = ref.b ? corner(ref.b) : '';
    if (a === null || b === null) return original; // beyond the sheet: stays an address
    const prefix = ref.sheet === null ? '' : `${target.id}!`;
    return `${OPEN}${prefix}${a}${CLOSE}${b ? `:${OPEN}${b}${CLOSE}` : ''}`;
  });
}

/** A stored formula -> with addresses, as the book stands now. A reference to something removed reads #REF!. */
export function decodeFormula(book: Book, sheet: Sheet, text: string): string {
  if (!text.startsWith('=') || !text.includes(OPEN)) return text;
  const tokens = (part: string) => part.replace(TOKEN, (_all, first: string, second: string | undefined) => {
    const bang = first.indexOf('!');
    const target = bang < 0 ? sheet : book.byId.get(first.slice(0, bang));
    if (!target) return REF_ERROR;
    const corner = (s: string): Corner | null => {
      const dot = s.indexOf('.');
      const r = s.slice(0, dot), c = s.slice(dot + 1);
      const absRow = r.startsWith('$'), absCol = c.startsWith('$');
      const rid = absRow ? r.slice(1) : r, cid = absCol ? c.slice(1) : c;
      const row = rid === '' ? null : target.rowAt.get(rid), col = cid === '' ? null : target.colAt.get(cid);
      return row === undefined || col === undefined ? null : { row, col, absRow, absCol };
    };
    const a = corner(first.slice(bang + 1)), b = second === undefined ? null : corner(second.slice(second.indexOf('!') + 1));
    if (!a || (second !== undefined && !b)) return REF_ERROR;
    return (bang < 0 ? '' : `${quoteSheet(target.name)}!`) + refText(a, b);
  });
  // Text in quotes is the person's own and is never read as a reference.
  let out = '', i = 0;
  while (i < text.length) {
    const q = text.indexOf('"', i);
    if (q < 0) { out += tokens(text.slice(i)); break; }
    const end = quotedEnd(text, q, '"');
    out += tokens(text.slice(i, q)) + text.slice(q, end + 1);
    i = end + 1;
  }
  return out;
}

const cornerText = (c: Corner) => `${c.col === null ? '' : `${c.absCol ? '$' : ''}${colName(c.col)}`}${c.row === null ? '' : `${c.absRow ? '$' : ''}${c.row + 1}`}`;
/** The sheet prefix a reference was written with ("Ledger!", "'My sheet'!", or nothing). */
const prefixOf = (original: string) => original.slice(0, original.lastIndexOf('!') + 1);

function refText(a: Corner, b: Corner | null): string {
  if (!b) return cornerText(a);
  // After a sort the corners may have changed places: a range is written top-left first.
  const pick = (k: 'row' | 'col', low: boolean) => (((a[k] ?? 0) <= (b[k] ?? 0)) === low ? a : b);
  const tl: Corner = { row: pick('row', true).row, absRow: pick('row', true).absRow, col: pick('col', true).col, absCol: pick('col', true).absCol };
  const br: Corner = { row: pick('row', false).row, absRow: pick('row', false).absRow, col: pick('col', false).col, absCol: pick('col', false).absCol };
  return `${cornerText(tl)}:${cornerText(br)}`;
}

/** A formula written with addresses, as it reads when copied `dr` rows down and `dc` columns right ($ parts stay). */
export function shiftFormula(formula: string, dr: number, dc: number): string {
  if (!formula.startsWith('=') || (!dr && !dc)) return formula;
  return mapRefs(formula, (ref, original) => {
    const move = (c: Corner): Corner | null => {
      const row = c.row === null || c.absRow ? c.row : c.row + dr, col = c.col === null || c.absCol ? c.col : c.col + dc;
      return (row !== null && row < 0) || (col !== null && col < 0) ? null : { ...c, row, col };
    };
    const a = move(ref.a), b = ref.b ? move(ref.b) : null;
    if (!a || (ref.b && !b)) return REF_ERROR;
    return prefixOf(original) + cornerText(a) + (b ? `:${cornerText(b)}` : '');
  });
}

/** Every formula in the book that refers to one of these rows (axis 0) or columns (axis 1) of `sheet`: where it is, and how it reads. */
function formulasTouching(book: Book, sheet: Sheet, ids: Set<string>, axis: 0 | 1): { sheet: Sheet; row: number; col: number; text: string }[] {
  const out: { sheet: Sheet; row: number; col: number; text: string }[] = [];
  for (const [key, v] of book.store.entries('cells')) {
    if (typeof v !== 'string' || !v.startsWith('=') || !v.includes(OPEN)) continue;
    const [sid, rid, cid] = key.split(':');
    const home = book.byId.get(sid);
    const row = home?.rowAt.get(rid), col = home?.colAt.get(cid);
    if (!home || row === undefined || col === undefined) continue;
    let hit = false;
    for (const m of v.matchAll(TOKEN)) {
      const bang = m[1].indexOf('!');
      if ((bang < 0 ? home.id : m[1].slice(0, bang)) !== sheet.id) continue;
      for (const corner of [m[1].slice(bang + 1), m[2]]) if (corner && ids.has(corner.slice(corner.indexOf('!') + 1).split('.')[axis].replace('$', ''))) hit = true;
    }
    if (hit) out.push({ sheet: home, row, col, text: decodeFormula(book, home, v) });
  }
  return out;
}

// ------------------------------------------------------------------ reading whole sheets

/** Every sheet's cells as rows of what was typed (formulas with addresses), up to the last cell that holds anything. */
export function grids(book: Book): Map<string, string[][]> {
  const out = new Map<string, string[][]>(book.sheets.map((s) => [s.id, []]));
  for (const [key, v] of book.store.entries('cells')) {
    if (v === undefined || v === null || v === '') continue;
    const [sid, rid, cid] = key.split(':');
    const sheet = book.byId.get(sid);
    const r = sheet?.rowAt.get(rid), c = sheet?.colAt.get(cid);
    if (!sheet || r === undefined || c === undefined) continue; // its row or column is gone
    const grid = out.get(sid)!;
    (grid[r] ??= [])[c] = decodeFormula(book, sheet, String(v));
  }
  for (const grid of out.values()) for (let r = 0; r < grid.length; r++) { const row = grid[r] ??= []; for (let c = 0; c < row.length; c++) row[c] ??= ''; }
  return out;
}

const escapeCell = (s: string) => s.replace(/[\\\t\n\r]/g, (ch) => (ch === '\\' ? '\\\\' : ch === '\t' ? '\\t' : ch === '\n' ? '\\n' : '\\r'));

/** A book as text: a "## name" line per sheet, then one line per row, cells separated by tabs. What search, history and link previews read. */
export function bookText(book: Book): string {
  const g = grids(book);
  return book.sheets.map((s) => [`## ${s.name}`, ...g.get(s.id)!.map((row) => row.map(escapeCell).join('\t'))].join('\n')).join('\n\n');
}

// ------------------------------------------------------------------ changing a book
//
// Every function here writes into the live document; the caller wraps the
// calls in one transaction and reads the book again after a change to its
// shape (rows, columns, sheets).

const ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function newId(length: number, taken: (id: string) => boolean): string {
  for (;;) {
    let id = '';
    for (let i = 0; i < length; i++) id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
    if (!taken(id)) return id;
  }
}

/**
 * Order keys for `count` new lines at `index`. Lines inserted at one place by
 * two people at once share a key; inserting between them gives the later ones
 * new keys too (`rekey`: index -> key).
 */
function keysAt(keys: string[], index: number, count: number): { fresh: string[]; rekey: [number, string][] } {
  const prev = index > 0 ? keys[index - 1] : null;
  let end = index;
  while (prev !== null && end < keys.length && keys[end] <= prev) end++;
  const made = generateNKeysBetween(prev, end < keys.length ? keys[end] : null, count + (end - index));
  return { fresh: made.slice(0, count), rekey: made.slice(count).map((k, i) => [index + i, k]) };
}

function insertLines(doc: Y.Doc, sheet: Sheet, map: 'rows' | 'cols', index: number, count: number): string[] {
  const ids = map === 'rows' ? sheet.rows : sheet.cols, keys = map === 'rows' ? sheet.rowKeys : sheet.colKeys;
  const max = map === 'rows' ? MAX_ROWS : MAX_COLS;
  if (ids.length + count > max) throw new Error(`A sheet holds at most ${max.toLocaleString('en')} ${map === 'rows' ? 'rows' : 'columns'}.`);
  const at = Math.max(0, Math.min(ids.length, index));
  const { fresh, rekey } = keysAt(keys, at, count);
  const m = doc.getMap(map);
  const taken = new Set(ids);
  const made: string[] = [];
  for (const key of fresh) {
    const id = newId(map === 'rows' ? 6 : 4, (x) => taken.has(x));
    taken.add(id); made.push(id);
    m.set(`${sheet.id}:${id}`, key);
  }
  for (const [i, key] of rekey) m.set(`${sheet.id}:${ids[i]}`, key);
  return made;
}
export const insertRows = (doc: Y.Doc, sheet: Sheet, index: number, count: number) => insertLines(doc, sheet, 'rows', index, count);
export const insertCols = (doc: Y.Doc, sheet: Sheet, index: number, count: number) => insertLines(doc, sheet, 'cols', index, count);

function deleteLines(doc: Y.Doc, book: Book, sheet: Sheet, map: 'rows' | 'cols', index: number, count: number) {
  const ids = (map === 'rows' ? sheet.rows : sheet.cols).slice(index, index + count);
  if (!ids.length) return;
  const gone = new Set(ids);
  const axis = map === 'rows' ? 'row' : 'col';
  const end = index + ids.length - 1;
  // A range that loses an end keeps what is left of it (SUM(B2:B9) without row 9 is SUM(B2:B8)), as in Excel.
  // Written first, while every row and column still has its id; a range that goes entirely, or a single cell, reads #REF!.
  const shrink = (text: string, home: Sheet) => mapRefs(text, (ref, original) => {
      if (!ref.b || (ref.sheet === null ? home : book.byName.get(ref.sheet.toLowerCase()))?.id !== sheet.id) return original;
      const x = ref.a[axis], y = ref.b[axis];
      if (x === null || y === null) return original;
      let lo = Math.min(x, y), hi = Math.max(x, y);
      if (lo >= index && hi <= end) return original;
      if (lo >= index && lo <= end) lo = end + 1;
      if (hi >= index && hi <= end) hi = index - 1;
      return `${prefixOf(original)}${cornerText({ ...ref.a, [axis]: lo })}:${cornerText({ ...ref.b, [axis]: hi })}`;
    });
  for (const f of formulasTouching(book, sheet, gone, axis === 'row' ? 0 : 1)) {
    if (f.sheet.id === sheet.id && f[axis] >= index && f[axis] <= end) continue; // going too
    const next = shrink(f.text, f.sheet);
    if (next !== f.text) setInput(doc, book, f.sheet, f.row, f.col, next);
  }
  // Charts on the sheet: their cells shrink the same way, and one sitting on a line that goes moves to the next that stays.
  const size = map === 'rows' ? sheet.rows.length : sheet.cols.length;
  for (const c of chartsOf(book, sheet)) {
    const at = c[axis] >= index && c[axis] <= end ? (end + 1 < size ? end + 1 : Math.max(0, index - 1)) : c[axis];
    const range = c.range.includes(REF_ERROR) ? c.range : shrink(`=${c.range}`, sheet).slice(1);
    if (at !== c[axis] || range !== c.range) putChart(doc, book, sheet, { ...c, [axis]: at, range });
  }
  const part = map === 'rows' ? 1 : 2;
  for (const name of ['cells', 'fmt'] as const) {
    const m = doc.getMap(name);
    for (const key of [...m.keys()]) { const p = key.split(':'); if (p[0] === sheet.id && gone.has(p[part])) m.delete(key); }
  }
  if (map === 'cols') for (const id of ids) doc.getMap('widths').delete(`${sheet.id}:${id}`);
  for (const id of ids) doc.getMap(map).delete(`${sheet.id}:${id}`);
}
export const deleteRows = (doc: Y.Doc, book: Book, sheet: Sheet, index: number, count: number) => deleteLines(doc, book, sheet, 'rows', index, count);
export const deleteCols = (doc: Y.Doc, book: Book, sheet: Sheet, index: number, count: number) => deleteLines(doc, book, sheet, 'cols', index, count);

/** Make a sheet at least this large (a paste or a formula reaching past its end grows it). Returns whether it grew. */
export function ensureSize(doc: Y.Doc, sheet: Sheet, rows: number, cols: number): boolean {
  const moreRows = rows - sheet.rows.length, moreCols = cols - sheet.cols.length;
  if (moreRows > 0) insertRows(doc, sheet, sheet.rows.length, moreRows);
  if (moreCols > 0) insertCols(doc, sheet, sheet.cols.length, moreCols);
  return moreRows > 0 || moreCols > 0;
}

/**
 * Put the rows at [from, from + order.length) in a new order (`order`: their
 * current indexes). A row moves whole, by taking the place's order key, so what
 * someone else is typing into it at that moment moves with it.
 *
 * Formulas then read as they would after a sort in Excel: inside the sorted
 * rows, a formula still points at the same places relative to itself (its own
 * row, the row above); outside them, a formula still covers the same area
 * (SUM(B2:B9) stays B2:B9). References to cells outside the sorted rows are
 * untouched.
 */
export function reorderRows(doc: Y.Doc, book: Book, sheet: Sheet, from: number, order: number[]) {
  const to = from + order.length - 1;
  const newIndex = new Map(order.map((was, i) => [was, from + i]));
  if (order.every((was, i) => was === from + i)) return;
  const formulas = formulasTouching(book, sheet, new Set(sheet.rows.slice(from, to + 1)), 0).map((f) => {
    const inside = f.sheet.id === sheet.id && f.row >= from && f.row <= to;
    const delta = inside ? newIndex.get(f.row)! - f.row : 0;
    const text = mapRefs(f.text, (ref, original) => {
      if ((ref.sheet === null ? f.sheet : book.byName.get(ref.sheet.toLowerCase()))?.id !== sheet.id) return original;
      const place = (c: Corner): Corner => (c.row === null || c.absRow || c.row < from || c.row > to ? c : { ...c, row: c.row + delta });
      const a = place(ref.a), b = ref.b ? place(ref.b) : null;
      return a.row !== null && a.row < 0 || (b && b.row !== null && b.row < 0) ? REF_ERROR : `${prefixOf(original)}${cornerText(a)}${b ? `:${cornerText(b)}` : ''}`;
    });
    return { sheetId: f.sheet.id, rowId: f.sheet.rows[f.row], col: f.col, text };
  });
  // The places' own keys, when they tell the places apart. Rows inserted at one place by two people at once share a
  // key (their order is then by id): such a block gets fresh keys, or the rows would not land where they are sent.
  const keys = sheet.rowKeys;
  const distinct = (i: number) => i < 0 || i + 1 >= keys.length || keys[i] < keys[i + 1];
  let slots = keys.slice(from, to + 1);
  const m = doc.getMap('rows');
  if (![...slots.keys()].every((i) => distinct(from + i)) || !distinct(from - 1)) {
    const rest = [...keys.slice(0, from), ...keys.slice(to + 1)];
    const made = keysAt(rest, from, order.length);
    slots = made.fresh;
    for (const [i, key] of made.rekey) m.set(`${sheet.id}:${sheet.rows[i + order.length]}`, key);
  }
  order.forEach((was, i) => { if (sheet.rowKeys[was] !== slots[i]) m.set(`${sheet.id}:${sheet.rows[was]}`, slots[i]); });
  const charts = chartsOf(book, sheet);
  const after = readBook(book.store);
  for (const f of formulas) {
    const home = after.byId.get(f.sheetId)!;
    const row = home.rowAt.get(f.rowId);
    if (row !== undefined) setInput(doc, after, home, row, f.col, f.text);
  }
  // A chart covers the same area and sits at the same place after a sort, like a formula outside the sorted rows.
  for (const c of charts) if (!c.range.includes(REF_ERROR)) putChart(doc, after, after.byId.get(sheet.id)!, c);
}

export function addSheet(doc: Y.Doc, book: Book, name: string, rows = NEW_ROWS, cols = NEW_COLS): string {
  return addSheetNamed(doc, book, name, rows, cols).id;
}
/** Add a sheet; returns its id and the name it was given (see validName). */
export function addSheetNamed(doc: Y.Doc, book: Book, name: string, rows = NEW_ROWS, cols = NEW_COLS): { id: string; name: string } {
  if (book.sheets.length >= MAX_SHEETS) throw new Error(`A spreadsheet holds at most ${MAX_SHEETS} sheets.`);
  const id = newId(4, (x) => book.byId.has(x));
  const last = book.sheets.length ? (book.store.get('sheets', book.sheets[book.sheets.length - 1].id) as string) : null;
  doc.getMap('sheets').set(id, generateNKeysBetween(last, null, 1)[0]);
  const clean = cleanName(book, name, null);
  doc.getMap('names').set(id, clean);
  const empty: Sheet = { id, name: clean, rows: [], rowKeys: [], cols: [], colKeys: [], rowAt: new Map(), colAt: new Map() };
  insertRows(doc, empty, 0, rows);
  insertCols(doc, empty, 0, cols);
  return { id, name: clean };
}

/** The name a sheet gets (see validName); refused if another sheet has it. */
function cleanName(book: Book, name: string, self: string | null): string {
  const clean = validName(name);
  const other = book.byName.get(clean.toLowerCase());
  if (other && other.id !== self) throw new Error(`There is already a sheet named “${other.name}”.`);
  return clean;
}
export function renameSheet(doc: Y.Doc, book: Book, sheet: Sheet, name: string): string {
  const clean = cleanName(book, name, sheet.id);
  doc.getMap('names').set(sheet.id, clean);
  return clean;
}
export function deleteSheet(doc: Y.Doc, book: Book, sheet: Sheet) {
  if (book.sheets.length <= 1) throw new Error('A spreadsheet keeps at least one sheet.');
  for (const name of SHEET_MAPS) {
    const m = doc.getMap(name);
    for (const key of [...m.keys()]) if (key === sheet.id || key.startsWith(`${sheet.id}:`)) m.delete(key);
  }
}

/** Write what was typed into a cell ('' clears it). The text is a formula with addresses, a number, a date or words. */
export function setInput(doc: Y.Doc, book: Book, sheet: Sheet, row: number, col: number, text: string) {
  const r = sheet.rows[row], c = sheet.cols[col];
  if (r === undefined || c === undefined) throw new Error(`${a1(row, col)} is outside the sheet.`);
  if (text.length > MAX_CELL_CHARS) throw new Error(`A cell holds at most ${MAX_CELL_CHARS.toLocaleString('en')} characters.`);
  const m = doc.getMap('cells'), key = cellKey(sheet.id, r, c);
  const next = encodeFormula(book, sheet, text);
  if (next === '') { if (m.has(key)) m.delete(key); } else if (m.get(key) !== next) m.set(key, next);
}

/**
 * Write a block of typed values with its top-left corner at (row, col),
 * growing the sheet if the block, or a formula in it, reaches past its end.
 * Returns the book as it is afterwards.
 */
export function setBlock(doc: Y.Doc, book: Book, sheetId: string, row: number, col: number, block: string[][]): Book {
  let sheet = book.byId.get(sheetId)!;
  let rows = row + block.length, cols = col + block.reduce((n, r) => Math.max(n, r.length), 0);
  if (rows > MAX_ROWS || cols > MAX_COLS) throw new Error(`That reaches past the largest sheet (${MAX_ROWS.toLocaleString('en')} rows, ${MAX_COLS.toLocaleString('en')} columns).`);
  // Checked before anything is written: a block goes in whole or not at all.
  if (block.some((line) => line.some((text) => text.length > MAX_CELL_CHARS))) throw new Error(`A cell holds at most ${MAX_CELL_CHARS.toLocaleString('en')} characters.`);
  for (const line of block) for (const text of line) { const far = reach(text, sheet); rows = Math.max(rows, far.row + 1); cols = Math.max(cols, far.col + 1); }
  if (ensureSize(doc, sheet, Math.min(rows, MAX_ROWS), Math.min(cols, MAX_COLS))) { book = readBook(book.store); sheet = book.byId.get(sheetId)!; }
  block.forEach((line, i) => line.forEach((text, j) => setInput(doc, book, sheet, row + i, col + j, text)));
  return book;
}

/** Set (or with '' clear) the number format of a rectangle; a whole column's format is one entry. */
export function setFormat(doc: Y.Doc, sheet: Sheet, rect: Rect, format: string) {
  const m = doc.getMap('fmt');
  const put = (key: string) => { if (format) m.set(key, format); else if (m.has(key)) m.delete(key); };
  const wholeColumns = rect.top === 0 && rect.bottom >= sheet.rows.length - 1;
  for (let c = rect.left; c <= rect.right && c < sheet.cols.length; c++) {
    if (wholeColumns) {
      for (const key of [...m.keys()]) { const p = key.split(':'); if (p[0] === sheet.id && p[1] !== '' && p[2] === sheet.cols[c]) m.delete(key); }
      put(`${sheet.id}::${sheet.cols[c]}`);
    } else for (let r = rect.top; r <= rect.bottom && r < sheet.rows.length; r++) put(cellKey(sheet.id, sheet.rows[r], sheet.cols[c]));
  }
}

/** A new spreadsheet: one empty sheet. */
export function initBook(doc: Y.Doc) {
  addSheet(doc, readBook(liveStore(doc)), 'Sheet1');
}

// ------------------------------------------------------------------ charts on a sheet
//
// A chart sits on a sheet at a cell and draws a range of that sheet. Its range
// is kept the way a formula's references are (by row and column id), so it
// follows its cells; where it sits is a row and a column id too.

export interface SheetChart {
  id: string;
  /** Its settings, as a chart block's text without rows or a data line (see chart.ts). */
  text: string;
  /** The cells it draws, as an address ("A1:C13"; "#REF!" when they are gone). */
  range: string;
  /** Where its top-left corner sits. */
  row: number; col: number;
  width: number; height: number;
}
interface StoredChart { t: string; g: string; r: string; c: string; w: number; h: number }
const CHART_W = 480, CHART_H = 300;
/** The longest a stored chart may be (documents.ts refuses longer from a browser). */
export const MAX_CHART_CHARS = 24_000;

export function chartsOf(book: Book, sheet: Sheet): SheetChart[] {
  const out: SheetChart[] = [];
  for (const [key, v] of book.store.entries('charts')) {
    if (!key.startsWith(`${sheet.id}:`) || typeof v !== 'string') continue;
    let c: StoredChart;
    try { c = JSON.parse(v) as StoredChart; } catch { continue; }
    if (!c || typeof c !== 'object') continue; // not a chart: someone wrote something else here
    out.push({
      id: key.slice(sheet.id.length + 1), text: String(c.t ?? ''), range: decodeFormula(book, sheet, `=${c.g ?? ''}`).slice(1),
      row: sheet.rowAt.get(c.r) ?? 0, col: sheet.colAt.get(c.c) ?? 0, width: Number(c.w) || CHART_W, height: Number(c.h) || CHART_H,
    });
  }
  return out.sort((a, b) => a.row - b.row || a.col - b.col || (a.id < b.id ? -1 : 1));
}

/** Place a chart on a sheet, or (with `id`) change the one there. Returns its id. */
export function putChart(doc: Y.Doc, book: Book, sheet: Sheet, chart: { id?: string; text: string; range: string; row: number; col: number; width?: number; height?: number }): string {
  const range = chart.range.includes(REF_ERROR) ? null : parseRange(chart.range);
  if (!chart.range.includes(REF_ERROR) && (!range || range.sheet)) throw new Error(`A chart on a sheet draws cells of that sheet, such as "A1:C13" (got "${chart.range}").`);
  const m = doc.getMap('charts');
  const id = chart.id ?? newId(5, (x) => m.has(`${sheet.id}:${x}`));
  const row = sheet.rows[Math.max(0, Math.min(sheet.rows.length - 1, chart.row))], col = sheet.cols[Math.max(0, Math.min(sheet.cols.length - 1, chart.col))];
  const stored: StoredChart = { t: chart.text, g: encodeFormula(book, sheet, `=${chart.range}`).slice(1), r: row, c: col, w: Math.round(chart.width ?? CHART_W), h: Math.round(chart.height ?? CHART_H) };
  const json = JSON.stringify(stored);
  // As it is stored (with its quotes and line breaks escaped), which is what the server measures.
  if (json.length > MAX_CHART_CHARS) throw new Error('A chart’s settings and code are too long (about 20,000 characters at most).');
  if (m.get(`${sheet.id}:${id}`) !== json) m.set(`${sheet.id}:${id}`, json);
  return id;
}
export function deleteChart(doc: Y.Doc, sheet: Sheet, id: string) {
  doc.getMap('charts').delete(`${sheet.id}:${id}`);
}

// ------------------------------------------------------------------ comparing two states

export interface EntryChange { map: SheetMap; key: string; before: unknown; after: unknown }
/** Every stored entry that differs between two states. */
export function diffStores(a: Store, b: Store): EntryChange[] {
  const out: EntryChange[] = [];
  for (const map of SHEET_MAPS) {
    const was = new Map(a.entries(map));
    for (const [key, after] of b.entries(map)) {
      const before = was.get(key);
      was.delete(key);
      if (before !== after) out.push({ map, key, before, after });
    }
    for (const [key, before] of was) out.push({ map, key, before, after: undefined });
  }
  return out;
}

/** Make the live document's sheet entries equal `target`'s (a restore). Returns how many entries changed. */
export function restoreStore(doc: Y.Doc, target: Store): number {
  const changes = diffStores(liveStore(doc), target);
  for (const c of changes) { const m = doc.getMap(c.map); if (c.after === undefined) m.delete(c.key); else m.set(c.key, c.after); }
  return changes.length;
}

/** One line of a change list, addressed as the newer book stands (or the older one, for what is gone). */
export interface CellChange { where: string; before: string; after: string; key?: string }
export interface BookChanges { cells: CellChange[]; notes: string[]; /** Every stored entry that differs (for who changed what). */ entries: EntryChange[] }

/** What changed between two states of a book, in a spreadsheet's terms: cells, rows, columns, sheets. */
export function bookChanges(a: Store, b: Store): BookChanges {
  const before = readBook(a), after = readBook(b);
  const notes: string[] = [];
  const cells: CellChange[] = [];
  const gridsBefore = grids(before);
  const runs = (indexes: number[]): string => {
    const out: string[] = [];
    for (let i = 0; i < indexes.length; i++) { let j = i; while (j + 1 < indexes.length && indexes[j + 1] === indexes[j] + 1) j++; out.push(i === j ? `${indexes[i] + 1}` : `${indexes[i] + 1}–${indexes[j] + 1}`); i = j; }
    return out.length > 12 ? `${out.slice(0, 12).join(', ')} and ${out.length - 12} more runs` : out.join(', ');
  };
  const colRuns = (indexes: number[]) => runs(indexes).replace(/\d+/g, (d) => colName(Number(d) - 1));
  for (const s of before.sheets) {
    if (after.byId.has(s.id)) continue;
    const used = gridsBefore.get(s.id)!.length;
    notes.push(`Sheet “${s.name}” was removed${used ? ` (${used} row${used === 1 ? '' : 's'} of content)` : ''}.`);
  }
  for (const s of after.sheets) {
    const was = before.byId.get(s.id);
    if (!was) { notes.push(`Sheet “${s.name}” was added.`); continue; }
    if (was.name !== s.name) notes.push(`Sheet “${was.name}” was renamed “${s.name}”.`);
    const addedRows = s.rows.flatMap((id, i) => (was.rowAt.has(id) ? [] : [i])), goneRows = was.rows.flatMap((id, i) => (s.rowAt.has(id) ? [] : [i]));
    const addedCols = s.cols.flatMap((id, i) => (was.colAt.has(id) ? [] : [i])), goneCols = was.cols.flatMap((id, i) => (s.colAt.has(id) ? [] : [i]));
    if (addedRows.length) notes.push(`${s.name}: row${addedRows.length === 1 ? '' : 's'} ${runs(addedRows)} added.`);
    if (addedCols.length) notes.push(`${s.name}: column${addedCols.length === 1 ? '' : 's'} ${colRuns(addedCols)} added.`);
    const lost = (indexes: number[], row: boolean) => indexes.filter((i) => (row ? gridsBefore.get(s.id)![i]?.some((v) => v !== '') : gridsBefore.get(s.id)!.some((r) => (r[i] ?? '') !== ''))).length;
    if (goneRows.length) { const n = lost(goneRows, true); notes.push(`${s.name}: row${goneRows.length === 1 ? '' : 's'} ${runs(goneRows)} (as numbered before) removed${n ? `, ${n} with content` : ''}.`); }
    if (goneCols.length) { const n = lost(goneCols, false); notes.push(`${s.name}: column${goneCols.length === 1 ? '' : 's'} ${colRuns(goneCols)} (as lettered before) removed${n ? `, ${n} with content` : ''}.`); }
    // Rows that kept their ids but changed places (a sort).
    const kept = s.rows.filter((id) => was.rowAt.has(id));
    let moved = 0, last = -1;
    for (const id of kept) { const i = was.rowAt.get(id)!; if (i < last) moved++; else last = i; }
    if (moved) notes.push(`${s.name}: rows were reordered.`);
  }
  // Cells are compared as stored (references as ids), so a formula does not count as changed because a row was inserted above it.
  const entries = diffStores(a, b);
  const looks = new Map<string, { fmt: number; widths: number; charts: number }>();
  for (const c of entries) {
    if (c.map === 'fmt' || c.map === 'widths' || c.map === 'charts') {
      const sheet = after.byId.get(c.key.slice(0, c.key.indexOf(':')));
      if (!sheet || !before.byId.has(sheet.id)) continue;
      const n = looks.get(sheet.name) ?? { fmt: 0, widths: 0, charts: 0 };
      n[c.map]++;
      looks.set(sheet.name, n);
    }
    if (c.map !== 'cells') continue;
    const [sid, rid, cid] = c.key.split(':');
    const sheet = after.byId.get(sid);
    const r = sheet?.rowAt.get(rid), col = sheet?.colAt.get(cid);
    if (!sheet || r === undefined || col === undefined) continue; // its row, column or sheet is gone: said above
    const old = before.byId.get(sid);
    cells.push({
      where: `${after.sheets.length > 1 ? `${quoteSheet(sheet.name)}!` : ''}${a1(r, col)}`, key: c.key,
      before: c.before === undefined || !old ? '' : decodeFormula(before, old, String(c.before)),
      after: c.after === undefined ? '' : decodeFormula(after, sheet, String(c.after)),
    });
  }
  const place = (w: string) => { const p = parseRange(w)!; return [p.sheet ?? '', p.rect.top, p.rect.left] as const; };
  cells.sort((x, y) => { const p = place(x.where), q = place(y.where); return p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : p[1] - q[1] || p[2] - q[2]; });
  for (const [name, n] of looks) notes.push(`${name}: ${[n.fmt ? 'number formats' : '', n.widths ? 'column widths' : '', n.charts ? 'charts' : ''].filter(Boolean).join(' and ')} changed.`);
  return { cells, notes, entries };
}

// ------------------------------------------------------------------ text in and out

/** Clipboard text as a spreadsheet writes it: rows on lines, cells between tabs (or commas: CSV), a cell holding a separator, a line break or a quote in "quotes". */
export function parseTsv(text: string, sep = '\t'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  const n = text.length;
  const ends = (ch: string | undefined) => ch === undefined || ch === sep || ch === '\n' || ch === '\r';
  for (let i = 0; ;) {
    let cell = '';
    const close = text[i] === '"' ? quotedEnd(text, i, '"') : -1;
    if (close >= 0 && close < n && ends(text[close + 1])) { cell = text.slice(i + 1, close).replace(/""/g, '"'); i = close + 1; }
    else while (!ends(text[i])) cell += text[i++];
    row.push(cell);
    if (i < n && text[i] === sep) { i++; continue; }
    rows.push(row);
    row = [];
    i += text[i] === '\r' && text[i + 1] === '\n' ? 2 : 1;
    if (i >= n) return rows; // a line break at the very end closes the last row, it does not start another
  }
}
export function toTsv(rows: string[][]): string {
  return rows.map((r) => r.map((v) => (/[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join('\t')).join('\n');
}
