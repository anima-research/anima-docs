// What a spreadsheet's cells come to: formulas evaluated (HyperFormula), and
// numbers written the way their format says. Runs in the server (what agents
// read, what goes into Excel) and in the browser (what the grid shows), over
// the same book, so both see the same values.

import { HyperFormula, DetailedCellError, type CellValue, type ConfigParams } from 'hyperformula';
import { decodeFormula, formatOf, grids, stored, type Book, type Sheet } from './sheet.js';

/**
 * Dates are read when they cannot be misread: 2026-03-04 (with or without a
 * time) and 04.03.2026. "3/4/2026" stays text: March or April depends on who
 * typed it, and everyone in a sheet must see one value.
 */
function parseDateTime(text: string): Partial<DateTime> | undefined {
  const s = text.trim();
  const time = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (time) return Number(time[1]) < 24 && Number(time[2]) < 60 && Number(time[3] ?? 0) < 60 ? { hours: Number(time[1]), minutes: Number(time[2]), seconds: Number(time[3] ?? 0) } : undefined;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  const dotted = iso ? null : /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (!iso && !dotted) return undefined;
  const [year, month, day] = iso ? [Number(iso[1]), Number(iso[2]), Number(iso[3])] : [Number(dotted![3]), Number(dotted![2]), Number(dotted![1])];
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return undefined;
  if (iso?.[4] === undefined) return { year, month, day };
  if (Number(iso[4]) > 23 || Number(iso[5]) > 59 || Number(iso[6] ?? 0) > 59) return undefined;
  return { year, month, day, hours: Number(iso[4]), minutes: Number(iso[5]), seconds: Number(iso[6] ?? 0) };
}

const CONFIG: Partial<ConfigParams> = {
  licenseKey: 'gpl-v3',
  parseDateTime: parseDateTime as ConfigParams['parseDateTime'],
};

/** Number formats offered in the grid; any Excel format code of these shapes works. */
export const FORMATS: { label: string; code: string; sample: string }[] = [
  { label: 'Automatic', code: '', sample: '' },
  { label: 'Number', code: '#,##0.00', sample: '1,234.50' },
  { label: 'Whole number', code: '#,##0', sample: '1,235' },
  { label: 'Percent', code: '0.00%', sample: '12.50%' },
  { label: 'Dollars', code: '$#,##0.00', sample: '$1,234.50' },
  { label: 'Euros', code: '€#,##0.00', sample: '€1,234.50' },
  { label: 'Pounds', code: '£#,##0.00', sample: '£1,234.50' },
  { label: 'Date', code: 'yyyy-mm-dd', sample: '2026-03-04' },
  { label: 'Date and time', code: 'yyyy-mm-dd hh:mm', sample: '2026-03-04 15:30' },
  { label: 'Plain text', code: '@', sample: '' },
];

