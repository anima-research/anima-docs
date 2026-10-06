// People directory cache and @mention autocomplete for textareas.

import { api, type Person } from './api';
import { h } from './dom';
import { avatar, kindBadge, issuerBadge } from './ui';
import { isGuestSession } from './session';

const bySub = new Map<string, Person>();
const queryCache = new Map<string, { at: number; people: Person[] }>();

export function remember(people: Person[]) {
  for (const p of people) bySub.set(p.sub, p);
}
export function personBySub(sub: string): Person | undefined {
  return bySub.get(sub);
}
export function knownPeople(): Person[] {
  return [...bySub.values()];
}

export async function searchPeople(q: string): Promise<Person[]> {
  const key = q.trim().toLowerCase();
  // Guests can't browse the directory: suggest only members already seen here (e.g. comment authors).
  // Their ids are opaque (anon:…), so only names that resolve by themselves are offered.
  if (isGuestSession()) {
    return knownPeople().filter((p) => p.kind !== 'guest' && p.role !== 'blocked' && !/[^\w .'-]/.test(p.name) && (!key || p.name.toLowerCase().includes(key)));
  }
  const hit = queryCache.get(key);
  if (hit && Date.now() - hit.at < 20_000) return hit.people;
  const { people } = await api.people(key || undefined);
  remember(people);
  queryCache.set(key, { at: Date.now(), people });
  return people;
}

/** How to write a mention of `p` so it resolves to exactly them. */
export function mentionText(p: Person): string {
  if (p.sub.startsWith('anon:')) return `@${p.name}`; // a guest's view: the server resolves names, not masked ids
  const twins = knownPeople().filter((x) => x.name.toLowerCase() === p.name.toLowerCase() && x.role !== 'blocked');
  return twins.length > 1 || /[^\w .'-]/.test(p.name) ? `@{${p.sub}}` : `@${p.name}`;
}

// ------------------------------------------------------------------ autocomplete

export function attachMentions(ta: HTMLTextAreaElement | HTMLInputElement, opts: { excludeSub?: string; onPick?: (p: Person) => void } = {}) {
  let popup: HTMLElement | null = null;
  let items: Person[] = [];
  let index = 0;
  let range: { start: number; end: number } | null = null;
  let seq = 0;

  const close = () => { popup?.remove(); popup = null; items = []; range = null; ta.removeAttribute('aria-activedescendant'); ta.setAttribute('aria-expanded', 'false'); };

  const render = () => {
    if (!items.length || !range) { close(); return; }
    if (!popup) {
      popup = h('div.mention-popup', { role: 'listbox', id: `mp-${Math.random().toString(36).slice(2, 8)}` });
      popup.addEventListener('mousedown', (e) => e.preventDefault());
      (ta.closest('dialog') ?? document.body).append(popup);
    }
    popup.replaceChildren(...items.map((p, i) => {
      const row = h('div.mention-option', { role: 'option', id: `${popup!.id}-${i}`, 'aria-selected': String(i === index), class: i === index ? 'active' : '', onclick: () => pick(i), onmousemove: () => { if (index !== i) { index = i; render(); } } },
        avatar(p, 24), h('span.mo-name', null, p.name), kindBadge(p.kind), issuerBadge(p.label));
      return row;
    }));
    ta.setAttribute('aria-expanded', 'true');
    ta.setAttribute('aria-activedescendant', `${popup.id}-${index}`);
    const r = ta.getBoundingClientRect();
    const w = Math.max(220, Math.min(300, r.width));
    popup.style.width = `${w}px`;
    let top = r.bottom + 4;
    const ph = popup.offsetHeight;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 4);
    popup.style.top = `${top}px`;
    popup.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  };

  const pick = (i: number) => {
    const p = items[i];
    if (!p || !range) return;
    const text = `${mentionText(p)} `;
    const v = ta.value;
    ta.value = v.slice(0, range.start) + text + v.slice(range.end);
    const caret = range.start + text.length;
    ta.setSelectionRange(caret, caret);
    close();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    opts.onPick?.(p);
    ta.focus();
  };

  const update = async () => {
    const caret = ta.selectionStart ?? 0;
    const before = ta.value.slice(0, caret);
    const m = /(?:^|[\s(])@([\p{L}\p{N}_.'-]{0,40}(?: [\p{L}\p{N}_.'-]{0,40})?)$/u.exec(before);
    if (!m) { close(); return; }
    const query = m[1];
    const start = caret - query.length - 1;
    const my = ++seq;
    let people: Person[];
    try { people = await searchPeople(query.split(' ')[0]); } catch { close(); return; }
    if (my !== seq) return;
    const ql = query.toLowerCase();
    items = people
      .filter((p) => p.sub !== opts.excludeSub && p.role !== 'blocked')
      .filter((p) => !ql || p.name.toLowerCase().startsWith(ql) || p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(ql)) || p.sub.toLowerCase().includes(ql))
      .slice(0, 8);
    index = Math.min(index, Math.max(0, items.length - 1));
    range = { start, end: caret };
    render();
  };

  ta.setAttribute('aria-autocomplete', 'list');
  ta.addEventListener('input', () => { void update(); });
  ta.addEventListener('click', () => { void update(); });
  ta.addEventListener('blur', () => setTimeout(close, 100));
  ta.addEventListener('keydown', ((e: KeyboardEvent) => {
    if (!popup || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopImmediatePropagation(); index = (index + 1) % items.length; render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); index = (index - 1 + items.length) % items.length; render(); }
    else if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); pick(index); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
  }) as EventListener);
  return { close };
}
