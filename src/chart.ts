// Charts: what a chart block says, and the picture it becomes.
//
// A chart is a few lines of text: what kind, a title, which columns, where the
// data is (rows written under it, or a range of a spreadsheet). The same text
// is a fenced block in a document (```chart) and the definition of a chart
// placed on a sheet. This module reads it and turns it, with its data, into
// options for the drawing library (ECharts); the server draws those to SVG
// for published pages and Excel, the browser draws them in a frame.
//
// A chart of type "code" is JavaScript instead: it runs only in a reader's
// browser, in a sandboxed frame with no network and no access to the app.
//
// Runs in the server and in the browser; imports nothing.


export const CHART_TYPES = ['bar', 'line', 'area', 'pie', 'scatter', 'code'] as const;
export type ChartType = typeof CHART_TYPES[number];

export interface ChartSpec {
  type: ChartType;
  title: string;
  /** Data from a spreadsheet: the document (its id) and the cells. In a chart on a sheet, the document is that spreadsheet. */
  source: { doc: string; range: string } | null;
  /** The column of names or x values (a heading or a letter); '' = the first. */
  x: string;
  /** The columns drawn; empty = every other column that holds numbers. */
  y: string[];
  stacked: boolean;
  horizontal: boolean;
  height: number;
  /** Rows written in the block itself, the first being the headings. */
  rows: string[][];
  /** For type "code": the JavaScript. */
  code: string;
}

export interface Table { columns: string[]; rows: (string | number | null)[][] }
export type Theme = 'light' | 'dark';

const yes = (v: string) => /^(yes|true|on|1)$/i.test(v.trim());
const HEADER = /^([A-Za-z]+)\s*:\s*(.*)$/;

const SETTINGS = new Set(['type', 'title', 'data', 'x', 'y', 'stacked', 'horizontal', 'height']);
/** The settings at the top of a block, each with the line it is on, and the line where they end. */
function settingsOf(lines: string[]): { settings: { key: string; value: string; line: number }[]; end: number } {
  const settings: { key: string; value: string; line: number }[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const m = HEADER.exec(lines[i]);
    if (!m || !SETTINGS.has(m[1].toLowerCase())) break; // not a setting: the body starts here
    settings.push({ key: m[1].toLowerCase(), value: m[2].trim(), line: i });
  }
  return { settings, end: i };
}

/** The line of a chart block (counted from its first) that names its data, as parseChart reads it; -1 if none. */
export function dataLineOf(text: string): number {
  let line = -1;
  for (const s of settingsOf(text.replace(/\r\n?/g, '\n').split('\n')).settings) if (s.key === 'data' && s.value) line = s.line;
  return line;
}

/** Read a chart block. Lines of "key: value" first; then, after an empty line, the rows (or for type code, the JavaScript). */
export function parseChart(text: string): ChartSpec {
  const spec: ChartSpec = { type: 'bar', title: '', source: null, x: '', y: [], stacked: false, horizontal: false, height: 320, rows: [], code: '' };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const { settings, end } = settingsOf(lines);
  let i = end;
  for (const { key, value } of settings) {
    if (key === 'type') { if ((CHART_TYPES as readonly string[]).includes(value.toLowerCase())) spec.type = value.toLowerCase() as ChartType; }
    else if (key === 'title') spec.title = value.slice(0, 200);
    else if (key === 'data') {
      // "dAbc123 Ledger!A1:C13", or a document's address in place of its id.
      const d = /^(?:\S*\/d\/)?(d[A-Za-z0-9]{4,40})\S*\s+(.+)$/.exec(value);
      if (d) spec.source = { doc: d[1], range: d[2].trim() }; else if (value) spec.source = { doc: '', range: value };
    } else if (key === 'x') spec.x = value;
    else if (key === 'y') spec.y = value.split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === 'stacked') spec.stacked = yes(value);
    else if (key === 'horizontal') spec.horizontal = yes(value);
    else if (key === 'height') { const n = Number(value); if (n >= 120 && n <= 1200) spec.height = Math.round(n); }
  }
  while (i < lines.length && lines[i].trim() === '') i++;
  const body = lines.slice(i).join('\n');
  if (spec.type === 'code') spec.code = body;
  else if (body.trim()) spec.rows = body.replace(/\n+$/, '').split('\n').map((line) => splitRow(line, body.includes('\t') ? '\t' : ','));
  return spec;
}

/** The cells of one row: between commas (or tabs), spaces around them dropped, a cell holding the separator in "quotes". */
function splitRow(line: string, sep: string): string[] {
  const out: string[] = [];
  const s = sep === '\t' ? '\\t' : sep;
  const cell = new RegExp(`\\s*(?:"((?:[^"]|"")*)"|([^${s}]*?))\\s*(${s}|$)`, 'y');
  for (let at = 0; ;) {
    cell.lastIndex = at;
    const m = cell.exec(line);
    if (!m) break;
    out.push(m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2]);
    if (!m[3]) break; // the end of the line, not a separator: no cell follows
    at = cell.lastIndex;
  }
  return out;
}

