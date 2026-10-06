// Person picker: a text input with a live directory dropdown.

import type { Person } from './api';
import { debounce, h } from './dom';
import { icon } from './icons';
import { searchPeople } from './people';
import { avatar, issuerBadge, kindBadge } from './ui';

export interface PickerHandle { el: HTMLElement; input: HTMLInputElement; clear(): void; close(): void }

export function peoplePicker(opts: {
  placeholder: string;
  label: string;
  exclude?: () => Set<string>;
  onPick: (p: Person) => void;
  /** Enter on text that matches nobody (e.g. a full principal id). */
  onRaw?: (text: string) => void;
}): PickerHandle {
  const input = h('input.input.picker-input', { type: 'text', placeholder: opts.placeholder, 'aria-label': opts.label, autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'false', 'aria-autocomplete': 'list' });
  const list = h('div.picker-list', { role: 'listbox', hidden: true });
  const el = h('div.picker', null, h('span.picker-icon', null, icon('search', 16)), input, list);
  let items: Person[] = [];
  let index = 0;
  let seq = 0;

  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); };
  const render = () => {
    if (!items.length) {
      if (input.value.trim()) {
        list.replaceChildren(h('div.picker-empty', null, `No one named “${input.value.trim()}” has signed in yet.`, opts.onRaw ? h('div.picker-hint', null, 'Press Enter to try this name or id anyway.') : null));
        list.hidden = false;
      } else close();
      return;
    }
    list.replaceChildren(...items.map((p, i) => h('div.picker-option', {
      role: 'option', 'aria-selected': String(i === index), class: i === index ? 'active' : '',
      onmousedown: (e: MouseEvent) => { e.preventDefault(); pick(i); },
      onmousemove: () => { if (index !== i) { index = i; render(); } },
    }, avatar(p, 28), h('div.po-text', null, h('div.po-name', null, p.name, kindBadge(p.kind), issuerBadge(p.label)), h('div.po-sub', null, p.sub)))));
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };
  const pick = (i: number) => {
    const p = items[i];
    if (!p) return;
    opts.onPick(p);
    input.value = '';
    items = [];
    close();
  };
  const search = debounce(async () => {
    const q = input.value.trim().replace(/^@/, '');
    const my = ++seq;
    if (!q) { items = []; close(); return; }
    try {
      const people = await searchPeople(q);
      if (my !== seq) return;
      const ex = opts.exclude?.() ?? new Set<string>();
      items = people.filter((p) => !ex.has(p.sub) && p.role !== 'blocked').slice(0, 8);
      index = 0;
      render();
    } catch { /* keep quiet while typing */ }
  }, 120);

  input.addEventListener('input', search);
  input.addEventListener('focus', () => { if (input.value.trim()) search(); });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); index = (index + 1) % items.length; render(); }
    else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); index = (index - 1 + items.length) % items.length; render(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (items.length && !list.hidden) pick(index);
      else if (input.value.trim() && opts.onRaw) { opts.onRaw(input.value.trim()); }
    } else if (e.key === 'Escape' && !list.hidden) { e.preventDefault(); e.stopPropagation(); close(); }
  });
  return { el, input, clear: () => { input.value = ''; items = []; close(); }, close };
}
