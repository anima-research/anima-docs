// Charts in the server: where a chart's data may be read from, and charts as
// finished pictures for published pages.
//
// A chart block in a document may draw from a range of a spreadsheet. Whoever
// can read the document then sees that range, whether or not they can open the
// spreadsheet, as with a mounted section. Two rules keep that from opening
// anything by accident:
//
// - A reference is judged once, by the change that brings it into the text:
//   it is granted if that change's author could read the spreadsheet then.
//   Nobody's later edit elsewhere in the document grants it for them; a
//   reference taken out and put back is judged again; and someone who can
//   read the spreadsheet grants a range by writing a block that names it
//   themselves (also when another block already named it in vain).
// - A chart is given only what its document was granted, never what the
//   person looking at it could open themselves. A chart may be code written
//   by someone else, and code can pass on what it is handed; so it is handed
//   only what every reader of the document may see anyway.

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
function chartSources(markdown: string): Source[] {
  const out: Source[] = [];
  for (const t of fences.parse(markdown, {})) {
    if (t.type !== 'fence' || (t.info || '').trim().split(/\s+/)[0] !== 'chart') continue;
    const s = parseChart(t.content).source;
    if (s?.doc) out.push(s);
  }
  return out;
}
/** The most a chart's data may weigh in the address of a frame on a published page. */
const MAX_FRAME_PAYLOAD = 150_000;
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export class Charts {
  /** Documents that hold a recorded reference (so that its removal is noticed). */
  private known = new Set<string>();

  constructor(private db: DB, private docs: Documents, private sheets: Sheets, private nodes: Nodes, private origin: () => string) {
    docs.on('loaded', (e: { docId: string }) => { if (this.db.prepare('SELECT 1 FROM chart_sources WHERE doc_id = ? LIMIT 1').get(e.docId)) this.known.add(e.docId); });
    docs.on('change', (c: DocChange) => { try { this.onChange(c); } catch (e) { console.error('[charts] scan failed:', e); } });
    docs.on('unloaded', (e: { docId: string }) => this.known.delete(e.docId));
    docs.on('meta', (e: { docId: string; kind: string }) => { if (e.kind === 'deleted') { this.db.prepare('DELETE FROM chart_sources WHERE doc_id = ?').run(e.docId); this.known.delete(e.docId); } });
  }

  /**
   * After each change to a text: which spreadsheet ranges its chart blocks name now. A reference that was not
   * there before this change is this change's: granted if its author can read the spreadsheet, recorded as
   * refused if not, and in either case not judged again while it stays.
   */
  private onChange(c: DocChange) {
    const text = this.docs.ydoc(c.docId).getText('body').toString(); // a spreadsheet's own body is empty
    const has = text.includes('chart');
    if (!has && !this.known.has(c.docId)) return;
    const sources = has ? chartSources(text) : [];
    const key = (s: Source) => `${s.doc}\n${s.range}`;
    const now = new Map<string, { s: Source; n: number }>();
    for (const s of sources) { const e = now.get(key(s)); if (e) e.n++; else now.set(key(s), { s, n: 1 }); }
    const had = new Map((this.db.prepare('SELECT source_id, range, n, granted_by FROM chart_sources WHERE doc_id = ?').all(c.docId) as { source_id: string; range: string; n: number; granted_by: string }[]).map((r) => [`${r.source_id}\n${r.range}`, r]));
    for (const [k, r] of had) if (!now.has(k)) this.db.prepare('DELETE FROM chart_sources WHERE doc_id = ? AND source_id = ? AND range = ?').run(c.docId, r.source_id, r.range);
    for (const [k, { s, n }] of now) {
      const was = had.get(k);
      if (was && was.n === n) continue;
      // One more block names this range than before: this change's author wrote it, and it is theirs to be judged by.
      // (One block fewer changes nothing but the count: what was granted stays while a block still names it.)
      const added = !was || n > was.n;
      const may = added && this.docs.isSheet(s.doc) && !!this.docs.role(s.doc, { sub: c.origin.sub, admin: false });
      if (!was) this.db.prepare('INSERT OR IGNORE INTO chart_sources (doc_id, source_id, range, sheet_id, n, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(c.docId, s.doc, s.range, may ? this.sheetOf(s) : '', n, may ? c.origin.sub : '', Date.now());
      else if (may && !was.granted_by) this.db.prepare('UPDATE chart_sources SET n = ?, sheet_id = ?, granted_by = ?, granted_at = ? WHERE doc_id = ? AND source_id = ? AND range = ?').run(n, this.sheetOf(s), c.origin.sub, Date.now(), c.docId, s.doc, s.range);
      else this.db.prepare('UPDATE chart_sources SET n = ? WHERE doc_id = ? AND source_id = ? AND range = ?').run(n, c.docId, s.doc, s.range);
    }
    if (now.size) this.known.add(c.docId); else this.known.delete(c.docId);
  }

  /** The sheet a range means right now ('' if it means none). */
  private sheetOf(s: Source): string {
    try { return this.sheets.sheetOf(s.doc, s.range); } catch { return ''; }
  }

  /**
   * Whether one of these documents was granted this range. The grant is for the sheet the range meant when it was
   * written: if the same words mean another sheet now (a sheet renamed, added in front, or named like the range), it does not hold.
   */
  private granted(docIds: Iterable<string>, s: Source): boolean {
    const q = this.db.prepare("SELECT sheet_id FROM chart_sources WHERE doc_id = ? AND source_id = ? AND range = ? AND granted_by != ''");
    let sheet: string | null = null;
    for (const id of docIds) {
      const row = q.get(id, s.doc, s.range) as { sheet_id: string } | undefined;
      if (row && row.sheet_id && row.sheet_id === (sheet ??= this.sheetOf(s))) return true;
    }
    return false;
  }

  /** The spreadsheets that charts in these documents draw from (a published page is as new as they are). */
  sourcesOf(docIds: Iterable<string>): string[] {
    const q = this.db.prepare("SELECT DISTINCT source_id FROM chart_sources WHERE doc_id = ? AND granted_by != ''");
    const out = new Set<string>();
    for (const id of docIds) for (const r of q.all(id) as { source_id: string }[]) out.add(r.source_id);
    return [...out].sort();
  }

  /** A document and every node mounted in it, however deep (a chart may sit in a section). */
  private family(docId: string): Set<string> {
    const seen = new Set<string>(), stack = [docId];
    while (stack.length && seen.size < 2000) { const id = stack.pop()!; if (seen.has(id)) continue; seen.add(id); for (const c of this.nodes.childrenOf(id)) stack.push(c.child); }
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