/** A chart block's text for these settings (what the Insert dialog writes). */
export function chartText(spec: Partial<ChartSpec>): string {
  const out = [`type: ${spec.type ?? 'bar'}`];
  if (spec.title) out.push(`title: ${spec.title}`);
  if (spec.source) out.push(`data: ${spec.source.doc ? `${spec.source.doc} ` : ''}${spec.source.range}`);
  if (spec.x) out.push(`x: ${spec.x}`);
  if (spec.y?.length) out.push(`y: ${spec.y.join(', ')}`);
  if (spec.stacked) out.push('stacked: yes');
  if (spec.horizontal) out.push('horizontal: yes');
  if (spec.height && spec.height !== 320) out.push(`height: ${spec.height}`);
  if (spec.type === 'code') out.push('', spec.code ?? '');
  else if (spec.rows?.length) out.push('', ...spec.rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(', ')));
  return out.join('\n');
}

const asNumber = (v: string): number | null => {
  const t = v.replace(/[,\s]/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  return Number(t);
};

/** Rows of cells (the first the headings) as a table; text that reads as a number is one. */
export function tableOf(rows: (string | number | null)[][]): Table {
  if (!rows.length) return { columns: [], rows: [] };
  const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
  const columns = Array.from({ length: width }, (_, i) => String(rows[0][i] ?? '').trim() || `Column ${i + 1}`);
  return { columns, rows: rows.slice(1).map((r) => Array.from({ length: width }, (_, i) => { const v = r[i]; return v === undefined || v === null || v === '' ? null : typeof v === 'number' ? v : asNumber(v) ?? v; })) };
}

// ------------------------------------------------------------------ what it looks like

// Eight hues in a fixed order, chosen so that neighbours stay apart for colour-blind readers; the dark column is the
// same hues stepped for a dark surface. A ninth series is not given a made-up colour: it is left out, and the chart says so.
export const CHART_COLORS: Record<Theme, string[]> = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'],
};
export const CHART_INK: Record<Theme, { text: string; muted: string; rule: string; faint: string; surface: string }> = {
  light: { text: '#1b2230', muted: '#5b6472', rule: '#d0d5dd', faint: '#eceef2', surface: '#ffffff' },
  dark: { text: '#e8eaf0', muted: '#a3abb8', rule: '#3a4150', faint: '#2a303b', surface: '#1b1f27' },
};
const MAX_SERIES = 8;
/** Dots are told apart by colour against every other colour, not only their neighbours: three is what the palette carries. */
const MAX_SCATTER = 3;
const MAX_SLICES = 8;
// No double quotes in it: the library writes it into SVG attributes as it is.
const FONT = "ui-sans-serif, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

