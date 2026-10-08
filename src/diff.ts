// "What changed since you last looked" — rendered for a model.
//
// Uses Yjs snapshot rendering: toDelta(current, baseline) yields the text with
// every inserted/removed run marked and identified by its Yjs item id. The
// inserter of an item is its client id's owner; the deleter comes from the
// deletion log. The result is a compact unified diff with section labels and
// per-hunk authors.

import * as Y from 'yjs';
import { structuredPatch } from 'diff';
import type { Documents } from './documents.js';
import type { Principals } from './principals.js';
import { lineStarts, lineOf, outline, sectionPath } from './markdown.js';

export interface ChangeSummary {
  changed: boolean;
  text: string;
  authors: string[];   // subs
  hunks: number;
  added: number;
  removed: number;
}

interface Run { from: number; to: number; sub: string | null }

export function textChanges(docs: Documents, principals: Principals, docId: string, base: Y.Snapshot, opts: {
  title: string; maxChars?: number; context?: number;
  /** Compare against this later state instead of now. */
  to?: Y.Snapshot;
  /** How the header describes the span (default "changed since you last looked"). */
  what?: string;
}): ChangeSummary {
  const doc = docs.ydoc(docId);
  const ytext = doc.getText('body');
  const now = opts.to ?? Y.snapshot(doc);
  const what = opts.what ?? 'changed since you last looked';
  const delta = ytext.toDelta(now, base, (type: 'added' | 'removed', id: Y.ID) => ({ type, client: id.client, clock: id.clock })) as
    { insert: unknown; attributes?: { ychange?: { type: 'added' | 'removed'; client: number; clock: number } } }[];

  let before = '', after = '';
  const removedRuns: Run[] = [], addedRuns: Run[] = [];
  let added = 0, removed = 0;
  for (const op of delta) {
    if (typeof op.insert !== 'string') continue;
    const s = op.insert;
    const yc = op.attributes?.ychange;
    if (!yc) { before += s; after += s; continue; }
    if (yc.type === 'added') {
      addedRuns.push({ from: after.length, to: after.length + s.length, sub: docs.ownerOfClient(docId, yc.client) });
      after += s; added += s.length;
    } else {
      removedRuns.push({ from: before.length, to: before.length + s.length, sub: docs.deleterOf(docId, yc.client, yc.clock) });
      before += s; removed += s.length;
    }
  }
  if (before === after) return { changed: false, text: '', authors: [], hunks: 0, added: 0, removed: 0 };

  const patch = structuredPatch('before', 'after', before, after, '', '', { context: opts.context ?? 2, timeout: 500 } as any) as ReturnType<typeof structuredPatch> | undefined;
  if (!patch) return summarizeLarge(principals, docId, opts.title, after, addedRuns, removedRuns, added, removed, what);
  const beforeStarts = lineStarts(before), afterStarts = lineStarts(after);
  const heads = outline(after);
  const allAuthors = new Set<string>();
  const sections: string[] = [];
  const blocks: string[] = [];

  const authorsIn = (runs: Run[], starts: number[], firstLine: number, lastLine: number, into: Set<string>) => {
    if (lastLine < firstLine) return;
    const from = starts[firstLine - 1] ?? 0;
    const to = lastLine < starts.length ? starts[lastLine] : Number.MAX_SAFE_INTEGER;
    for (const r of runs) if (r.to > from && r.from < to) into.add(r.sub ?? '?');
  };

  for (const h of patch.hunks) {
    const who = new Set<string>();
    let oldLine = h.oldStart, newLine = h.newStart;
    let firstChangedNew = -1;
    const body: string[] = [];
    for (const line of h.lines) {
      const tag = line[0];
      if (tag === '\\') continue; // "\ No newline at end of file"
      body.push(line);
      if (tag === '-') { authorsIn(removedRuns, beforeStarts, oldLine, oldLine, who); oldLine++; if (firstChangedNew < 0) firstChangedNew = newLine; }
      else if (tag === '+') { authorsIn(addedRuns, afterStarts, newLine, newLine, who); if (firstChangedNew < 0) firstChangedNew = newLine; newLine++; }
      else { oldLine++; newLine++; }
    }
    const anchorLine = Math.max(1, Math.min(firstChangedNew < 0 ? h.newStart : firstChangedNew, afterStarts.length));
    const path = sectionPath(heads, afterStarts[anchorLine - 1] ?? 0);
    const section = path.length ? path[path.length - 1] : '(top)';
    if (!sections.includes(section)) sections.push(section);
    who.forEach((w) => allAuthors.add(w));
    const names = [...who].map((s) => (s === '?' ? 'someone' : principals.label(s))).join(', ') || 'someone';
    const span = h.newLines <= 1 ? `line ${h.newStart}` : `lines ${h.newStart}–${h.newStart + h.newLines - 1}`;
    blocks.push(`@@ ${section} · ${span} · ${names}\n${body.join('\n')}`);
  }

  const authorLabels = [...allAuthors].filter((a) => a !== '?').map((s) => {
    const p = principals.get(s);
    return p ? `${principals.label(s)} (${p.kind})` : s;
  });
  const header = `“${opts.title}” (${docId}) ${what} — ${patch.hunks.length} change${patch.hunks.length === 1 ? '' : 's'}`
    + (authorLabels.length ? ` by ${authorLabels.join(', ')}` : '') + ` (+${added}/−${removed} chars):`;

  const max = opts.maxChars ?? 6000;
  let out = header;
  let shown = 0;
  for (const b of blocks) {
    if (out.length + b.length + 2 > max && shown > 0) break;
    out += `\n\n${b.length > max ? `${b.slice(0, max - 200)}\n… (hunk truncated)` : b}`;
    shown++;
  }
  if (shown < blocks.length) {
    out += `\n\n… ${blocks.length - shown} more change${blocks.length - shown === 1 ? '' : 's'} not shown (sections: ${sections.join(', ')}). Use read_document to see the current text.`;
  }
  return {
    changed: true, text: out, authors: [...allAuthors].filter((a) => a !== '?'), hunks: patch.hunks.length, added, removed,
  };
}

