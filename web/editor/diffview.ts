// A readable diff of two versions of a document's markdown: changed lines in
// red and green with the changed words marked, three lines of context, and
// long unchanged stretches folded (click to show).

import { diffLines } from 'diff';
import { h } from '../lib/dom';
import { wordDiff } from './suggest';

interface Part { value: string; added?: boolean; removed?: boolean }

const CONTEXT = 3;
const lines = (s: string) => { const l = s.split('\n'); if (l.length && l[l.length - 1] === '') l.pop(); return l; };

/** Render the diff; returns the element and line counts. */
export function renderDiff(before: string, after: string): { el: HTMLElement; added: number; removed: number; same: boolean } {
  const el = h('div.diff-view', { role: 'region', 'aria-label': 'Changes' });
  if (before === after) {
    el.append(h('p.diff-empty', null, 'No difference in the text.'));
    return { el, added: 0, removed: 0, same: true };
  }
  const parts = (diffLines(before, after, { timeout: 1500 }) as Part[] | undefined)
    ?? [{ value: before, removed: true }, { value: after, added: true }];
  let added = 0, removed = 0;
  let oldNo = 1, newNo = 1;
  const table = h('div.diff-lines');
  const row = (kind: 'same' | 'del' | 'add', o: number | null, n: number | null, content: Node | string) =>
    h(`div.dl.${kind}`, null, h('span.dl-no', null, o === null ? '' : String(o)), h('span.dl-no', null, n === null ? '' : String(n)),
      h('span.dl-sign', { 'aria-hidden': 'true' }, kind === 'add' ? '+' : kind === 'del' ? '−' : ' '), h('span.dl-text', null, content));
  // A run of removed lines followed by added ones: mark the changed words inside.
  const pairWords = (del: string[], add: string[]) => {
    const a = del.join('\n'), b = add.join('\n');
    const wd = a.length + b.length < 20_000 ? wordDiff(a, b) : undefined;
    if (!wd) return null;
    const delNodes: Node[][] = [[]], addNodes: Node[][] = [[]];
    const push = (into: Node[][], text: string, cls: string | null) => {
      text.split('\n').forEach((seg, i) => {
        if (i > 0) into.push([]);
        if (seg) into[into.length - 1].push(cls ? h(`mark.${cls}`, null, seg) : document.createTextNode(seg));
      });
    };
    for (const p of wd) {
      if (p.removed) push(delNodes, p.value, 'w-del');
      else if (p.added) push(addNodes, p.value, 'w-add');
      else { push(delNodes, p.value, null); push(addNodes, p.value, null); }
    }
    return { del: delNodes, add: addNodes };
  };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const ls = lines(p.value);
    if (!p.added && !p.removed) {
      const first = i === 0, last = i === parts.length - 1;
      const head = first ? 0 : CONTEXT, tail = last ? 0 : CONTEXT;
      if (ls.length > head + tail + 2) {
        for (let k = 0; k < head; k++) table.append(row('same', oldNo + k, newNo + k, ls[k]));
        const hidden = ls.slice(head, ls.length - tail);
        const startOld = oldNo + head, startNew = newNo + head;
        const fold: HTMLButtonElement = h('button.dl-fold', { type: 'button', onclick: () => {
          fold.replaceWith(...hidden.map((t, k) => row('same', startOld + k, startNew + k, t)));
        } }, `⋯ ${hidden.length} unchanged line${hidden.length === 1 ? '' : 's'}`);
        table.append(fold);
        for (let k = ls.length - tail; k < ls.length; k++) table.append(row('same', oldNo + k, newNo + k, ls[k]));
      } else ls.forEach((t, k) => table.append(row('same', oldNo + k, newNo + k, t)));
      oldNo += ls.length; newNo += ls.length;
      continue;
    }
    if (p.removed && parts[i + 1]?.added) {
      const addLs = lines(parts[i + 1].value);
      const words = pairWords(ls, addLs);
      ls.forEach((t, k) => table.append(row('del', oldNo + k, null, words ? h('span', null, ...(words.del[k] ?? [])) : t)));
      addLs.forEach((t, k) => table.append(row('add', null, newNo + k, words ? h('span', null, ...(words.add[k] ?? [])) : t)));
      removed += ls.length; added += addLs.length;
      oldNo += ls.length; newNo += addLs.length;
      i++;
      continue;
    }
    if (p.removed) { ls.forEach((t, k) => table.append(row('del', oldNo + k, null, t))); removed += ls.length; oldNo += ls.length; }
    else { ls.forEach((t, k) => table.append(row('add', null, newNo + k, t))); added += ls.length; newNo += ls.length; }
  }
  el.append(table);
  return { el, added, removed, same: false };
}