export interface DateTime { year: number; month: number; day: number; hours: number; minutes: number; seconds: number }
const two = (n: number) => String(n).padStart(2, '0');
const isDateCode = (code: string) => /[ymdhs]/i.test(code) && !/[0#]/.test(code);

/** A number without a format: as short as it can be written exactly enough (12 significant digits). */
function general(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  return String(Number(v.toPrecision(12)));
}

/**
 * A number written by an Excel format code: "#,##0.00", "0%", "$#,##0.00", "yyyy-mm-dd hh:mm", "@".
 * A code may have sections for positive, negative and zero ("#,##0.00;(#,##0.00)", as accounts write negatives);
 * colours and conditions in brackets are left out.
 */
export function formatNumber(v: number, code: string, toDate: (n: number) => DateTime): string {
  const sections = code.replace(/\[[^\]]*\]/g, '').split(';');
  if (sections.length > 1 && !isDateCode(sections[0])) {
    if (v < 0 && sections[1]) return formatNumber(-v, sections[1], toDate);
    if (v === 0 && sections[2]) return formatNumber(0, sections[2], toDate);
  }
  code = sections[0].replace(/"/g, '');
  if (!code || code === 'General') return general(v);
  if (code === '@') return general(v);
  if (isDateCode(code)) {
    const d = toDate(v);
    let sawHours = false;
    return code.replace(/yyyy|yy|mm|dd|hh|ss|m|d|h/gi, (t) => {
      const k = t.toLowerCase();
      if (k === 'yyyy') return String(d.year);
      if (k === 'yy') return two(d.year % 100);
      if (k === 'dd') return two(d.day);
      if (k === 'd') return String(d.day);
      if (k === 'hh' || k === 'h') { sawHours = true; return k === 'hh' ? two(d.hours) : String(d.hours); }
      if (k === 'ss') return two(Math.floor(d.seconds));
      // "mm" is minutes after hours, months otherwise.
      if (sawHours) return k === 'mm' ? two(d.minutes) : String(d.minutes);
      return k === 'mm' ? two(d.month) : String(d.month);
    });
  }
  const first = code.search(/[0#]/);
  if (first < 0) return code; // no place for digits: the code's own text (a dash for zero, say)
  const last = Math.max(code.lastIndexOf('0'), code.lastIndexOf('#'));
  const body = code.slice(first, last + 1), prefix = code.slice(0, first), suffix = code.slice(last + 1);
  const percent = code.includes('%');
  const dot = body.indexOf('.');
  const decimals = Math.min(20, dot < 0 ? 0 : body.length - dot - 1);
  const n = Math.abs(percent ? v * 100 : v);
  let digits = n.toFixed(decimals);
  if (body.includes(',')) { const [int, frac] = digits.split('.'); digits = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : ''); }
  const negative = v < 0 && Number(digits.replace(/,/g, '')) !== 0;
  return `${negative ? '-' : ''}${prefix}${digits}${suffix}`;
}

/** What a cell shows, and what kind of thing it is (numbers sit on the right, errors are marked). */
export interface Shown { text: string; kind: 'empty' | 'text' | 'number' | 'bool' | 'error' }
const EMPTY: Shown = { text: '', kind: 'empty' };

export class Calc {
  private hf: HyperFormula;
  private ids = new Map<string, number>();
  book: Book;

  constructor(book: Book) {
    this.book = book;
    this.hf = this.build(book);
  }

  private build(book: Book): HyperFormula {
    const g = grids(book);
    // An empty cell is given as nothing at all: an empty text would count as a value (COUNTA).
    const hf = HyperFormula.buildFromSheets(Object.fromEntries(book.sheets.map((s) => [s.name, g.get(s.id)!.map((row) => row.map((v) => (v === '' ? null : v)))])), CONFIG);
    this.ids = new Map(book.sheets.map((s) => [s.id, hf.getSheetId(s.name)!]));
    return hf;
  }

  /** The book changed shape (rows, columns, sheets): every address may mean another cell now. */
  rebuild(book: Book) {
    this.hf.destroy();
    this.book = book;
    this.hf = this.build(book);
  }

  /** Cells were written (the book's shape is as it was): take their new contents. */
  update(book: Book, cells: { sheet: Sheet; row: number; col: number }[]) {
    this.book = book;
    this.hf.batch(() => {
      for (const c of cells) {
        const sheet = this.ids.get(c.sheet.id);
        if (sheet !== undefined) this.hf.setCellContents({ sheet, row: c.row, col: c.col }, decodeFormula(book, c.sheet, stored(book, c.sheet, c.row, c.col)) || null);
      }
    });
  }

  value(sheet: Sheet, row: number, col: number): CellValue {
    const id = this.ids.get(sheet.id);
    return id === undefined ? null : this.hf.getCellValue({ sheet: id, row, col });
  }

  readonly toDate = (n: number): DateTime => {
    return { year: 0, month: 0, day: 0, hours: 0, minutes: 0, seconds: 0, ...this.hf.numberToDateTime(n) };
  };

  /** The format a number is shown with: the cell's or its column's, else what the value is (a date reads as a date). */
  formatFor(sheet: Sheet, row: number, col: number): string {
    const own = formatOf(this.book, sheet, row, col);
    if (own) return own;
    const id = this.ids.get(sheet.id);
    if (id === undefined) return '';
    const addr = { sheet: id, row, col };
    switch (this.hf.getCellValueDetailedType(addr) as string) {
      case 'NUMBER_DATE': return 'yyyy-mm-dd';
      case 'NUMBER_DATETIME': return 'yyyy-mm-dd hh:mm';
      case 'NUMBER_TIME': return 'hh:mm';
      case 'NUMBER_PERCENT': return '0.##%';
      case 'NUMBER_CURRENCY': return `${this.hf.getCellValueFormat(addr) ?? '$'}#,##0.00`;
      default: return '';
    }
  }

  shown(sheet: Sheet, row: number, col: number): Shown {
    const v = this.value(sheet, row, col);
    if (v === null || v === undefined || v === '') return EMPTY;
    if (v instanceof DetailedCellError) return { text: v.value, kind: 'error' };
    if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE', kind: 'bool' };
    if (typeof v === 'string') return { text: v, kind: 'text' };
    if (typeof v !== 'number') return { text: String(v), kind: 'text' };
    const code = this.formatFor(sheet, row, col);
    // A typed percentage keeps the digits it was typed with ("12.5%"), not a fixed two.
    if (code === '0.##%') return { text: `${general(v * 100)}%`, kind: 'number' };
    return { text: formatNumber(v, code, this.toDate), kind: code === '@' ? 'text' : 'number' };
  }

  destroy() { this.hf.destroy(); }
}

/**
 * The order (as current row indexes) that sorts rows top..bottom by a column's
 * values, the way Excel orders them: numbers, then text, then FALSE and TRUE,
 * then errors; empty cells last whichever way. Equal rows keep their order.
 */
export function sortOrder(calc: Calc, sheet: Sheet, top: number, bottom: number, col: number, descending: boolean): number[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const keyed: { r: number; v: CellValue; rank: number }[] = [];
  for (let r = top; r <= bottom; r++) {
    const v = calc.value(sheet, r, col);
    keyed.push({ r, v, rank: v === null || v === undefined || v === '' ? 4 : typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : typeof v === 'boolean' ? 2 : 3 });
  }
  keyed.sort((x, y) => {
    if (x.rank === 4 || y.rank === 4) return x.rank === y.rank ? x.r - y.r : x.rank === 4 ? 1 : -1;
    const d = x.rank - y.rank || (x.rank === 0 ? (x.v as number) - (y.v as number) : x.rank === 1 ? collator.compare(x.v as string, y.v as string) : x.rank === 2 ? Number(x.v) - Number(y.v) : 0);
    return (descending ? -d : d) || x.r - y.r;
  });
  return keyed.map((k) => k.r);
}

/** The most a chart reads of a range: beyond this a chart shows nothing a reader could make out. */
export const CHART_ROWS = 5_000, CHART_COLS = 100;

/** The values of a rectangle of cells, row by row, for a chart: numbers as numbers (dates and times as they show), everything else as it shows. */
export function rangeValues(calc: Calc, sheet: Sheet, top: number, left: number, bottom: number, right: number): (string | number | null)[][] {
  const out: (string | number | null)[][] = [];
  for (let r = top; r <= bottom; r++) {
    const row: (string | number | null)[] = [];
    for (let c = left; c <= right; c++) {
      const v = calc.value(sheet, r, c);
      // A number stays a number unless it shows as a date or a time (colours in brackets and quoted words are not date letters).
      const code = calc.formatFor(sheet, r, c).replace(/\[[^\]]*\]|"[^"]*"/g, '').split(';')[0];
      row.push(typeof v === 'number' && !isDateCode(code) ? v : calc.shown(sheet, r, c).text || null);
    }
    out.push(row);
  }
  return out;
}