/** Too large to diff line-by-line in bounded time: say who changed which sections, and how much. */
function summarizeLarge(principals: Principals, docId: string, title: string, after: string, addedRuns: Run[], removedRuns: Run[], added: number, removed: number, what = 'changed since you last looked'): ChangeSummary {
  const heads = outline(after);
  const bySection = new Map<string, { add: number; who: Set<string> }>();
  for (const r of addedRuns) {
    const path = sectionPath(heads, r.from);
    const key = path.length ? path[path.length - 1] : '(top)';
    const e = bySection.get(key) ?? { add: 0, who: new Set<string>() };
    e.add += r.to - r.from; e.who.add(r.sub ?? '?');
    bySection.set(key, e);
  }
  const authors = new Set([...addedRuns, ...removedRuns].map((r) => r.sub).filter((s): s is string => !!s));
  const names = (subs: Iterable<string>) => [...subs].map((s) => (s === '?' ? 'someone' : principals.label(s))).join(', ');
  const lines = [...bySection].slice(0, 40).map(([sec, e]) => `• ${sec}: +${e.add} chars by ${names(e.who)}`);
  const text = `“${title}” (${docId}) ${what}, substantially (+${added}/−${removed} chars by ${names(authors) || 'someone'}). Too large to show as a diff; sections with new text:\n${lines.join('\n') || '(only deletions)'}\nUse read_document to see the current text.`;
  return { changed: true, text, authors: [...authors], hunks: 0, added, removed };
}

/** Line count + outline, for an agent seeing a document for the first time. */
export function firstLook(text: string, title: string, docId: string): string {
  const starts = lineStarts(text);
  const heads = outline(text);
  const outlineText = heads.length
    ? heads.slice(0, 30).map((h) => `${'  '.repeat(h.level - 1)}- ${h.text} (line ${h.line})`).join('\n') + (heads.length > 30 ? `\n  … ${heads.length - 30} more headings` : '')
    : '(no headings)';
  return `“${title}” (${docId}) — ${starts.length} lines, ${text.length} chars. You have not read it yet; outline:\n${outlineText}`;
}

export { lineOf };
