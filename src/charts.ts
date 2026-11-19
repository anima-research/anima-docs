// Charts in the server: where a chart's data may be read from, and charts as
// finished pictures for published pages.
//
// A chart block in a document may draw from a range of a spreadsheet. Whoever
// can read the document then sees that range, whether or not they can open the
// spreadsheet: the person who wrote the reference could, and put it there, as
// with a mounted section. So a reference counts only if its writer could read
// the spreadsheet at the moment they wrote it: that is recorded here
// (chart_sources), per document, and taken away when the reference goes.

import type { DB } from './db.js';
import { Fault } from './auth.js';
import type { Documents, DocChange } from './documents.js';
import type { Nodes } from './nodes.js';
import type { Actor } from './principals.js';
import type { Sheets } from './sheets.js';
import { chartSources, parseChart, tableOf, type Table } from './chart.js';
import { chartSvg, messageSvg } from './chartsvg.js';

type Source = { doc: string; range: string };
/** The most a chart's data may weigh in the address of a frame on a published page. */
const MAX_FRAME_PAYLOAD = 150_000;
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export class Charts {
  /** Documents that hold a recorded reference (so that its removal is noticed). */
  private known = new Set<string>();

  constructor(private db: DB, private docs: Documents, private sheets: Sheets, private nodes: Nodes, private origin: () => string) {
    docs.on('loaded', (e: { docId: string }) => { if (this.db.prepare('SELECT 1 FROM chart_sources WHERE doc_id = ? LIMIT 1').get(e.docId)) this.known.add(e.docId); });
    docs.on('change', (c: DocChange) => { try { this.onChange(c); } catch (e) { console.error('[charts] scan failed:', e); } });
    docs.on('meta', (e: { docId: string; kind: string }) => { if (e.kind === 'deleted') { this.db.prepare('DELETE FROM chart_sources WHERE doc_id = ?').run(e.docId); this.known.delete(e.docId); } });
  }

  /** After each change to a text: which spreadsheet ranges its chart blocks name now. New ones count if the person who made the change can read the spreadsheet. */
  private onChange(c: DocChange) {
    const text = this.docs.ydoc(c.docId).getText('body').toString(); // a spreadsheet's own body is empty
    const has = text.includes('```chart');
    if (!has && !this.known.has(c.docId)) return;
    const sources = has ? chartSources(text) : [];
    const key = (s: Source) => `${s.doc}\n${s.range}`;
    const now = new Map(sources.map((s) => [key(s), s]));
    const had = new Set((this.db.prepare('SELECT source_id, range FROM chart_sources WHERE doc_id = ?').all(c.docId) as { source_id: string; range: string }[]).map((r) => `${r.source_id}\n${r.range}`));
    for (const k of had) if (!now.has(k)) { const [source, range] = k.split('\n'); this.db.prepare('DELETE FROM chart_sources WHERE doc_id = ? AND source_id = ? AND range = ?').run(c.docId, source, range); }
    for (const [k, s] of now) {
      if (had.has(k) || !this.docs.isSheet(s.doc) || !this.docs.role(s.doc, { sub: c.origin.sub, admin: false })) continue;
      this.db.prepare('INSERT OR IGNORE INTO chart_sources (doc_id, source_id, range, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)').run(c.docId, s.doc, s.range, c.origin.sub, Date.now());
    }
    if (this.db.prepare('SELECT 1 FROM chart_sources WHERE doc_id = ? LIMIT 1').get(c.docId)) this.known.add(c.docId); else this.known.delete(c.docId);
  }

  /** Whether one of these documents holds a counted reference to this range. */
  private granted(docIds: Iterable<string>, s: Source): boolean {
    const q = this.db.prepare('SELECT 1 FROM chart_sources WHERE doc_id = ? AND source_id = ? AND range = ?');
    for (const id of docIds) if (q.get(id, s.doc, s.range)) return true;
    return false;
  }

  /** The spreadsheets that charts in these documents draw from (a published page is as new as they are). */
  sourcesOf(docIds: Iterable<string>): string[] {
    const q = this.db.prepare('SELECT DISTINCT source_id FROM chart_sources WHERE doc_id = ?');
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

  /** The data of a chart in document `docId` that draws from a spreadsheet, for a reader of that document. */
  data(docId: string, actor: Actor, source: Source): Table {
    this.docs.require(docId, actor, 'viewer');
    const direct = this.docs.get(source.doc) && this.docs.role(source.doc, actor);
    if (!direct && !this.granted(this.family(docId), source)) throw new Fault(404, 'This chart’s data is not available: the spreadsheet is not shared with you, and was not open to whoever placed the chart.');
    if (!this.docs.isSheet(source.doc)) throw new Fault(404, 'A chart draws from a spreadsheet; that document is not one.');
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
        if (!this.granted(nodes, spec.source) || !this.docs.isSheet(spec.source.doc)) throw new Fault(404, 'This chart’s spreadsheet was not open to whoever placed the chart.');
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