function column(table: Table, name: string): number {
  if (!name) return -1;
  const byName = table.columns.findIndex((c) => c.toLowerCase() === name.toLowerCase());
  if (byName >= 0) return byName;
  if (/^[A-Za-z]{1,2}$/.test(name)) { let n = 0; for (const ch of name.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; if (n - 1 < table.columns.length) return n - 1; }
  return -1;
}

export type Drawn = { option: Record<string, unknown>; note: string } | { error: string };

/** The drawing options for a chart and its data. `note` says what could not be shown as asked. */
export function chartOption(spec: ChartSpec, table: Table, theme: Theme, opts: { still?: boolean; /** Write the note into the picture, under the title (where nothing else can show it). */ noteInside?: boolean } = {}): Drawn {
  if (!table.columns.length || !table.rows.length) return { error: 'This chart has no data to draw yet (the first row of its data is the headings).' };
  const ink = CHART_INK[theme], palette = CHART_COLORS[theme];
  const x = Math.max(0, column(table, spec.x));
  let ys = spec.y.length ? spec.y.map((n) => column(table, n)) : table.columns.map((_, i) => i).filter((i) => i !== x && table.rows.some((r) => typeof r[i] === 'number'));
  const unknown = spec.y.filter((_, i) => ys[i] < 0);
  if (unknown.length) return { error: `No column “${unknown[0]}”. Columns: ${table.columns.join(', ')}.` };
  if (spec.x && column(table, spec.x) < 0) return { error: `No column “${spec.x}”. Columns: ${table.columns.join(', ')}.` };
  if (!ys.length) return { error: 'None of the columns holds numbers to draw.' };
  const notes: string[] = [];
  const cap = spec.type === 'scatter' ? MAX_SCATTER : spec.type === 'pie' ? 1 : MAX_SERIES;
  if (ys.length > cap) { notes.push(spec.type === 'pie' ? `A pie draws one series: showing ${table.columns[ys[0]]} only.` : `Showing ${cap} of ${ys.length} series: ${ys.slice(cap).map((i) => table.columns[i]).join(', ')} left out.`); ys = ys.slice(0, cap); }
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  const names = table.rows.map((r) => String(r[x] ?? ''));
  const text = { color: ink.text, fontFamily: FONT, fontSize: 12 };
  const inside = opts.noteInside ? notes.join(' ') : '';
  /** Where the title (and a note under it) end. */
  const head = (spec.title ? 26 : 0) + (inside ? 16 : 0);
  const base: Record<string, unknown> = {
    color: palette, textStyle: text, animation: !opts.still, animationDuration: 250, backgroundColor: 'transparent',
    title: spec.title || inside ? { text: spec.title, subtext: inside, left: 0, top: 0, itemGap: 4, textStyle: { color: ink.text, fontFamily: FONT, fontSize: 14, fontWeight: 600 }, subtextStyle: { color: ink.muted, fontFamily: FONT, fontSize: 11 } } : undefined,
    // One series is named by the title; two or more get a legend, in ink, the colour carried by the mark beside the name.
    legend: ys.length > 1 || spec.type === 'pie' ? { type: 'scroll', top: head, left: 0, icon: spec.type === 'line' ? 'roundRect' : 'circle', itemWidth: 10, itemHeight: 10, textStyle: { color: ink.muted, fontFamily: FONT }, pageTextStyle: { color: ink.muted }, pageIconColor: ink.muted } : undefined,
  };
  const top = head + 4 + (base.legend ? 28 : 4);
  const tooltip = (trigger: 'axis' | 'item') => ({ trigger, confine: true, backgroundColor: ink.surface, borderColor: ink.rule, textStyle: { color: ink.text, fontFamily: FONT, fontSize: 12 }, axisPointer: trigger === 'axis' ? { type: 'line', lineStyle: { color: ink.rule } } : undefined });

  if (spec.type === 'pie') {
    const y = ys[0];
    let parts = table.rows.map((r, i) => ({ name: names[i], value: num(r[y]) ?? 0 })).filter((p) => p.value > 0);
    if (!parts.length) return { error: 'A pie needs positive numbers.' };
    if (parts.length > MAX_SLICES) {
      parts.sort((a, b) => b.value - a.value);
      const rest = parts.slice(MAX_SLICES - 1);
      parts = [...parts.slice(0, MAX_SLICES - 1), { name: `Other (${rest.length})`, value: rest.reduce((n, p) => n + p.value, 0) }];
    }
    return { note: notes.join(' '), option: { ...base, tooltip: tooltip('item'), series: [{ type: 'pie', name: table.columns[y], data: parts, radius: ['42%', '68%'], center: ['50%', '56%'], top, itemStyle: { borderColor: ink.surface, borderWidth: 2 }, label: { color: ink.text, fontFamily: FONT, formatter: '{b}  {d}%' }, labelLine: { lineStyle: { color: ink.rule } } }] } };
  }

  const valueAxis = { type: 'value', axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: ink.muted, fontFamily: FONT }, splitLine: { lineStyle: { color: ink.faint } } };
  const grid = { left: 4, right: 12, bottom: 4, top, containLabel: true };
  if (spec.type === 'scatter') {
    if (!table.rows.some((r) => typeof r[x] === 'number')) return { error: `A scatter needs numbers in its x column (“${table.columns[x]}” holds none).` };
    return { note: notes.join(' '), option: { ...base, grid, tooltip: tooltip('item'), xAxis: { ...valueAxis, name: table.columns[x], nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: ink.muted, fontFamily: FONT }, scale: true }, yAxis: { ...valueAxis, scale: true },
      series: ys.map((y) => ({ type: 'scatter', name: table.columns[y], symbolSize: 9, itemStyle: { borderColor: ink.surface, borderWidth: 1 }, data: table.rows.filter((r) => typeof r[x] === 'number' && typeof r[y] === 'number').map((r) => [r[x], r[y]]) })) } };
  }
  const categoryAxis = { type: 'category', data: names, boundaryGap: spec.type === 'bar', axisLine: { lineStyle: { color: ink.rule } }, axisTick: { show: false }, axisLabel: { color: ink.muted, fontFamily: FONT, hideOverlap: true } };
  const flat = spec.type === 'bar' && spec.horizontal;
  const series = ys.map((y, k) => {
    const data = table.rows.map((r) => num(r[y]));
    if (spec.type === 'bar') return {
      type: 'bar', name: table.columns[y], data, stack: spec.stacked ? 'all' : undefined, barMaxWidth: 34, barGap: '12%',
      // The end of a bar is rounded, its foot is square on the baseline; stacked segments are parted by a line of the surface.
      itemStyle: spec.stacked ? { borderColor: ink.surface, borderWidth: 1 } : { borderRadius: flat ? [0, 4, 4, 0] : [4, 4, 0, 0] },
    };
    return {
      type: 'line', name: table.columns[y], data, stack: spec.stacked ? 'all' : undefined, lineStyle: { width: 2 }, symbol: 'circle', symbolSize: 8, showSymbol: data.length <= 24, connectNulls: false,
      itemStyle: { borderColor: ink.surface, borderWidth: 2 }, emphasis: { focus: 'series' },
      areaStyle: spec.type === 'area' ? { opacity: spec.stacked ? 0.55 : 0.16, color: palette[k] } : undefined,
    };
  });
  return { note: notes.join(' '), option: { ...base, grid, tooltip: tooltip(spec.type === 'bar' ? 'item' : 'axis'), xAxis: flat ? valueAxis : categoryAxis, yAxis: flat ? { ...categoryAxis, inverse: true } : valueAxis, series } };
}
