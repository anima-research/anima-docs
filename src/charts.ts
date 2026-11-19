// Charts in the server: where a chart's data may be read from, and charts as
// finished pictures for published pages.
//
// A chart block in a document may draw from a range of a spreadsheet. Whoever
// can read the document then sees that range, whether or not they can open the
// spreadsheet, as with a mounted section. Three rules keep that from opening
// anything by accident:
//
// - A block is granted by someone writing its data line: a change made by
//   hand (typed, pasted, an agent's edit) that puts text into that line, by
//   an author who can read the spreadsheet at that moment. A block that comes
//   to be a chart any other way (a fence opened or closed around it, an
//   accepted suggestion, a split, a merge, a restore) is not granted by it.
// - A grant belongs to its block: it is anchored at the block's data line,
//   holds for the sheet the range meant when it was given, and ends when that
//   line goes or names something else.
// - A chart is given only what its document was granted, never what the
//   person looking at it could open themselves. A chart may be code written
//   by someone else, and code can pass on what it is handed; so it is handed
//   only what every reader of the document may see anyway.

import * as Y from 'yjs';
import MarkdownIt from 'markdown-it';
import type { DB } from './db.js';
import { Fault } from './auth.js';
import type { Documents, DocChange } from './documents.js';
import type { Nodes } from './nodes.js';
import type { Actor } from './principals.js';
import type { Sheets } from './sheets.js';
import { parseChart, tableOf, type Table } from './chart.js';
import { chartSvg, messageSvg } from './chartsvg.js';

