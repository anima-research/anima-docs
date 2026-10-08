// "What changed since you last looked" — rendered for a model.
//
// Uses Yjs snapshot rendering: toDelta(current, baseline) yields the text with
// every inserted/removed run marked and identified by its Yjs item id. The
// inserter of an item is its client id's owner; the deleter comes from the
// deletion log. The result is a compact unified diff with section labels and
// per-hunk authors.

import * as Y from 'yjs';
import { diffWordsWithSpace, structuredPatch } from 'diff';
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

/** Unchanged text kept on each side of a change in a word-marked line. */
const WORD_CONTEXT = 60;
/** Context lines (unchanged paragraphs around a hunk) are clipped to this. */
const CONTEXT_LINE_MAX = 140;

interface Part { value: string; added?: boolean; removed?: boolean }

/**
 * Word diff with spacing-only matches folded into the change, so a reworded
 * phrase reads as one replacement rather than interleaved fragments.
 */
function wordParts(a: string, b: string): Part[] | null {
  if (a.length + b.length > 40_000) return null;
  const parts = diffWordsWithSpace(a, b, { timeout: 100 }) as Part[] | undefined;
  if (!parts) return null;
  const out: Part[] = [];
  let del = '', ins = '';
  const flush = () => { if (del) out.push({ value: del, removed: true }); if (ins) out.push({ value: ins, added: true }); del = ins = ''; };
  parts.forEach((p, i) => {
    if (p.added) { ins += p.value; return; }
    if (p.removed) { del += p.value; return; }
    if ((del || ins) && i < parts.length - 1 && !p.value.includes('\n') && (!p.value.trim() || p.value.length <= 2)) { del += p.value; ins += p.value; return; }
    flush();
    out.push(p);
  });
  flush();
  return out;
}

/** Trim to whole words: the end of `s` (keeping about n chars), or its start. */
const tailWords = (s: string, n: number) => { if (s.length <= n) return s; const cut = s.slice(-n); const sp = cut.search(/\s/); return `…${sp >= 0 && sp < n / 2 ? cut.slice(sp + 1) : cut}`; };
const headWords = (s: string, n: number) => { if (s.length <= n) return s; const cut = s.slice(0, n); const sp = cut.lastIndexOf(' '); return `${sp > n / 2 ? cut.slice(0, sp) : cut}…`; };

/**
 * A changed block (old lines → new lines) as one line with the changed words
 * marked [-removed-]{+added+} and long unchanged stretches trimmed. Null when
 * most of it changed (a rewrite reads better as plain old/new lines).
 */
function wordMarked(oldLines: string[], newLines: string[]): string[] | null {
  const a = oldLines.join('\n'), b = newLines.join('\n');
  if (!a || !b) return null;
  const parts = wordParts(a, b);
  if (!parts) return null;
  const same = parts.reduce((n, p) => n + (p.added || p.removed ? 0 : p.value.length), 0);
  if (same < 0.4 * Math.max(a.length, b.length)) return null;
  let out = '';
  parts.forEach((p, i) => {
    if (p.removed) { out += `[-${p.value}-]`; return; }
    if (p.added) { out += `{+${p.value}+}`; return; }
    const first = i === 0, last = i === parts.length - 1, v = p.value;
    if (first) out += tailWords(v, WORD_CONTEXT);
    else if (last) out += headWords(v, WORD_CONTEXT);
    else out += v.length > 2 * WORD_CONTEXT + 10 ? `${headWords(v, WORD_CONTEXT)} ${tailWords(v, WORD_CONTEXT)}` : v;
  });
  return out.split('\n').map((l) => `~${l}`);
}

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
  let usedWordMarks = false;
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
    const lines = h.lines.filter((l) => l[0] !== '\\'); // "\ No newline at end of file"
    for (let k = 0; k < lines.length; k++) {
      const line = lines[k];
      const tag = line[0];
      if (tag === ' ') {
        // Context: enough to place the change (read_document has the exact text).
        body.push(line.length > CONTEXT_LINE_MAX + 1 ? ` ${headWords(line.slice(1), CONTEXT_LINE_MAX)}` : line);
        oldLine++; newLine++;
        continue;
      }
      // A block of removed lines and the added lines replacing them.
      const del: string[] = [], add: string[] = [];
      while (k < lines.length && lines[k][0] === '-') del.push(lines[k++].slice(1));
      while (k < lines.length && lines[k][0] === '+') add.push(lines[k++].slice(1));
      k--;
      if (firstChangedNew < 0) firstChangedNew = newLine;
      for (let n = 0; n < del.length; n++) authorsIn(removedRuns, beforeStarts, oldLine + n, oldLine + n, who);
      for (let n = 0; n < add.length; n++) authorsIn(addedRuns, afterStarts, newLine + n, newLine + n, who);
      oldLine += del.length; newLine += add.length;
      const marked = del.length && add.length ? wordMarked(del, add) : null;
      if (marked) { body.push(...marked); usedWordMarks = true; }
      else body.push(...del.map((l) => `-${l}`), ...add.map((l) => `+${l}`));
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
  let out = header + (usedWordMarks ? '\n(~ lines show a changed line with the changed words marked [-removed-]{+added+} and unchanged stretches trimmed; - and + lines are removed and added whole; read_document has the exact text.)' : '');
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
