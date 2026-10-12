// Fast completion of documents: `[[` links to one, `{{` mounts one inline.
//
// `[[Title` → `[Title](/d/<id>)`. `{{Title` → a `{{node:<id>}}` line (a mount
// is a whole line, so the marker gets its own). Candidates are the documents
// you can open, fetched once and filtered as you type.

import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import { api, type DocSummary } from '../lib/api';

const CACHE_MS = 20_000;
let cache: { at: number; docs: DocSummary[] } | null = null;
let inflight: Promise<DocSummary[]> | null = null;

async function documents(): Promise<DocSummary[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.docs;
  if (!inflight) {
    inflight = api.docs().then((r) => { cache = { at: Date.now(), docs: r.docs }; return r.docs; }).finally(() => { inflight = null; });
  }
  return inflight;
}
/** A document was just created or renamed: refetch next time. */
export function forgetDocuments() { cache = null; }

// `from` is where the typed query starts (after the two opening brackets); the brackets go too.
function applyLink(view: EditorView, c: Completion, from: number, to: number) {
  const title = (c.label || 'Untitled').replace(/[[\]]/g, ' ').trim();
  const text = `[${title}](/d/${c.detail!})`;
  view.dispatch({ changes: { from: from - 2, to, insert: text }, selection: { anchor: from - 2 + text.length }, userEvent: 'input.complete' });
}

function applyMount(view: EditorView, c: Completion, from0: number, to: number, aside = false) {
  const from = from0 - 2;
  const line = view.state.doc.lineAt(from);
  const before = view.state.sliceDoc(line.from, from), after = view.state.sliceDoc(to, line.to);
  // The marker takes a whole line: push any text around it onto lines of its own.
  const text = `${before.trim() ? '\n' : ''}{{node:${c.detail!}${aside ? '|aside' : ''}}}${after.trim() ? '\n' : ''}`;
  const dFrom = before.trim() ? from : line.from, dTo = after.trim() ? to : line.to;
  view.dispatch({ changes: { from: dFrom, to: dTo, insert: text }, selection: { anchor: dFrom + text.length }, userEvent: 'input.complete' });
}

export function documentCompletions(opts: { currentId: () => string; canMount: () => boolean }) {
  const source = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const m = ctx.matchBefore(/(\[\[|\{\{)([^\]}\n]*)$/);
    if (!m) return null;
    const kind = m.text.startsWith('[[') ? 'link' : 'mount';
    if (kind === 'mount' && !opts.canMount()) return null;
    const docs = await documents();
    const me = opts.currentId();
    const options: Completion[] = docs
      .filter((d) => d.title && (kind === 'link' || d.id !== me))
      .flatMap((d) => {
        if (kind === 'link') return [{ label: d.title, detail: d.id, type: 'text', info: `Link to: ${d.title} · ${d.role}`, apply: (view: EditorView, c: Completion, from: number, to: number) => applyLink(view, c, from, to) }];
        return [
          { label: d.title, detail: d.id, type: 'class', info: `Mount inline: ${d.title} · ${d.role}`, apply: (view: EditorView, c: Completion, from: number, to: number) => applyMount(view, c, from, to, false) },
          { label: `${d.title} (aside)`, detail: d.id, type: 'class', boost: -1, info: `Mount as a sidebar panel (an aside in the wiki): ${d.title}`, apply: (view: EditorView, c: Completion, from: number, to: number) => applyMount(view, c, from, to, true) },
        ];
      });
    return { from: m.from + 2, to: ctx.pos, options, validFor: /^[^\]}\n]*$/, filter: true };
  };
  return autocompletion({ override: [source], activateOnTyping: true, icons: false, maxRenderedOptions: 12, defaultKeymap: true, closeOnBlur: true });
}