type Source = { doc: string; range: string };
/** Finds the fenced blocks of a text exactly as the renderers do (a ```chart inside a longer fence is not one). */
const fences = new MarkdownIt();
const SETTING = /^\s*([A-Za-z]+)\s*:/;
/** The chart blocks of a text that name a spreadsheet, each with where its data line lies ([from, to] in the text). */
function chartBlocks(markdown: string): { source: Source; from: number; to: number }[] {
  const out: { source: Source; from: number; to: number }[] = [];
  let starts: number[] | null = null;
  for (const t of fences.parse(markdown, {})) {
    if (t.type !== 'fence' || !t.map || (t.info || '').trim().split(/\s+/)[0] !== 'chart') continue;
    const source = parseChart(t.content).source;
    if (!source?.doc) continue;
    // The data line is among the settings at the top of the block (the first line that is not a setting ends them).
    const lines = t.content.split('\n');
    let k = 0;
    while (k < lines.length && SETTING.test(lines[k]) && SETTING.exec(lines[k])![1].toLowerCase() !== 'data') k++;
    if (!starts) { starts = [0]; for (let i = markdown.indexOf('\n'); i >= 0; i = markdown.indexOf('\n', i + 1)) starts.push(i + 1); }
    const line = t.map[0] + 1 + k;
    const from = starts[line] ?? markdown.length;
    out.push({ source, from, to: (starts[line + 1] ?? markdown.length + 1) - 1 });
  }
  return out;
}
/** How deep a document's mounted nodes count as its own (documents.ts derives access through as many levels). */
const FAMILY_DEPTH = 12;
/** The most a chart's data may weigh in the address of a frame on a published page. */
const MAX_FRAME_PAYLOAD = 150_000;
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export class Charts {
  constructor(private db: DB, private docs: Documents, private sheets: Sheets, private nodes: Nodes, private origin: () => string) {
    docs.on('change', (c: DocChange) => { try { this.onChange(c); } catch (e) { console.error('[charts] scan failed:', e); } });
    docs.on('meta', (e: { docId: string; kind: string }) => { if (e.kind === 'deleted') this.db.prepare('DELETE FROM chart_sources WHERE doc_id = ?').run(e.docId); });
  }

  /** After each change to a text: grants whose block is gone end; a block whose data line this change wrote may be granted. */
  private onChange(c: DocChange) {
    const doc = this.docs.ydoc(c.docId);
    const ytext = doc.getText('body'); // a spreadsheet's own body is empty
    const text = ytext.toString();
    const rows = this.db.prepare('SELECT id, source_id, range, anchor FROM chart_sources WHERE doc_id = ?').all(c.docId) as { id: number; source_id: string; range: string; anchor: Buffer }[];
    if (!rows.length && !text.includes('chart')) return;
    const blocks = chartBlocks(text);
    // A grant lives while its anchor is in the data line of a block that still names the same range.
    const granted = new Set<number>();
    for (const r of rows) {
      const at = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(r.anchor), doc)?.index;
      const i = at === undefined ? -1 : blocks.findIndex((b) => b.source.doc === r.source_id && b.source.range === r.range && at >= b.from && at <= b.to);
      if (i < 0) this.db.prepare('DELETE FROM chart_sources WHERE id = ?').run(r.id); else granted.add(i);
    }
    // Written by hand: not the service acting for someone (a restore, an accepted suggestion, a split or a merge carry a label).
    if (c.origin.label) return;
    const written = c.ranges.filter(([from, to]) => to > from);
    blocks.forEach((b, i) => {
      if (granted.has(i) || !written.some(([from, to]) => from <= b.to && to >= b.from)) return;
      if (!this.docs.isSheet(b.source.doc) || !this.docs.role(b.source.doc, { sub: c.origin.sub, admin: false })) return;
      const sheet = this.sheetOf(b.source);
      if (!sheet) return;
      this.db.prepare('INSERT INTO chart_sources (doc_id, source_id, range, sheet_id, anchor, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(c.docId, b.source.doc, b.source.range, sheet, Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, b.from))), c.origin.sub, Date.now());
    });
  }

  /** The sheet a range means right now ('' if it means none). */
  private sheetOf(s: Source): string {
    try { return this.sheets.sheetOf(s.doc, s.range); } catch { return ''; }
  }

  /**
   * Whether one of these documents was granted this range. A grant is for the sheet the range meant when it was
   * given: if the same words mean another sheet now (a sheet renamed, added in front, or named like the range), it does not hold.
   */
  private granted(docIds: Iterable<string>, s: Source): boolean {
    const q = this.db.prepare('SELECT sheet_id FROM chart_sources WHERE doc_id = ? AND source_id = ? AND range = ?');
    let sheet: string | null = null;
    for (const id of docIds) for (const row of q.all(id, s.doc, s.range) as { sheet_id: string }[]) if (row.sheet_id === (sheet ??= this.sheetOf(s))) return true;
    return false;
  }

  /** The spreadsheets that charts in these documents draw from (a published page is as new as they are). */
  sourcesOf(docIds: Iterable<string>): string[] {
    const q = this.db.prepare('SELECT DISTINCT source_id FROM chart_sources WHERE doc_id = ?');
    const out = new Set<string>();
    for (const id of docIds) for (const r of q.all(id) as { source_id: string }[]) out.add(r.source_id);
    return [...out].sort();
  }

  /** A document and the nodes mounted in it, as deep as access itself is carried through mounts (a chart may sit in a section). */
  private family(docId: string): Set<string> {
    const seen = new Set<string>([docId]);
    let level = [docId];
    for (let depth = 0; depth < FAMILY_DEPTH && level.length && seen.size < 2000; depth++) {
      const next: string[] = [];
      for (const id of level) for (const c of this.nodes.childrenOf(id)) if (!seen.has(c.child)) { seen.add(c.child); next.push(c.child); }
      level = next;
    }
    return seen;
  }

  /**
   * The data of a chart in document `docId` that draws from a spreadsheet, for a reader of that document: what the
   * document was granted, and nothing on the strength of the reader's own access to the spreadsheet.
   */
  data(docId: string, actor: Actor, source: Source): Table {
    this.docs.require(docId, actor, 'viewer');
    if (!this.granted(this.family(docId), source) || !this.docs.isSheet(source.doc)) throw new Fault(404, 'This chart’s data is not available: the spreadsheet was not open to whoever wrote the chart’s data line. Someone who can open it can write the line again.');
    return tableOf(this.sheets.values(source.doc, source.range));
  }

  /**
   * A ```chart block of a published page as HTML that needs nothing from the reader's browser: a picture, or for a
   * chart that is code a sandboxed frame carrying its text and data. `nodes` are the documents the page is made of.
   */
  html(text: string, nodes: Iterable<string>): string {
    const spec = parseChart(text);
    let table: Table | null = spec.rows.length ? tableOf(spec.rows) : null, error = '';
    if (spec.source?.doc) {
      try {
        if (!this.granted(nodes, spec.source) || !this.docs.isSheet(spec.source.doc)) throw new Fault(404, 'This chart’s spreadsheet was not open to whoever wrote its data line.');
        table = tableOf(this.sheets.values(spec.source.doc, spec.source.range));
      } catch (e) { error = e instanceof Fault ? e.message : 'This chart’s data could not be read.'; }
    }
    const alt = escapeHtml(spec.title || 'Chart');
    if (spec.type === 'code' && !error) {
      const payload = Buffer.from(JSON.stringify({ text, table, theme: 'light' })).toString('base64url');
      if (payload.length <= MAX_FRAME_PAYLOAD) return `<iframe class="md-chart-frame" sandbox="allow-scripts" loading="lazy" title="${alt}" style="width:100%;height:${spec.height}px;border:0" src="${escapeHtml(this.origin())}/chart-frame#${payload}"></iframe>\n`;
      error = 'This chart has too much data to be drawn by code on a published page.';
    }
    const svg = error ? messageSvg(spec.title, error, { background: true }) : chartSvg(spec, table ?? { columns: [], rows: [] }, { background: true });
    return `<img class="md-chart-img" alt="${alt}" style="max-width:100%;height:auto;border-radius:8px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">\n`;
  }
}
