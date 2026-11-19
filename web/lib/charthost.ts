// Charts in the page: finds the places a chart goes (a ```chart block rendered
// as .md-chart, a chart on a sheet) and fills them. Drawing is a bundle of its
// own, fetched when first needed; a chart that is code gets a sandboxed frame.

import { parseChart, tableOf, type ChartSpec, type Table, type Theme } from '../../src/chart';

let drawing: Promise<typeof import('../chartview')> | null = null;
const loadDrawing = () => { const url = '/charts.js'; return (drawing ??= (import(url) as Promise<typeof import('../chartview')>).catch((e) => { drawing = null; throw e; })); };
export const themeNow = (): Theme => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

/** A spreadsheet range's values, asked for once per half minute however often the page is drawn again. */
const fetched = new Map<string, { at: number; table: Promise<Table> }>();
function sheetData(docId: string, source: { doc: string; range: string }): Promise<Table> {
  const key = `${docId}\n${source.doc}\n${source.range}`;
  const had = fetched.get(key);
  if (had && Date.now() - had.at < 30_000) return had.table;
  for (const [k, v] of fetched) if (Date.now() - v.at >= 30_000) fetched.delete(k);
  const table = fetch(`/api/docs/${encodeURIComponent(docId)}/chart-data?doc=${encodeURIComponent(source.doc)}&range=${encodeURIComponent(source.range)}`, { headers: { Accept: 'application/json' } })
    .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ?? 'The chart’s data could not be read.'); return j as Table; });
  table.catch(() => fetched.delete(key));
  fetched.set(key, { at: Date.now(), table });
  return table;
}

const note = (el: HTMLElement, text: string) => { el.replaceChildren(Object.assign(document.createElement('div'), { className: 'md-chart-note', textContent: text })); };

/** A sandboxed frame running a chart's code. */
function codeFrame(el: HTMLElement, spec: ChartSpec, text: string, table: Table | null, error?: string): () => void {
  const frame = document.createElement('iframe');
  frame.className = 'md-chart-frame';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.title = spec.title || 'Chart';
  frame.style.height = `${spec.height}px`;
  frame.src = '/chart-frame';
  // Answered once: whatever the frame holds after that (the code may send it elsewhere) is not handed the data again.
  const onMessage = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow || e.data?.anima !== 'chart-ready') return;
    removeEventListener('message', onMessage);
    frame.contentWindow?.postMessage({ anima: 'chart', text, table, theme: themeNow(), error }, '*');
  };
  addEventListener('message', onMessage);
  el.replaceChildren(frame);
  return () => removeEventListener('message', onMessage);
}

/**
 * Fill `el` with the chart `text` describes. `table` is its data when the caller has it (a chart on a sheet);
 * otherwise the rows in the text, or the spreadsheet range it names, read through document `docId`.
 */
export function mountChart(el: HTMLElement, text: string, ctx: { docId?: string; table?: Table | null } = {}): () => void {
  const spec = parseChart(text);
  let dispose = () => undefined as void, gone = false;
  el.style.minHeight = `${spec.height}px`;
  const data: Promise<Table | null> = ctx.table !== undefined ? Promise.resolve(ctx.table)
    : spec.source?.doc ? (ctx.docId ? sheetData(ctx.docId, spec.source) : Promise.reject(new Error('This chart draws from a spreadsheet; open the document to see it.')))
      : Promise.resolve(spec.rows.length ? tableOf(spec.rows) : null);
  if (spec.type === 'code') {
    data.then((table) => { if (!gone) dispose = codeFrame(el, spec, text, table); }, (e: Error) => { if (!gone) dispose = codeFrame(el, spec, text, null, e.message); });
  } else {
    Promise.all([data, loadDrawing()]).then(([table, m]) => { if (!gone) { el.style.minHeight = ''; dispose = m.draw(el, spec, table ?? { columns: [], rows: [] }, themeNow()); } }, (e: Error) => { if (!gone) note(el, e.message); });
  }
  // A chart of a spreadsheet range follows the spreadsheet: asked again every minute while it is on a visible page.
  let last = '';
  const again = spec.source?.doc && ctx.docId && ctx.table === undefined ? window.setInterval(() => {
    if (gone || !el.isConnected) { clearInterval(again); return; }
    if (document.visibilityState !== 'visible') return;
    sheetData(ctx.docId!, spec.source!).then((table) => {
      const now = JSON.stringify(table);
      if (gone || now === (last ||= now)) return;
      last = now;
      dispose();
      if (spec.type === 'code') dispose = codeFrame(el, spec, text, table);
      else void loadDrawing().then((m) => { if (!gone) dispose = m.draw(el, spec, table, themeNow()); });
    }, () => undefined);
  }, 60_000) : 0;
  return () => { gone = true; clearInterval(again); dispose(); };
}

/** Fill every chart placeholder under `root` (what a rendered ```chart block leaves). Returns what removes them. */
export function hydrateCharts(root: ParentNode, docId?: string): () => void {
  const disposers: (() => void)[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('.md-chart[data-chart]')) {
    const text = el.dataset.chart ?? '';
    el.removeAttribute('data-chart');
    disposers.push(mountChart(el, text, { docId }));
  }
  return () => { for (const d of disposers) d(); };
}
