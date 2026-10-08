// Splitting one proposed replacement into reviewable suggestions.
//
// An agent that rewrites a section proposes one big replacement; reviewers
// want each changed passage on its own, like tracked changes. The replacement
// is trimmed to what actually differs (widened to whole words), then split at
// paragraph breaks and long unchanged stretches.

import { diffWordsWithSpace } from 'diff';

export interface Hunk { from: number; to: number; text: string }

/** Unchanged runs at least this long (or containing a blank line) separate hunks. */
const SPLIT_GAP = 80;
/** Replacements smaller than this stay one hunk. */
const SMALL = 120;
const MAX_HUNKS = 60;
/** Past this size a replacement isn't diffed (it stays one hunk): diffing is synchronous CPU. */
const DIFF_MAX = 60_000;

const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}_'’-]/u.test(c);

/**
 * Trim a replacement of [from, to) in `doc` by `next` to the part that
 * changes, widened to word boundaries. Null if nothing changes.
 */
export function trimToChange(doc: string, from: number, to: number, next: string): Hunk | null {
  const prev = doc.slice(from, to);
  if (prev === next) return null;
  let p = 0;
  while (p < prev.length && p < next.length && prev[p] === next[p]) p++;
  let q = 0;
  while (q < prev.length - p && q < next.length - p && prev[prev.length - 1 - q] === next[next.length - 1 - q]) q++;
  // Widen to whole words so "cat" → "cut" reads as a word change, not a letter.
  while (p > 0 && isWord(prev[p - 1]) && (isWord(prev[p]) || isWord(next[p]))) p--;
  while (q > 0 && isWord(prev[prev.length - q]) && (isWord(prev[prev.length - q - 1]) || isWord(next[next.length - q - 1]))) q--;
  return { from: from + p, to: to - q, text: next.slice(p, next.length - q) };
}

/**
 * Split one replacement into hunks (each a contiguous change in document
 * coordinates). `deadline` (ms epoch) bounds the time spent diffing across a
 * whole request: past it, replacements stay whole.
 */
export function splitHunks(doc: string, from: number, to: number, next: string, deadline = Date.now() + 200): Hunk[] {
  const t = trimToChange(doc, from, to, next);
  if (!t) return [];
  const prev = doc.slice(t.from, t.to);
  const budget = deadline - Date.now();
  if (prev.length + t.text.length < SMALL || prev.length + t.text.length > DIFF_MAX || budget < 5) return [t];
  const parts = diffWordsWithSpace(prev, t.text, { timeout: Math.min(200, budget) }) as { value: string; added?: boolean; removed?: boolean }[] | undefined;
  if (!parts) return [t];
  const out: Hunk[] = [];
  let pos = 0; // offset in prev
  let cur: { from: number; to: number; text: string } | null = null;
  const close = () => { if (cur) { out.push({ from: t.from + cur.from, to: t.from + cur.to, text: cur.text }); cur = null; } };
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.added) {
      cur ??= { from: pos, to: pos, text: '' };
      cur.text += part.value;
    } else if (part.removed) {
      cur ??= { from: pos, to: pos, text: '' };
      pos += part.value.length;
      cur.to = pos;
    } else {
      const gapSplits = part.value.length >= SPLIT_GAP || /\n\s*\n/.test(part.value);
      const last = i === parts.length - 1;
      if (cur && !gapSplits && !last) { cur.text += part.value; pos += part.value.length; cur.to = pos; continue; }
      close();
      pos += part.value.length;
    }
  }
  close();
  if (!out.length || out.length > MAX_HUNKS) return [t];
  // Each hunk again trimmed to word boundaries (merged gaps may have carried shared text).
  return out.map((h) => trimToChange(doc, h.from, h.to, h.text)).filter((h): h is Hunk => !!h);
}
