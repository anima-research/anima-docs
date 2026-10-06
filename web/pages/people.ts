// People directory and the admin principals table.

import { api, type AdminPrincipal, type Me, type Person } from '../lib/api';
import { debounce, h } from '../lib/dom';
import { icon } from '../lib/icons';
import { fullTime, relTime } from '../lib/format';
import { remember } from '../lib/people';
import { avatar, emptyState, errorMessage, issuerBadge, kindBadge, shownName, spinner, toast } from '../lib/ui';
import { topBar } from './shell';

export function mountPeople(root: HTMLElement, me: Me): () => void {
  document.title = 'People · Archipelago Docs';
  let kind: 'all' | 'human' | 'agent' = 'all';
  let people: Person[] | null = null;
  let seq = 0;
  const grid = h('div.people-grid', { 'aria-busy': 'true' }, h('div.list-loading', null, spinner(26)));
  const searchInput = h('input.input.search-input', { type: 'search', placeholder: 'Search by name or id', 'aria-label': 'Search people and agents' });
  const seg = h('div.seg', { role: 'tablist', 'aria-label': 'Show' });

  const drawSeg = () => seg.replaceChildren(...([['all', 'Everyone'], ['human', 'People'], ['agent', 'Agents']] as const).map(([k, label]) =>
    h('button.seg-btn', { type: 'button', role: 'tab', 'aria-selected': String(kind === k), class: kind === k ? 'on' : '', onclick: () => { kind = k; drawSeg(); draw(); } }, label)));

  const draw = () => {
    if (!people) return;
    const list = people.filter((p) => kind === 'all' || (kind === 'agent' ? p.kind !== 'human' : p.kind === 'human'));
    if (!list.length) {
      grid.replaceChildren(emptyState({ art: icon('users', 36, 'empty-art-icon'), title: searchInput.value ? 'No one matches that search' : kind === 'agent' ? 'No agents yet' : 'No one here yet', text: kind === 'agent' ? 'Agents appear here once they connect to this service with an Archipelago identity.' : 'People appear here after they sign in for the first time.' }));
      return;
    }
    grid.replaceChildren(...list.map((p) => h('article.person-card', { class: p.role === 'blocked' ? 'blocked' : '' },
      avatar(p, 46),
      h('div.person-main', null,
        h('div.person-name', null, h('span', null, p.name), p.sub === me.sub ? h('span.you-tag', null, '(you)') : null),
        h('div.person-badges', null, kindBadge(p.kind, { showHuman: true }), issuerBadge(p.label), p.role === 'admin' ? h('span.role-tag.admin', null, 'Admin') : null, p.role === 'blocked' ? h('span.role-tag.blocked', null, 'Blocked') : null),
        h('div.person-sub', { title: p.sub }, p.sub),
        h('div.person-seen', { title: fullTime(p.lastSeen) }, `Active ${relTime(p.lastSeen)}`)))));
  };

  const load = async () => {
    const my = ++seq;
    try {
      const res = await api.people(searchInput.value.trim() || undefined);
      if (my !== seq) return;
      remember(res.people);
      people = res.people;
      draw();
    } catch (e) {
      grid.replaceChildren(emptyState({ title: 'Couldn’t load the directory', text: errorMessage(e) }));
    } finally { grid.setAttribute('aria-busy', 'false'); }
  };
  const onSearch = debounce(() => void load(), 200);
  searchInput.addEventListener('input', onSearch);
  drawSeg();
  root.replaceChildren(h('div.page-shell', null, topBar(me, 'people'),
    h('main.home', null,
      h('div.home-head', null,
        h('div', null, h('h1', null, 'People & agents'), h('p.home-sub', null, 'Everyone who has signed in or connected. Share documents with them or mention them in comments.')),
        h('div.home-actions', null, h('label.search', null, icon('search', 17), searchInput))),
      h('div.toolbar-row', null, seg),
      grid)));
  void load();
  return () => onSearch.cancel();
}

export function mountAdmin(root: HTMLElement, me: Me): () => void {
  document.title = 'Admin · Archipelago Docs';
  const table = h('div.admin-table-wrap', { 'aria-busy': 'true' }, h('div.list-loading', null, spinner(26)));
  const searchInput = h('input.input.search-input', { type: 'search', placeholder: 'Filter', 'aria-label': 'Filter principals' });
  // Guests (people who opened an "anyone" link without signing in) are hidden unless asked for, e.g. to block one.
  const guestsToggle = h('input', { type: 'checkbox', 'aria-describedby': 'guests-hint' });
  const guestsLabel = h('label.check.toggle-check', { 'data-tip': 'Include people who opened an “anyone with the link” link without signing in' }, guestsToggle, h('span', null, 'Show guests'));
  let rows: AdminPrincipal[] = [];
  let seq = 0;

  const draw = () => {
    const q = searchInput.value.trim().toLowerCase();
    const list = rows.filter((p) => !q || p.name.toLowerCase().includes(q) || p.sub.toLowerCase().includes(q));
    if (!list.length) { table.replaceChildren(emptyState({ title: 'No principals match', text: guestsToggle.checked ? 'Try another search.' : 'Try another search, or show guests too.' })); return; }
    table.replaceChildren(h('table.admin-table', null,
      h('thead', null, h('tr', null, ...['Principal', 'Kind', 'Issuer', 'Docs', 'Watches', 'Last seen', 'Role'].map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', null, ...list.map((p) => {
        const isGuest = p.kind === 'guest';
        const sel = h('select.select.sm', { 'aria-label': `Role for ${p.name}`, disabled: p.sub === me.sub, class: `role-${p.role}` },
          h('option', { value: 'member', selected: p.role === 'member' }, isGuest ? 'Guest' : 'Member'),
          isGuest ? null : h('option', { value: 'admin', selected: p.role === 'admin' }, 'Admin'),
          h('option', { value: 'blocked', selected: p.role === 'blocked' }, 'Blocked'));
        sel.addEventListener('change', async () => {
          const next = sel.value as AdminPrincipal['role'];
          sel.disabled = true;
          try {
            const updated = await api.setPrincipalRole(p.sub, next);
            p.role = updated.role;
            sel.className = `select sm role-${p.role}`;
            toast(next === 'blocked' ? `${p.name} is blocked and signed out` : isGuest ? `${p.name} is unblocked` : `${p.name} is now ${next === 'admin' ? 'an admin' : 'a member'}`, { kind: 'success' });
          } catch (e) {
            sel.value = p.role;
            toast(errorMessage(e), { kind: 'error' });
          } finally { sel.disabled = p.sub === me.sub; }
        });
        return h('tr', { class: `${p.role === 'blocked' ? 'blocked' : ''} ${isGuest ? 'guest' : ''}` },
          h('td', null, h('div.admin-who', null, avatar(p, 30), h('div', null, h('div.admin-name', null, shownName(p), p.sub === me.sub ? h('span.you-tag', null, '(you)') : null), h('div.admin-sub', null, p.sub)))),
          h('td', null, kindBadge(p.kind, { showHuman: true })),
          isGuest ? h('td.muted', null, 'Share link') : h('td.mono', null, p.issuer),
          h('td.num', null, String(p.docs)),
          h('td.num', null, String(p.watches)),
          h('td', { title: fullTime(p.lastSeen) }, relTime(p.lastSeen)),
          h('td', null, p.sub === me.sub ? h('span.role-tag.admin', { title: me.admin && p.role !== 'admin' ? 'Admin through your sign-in scope' : 'You can’t change your own role' }, me.admin ? 'Admin' : p.role === 'blocked' ? 'Blocked' : 'Member') : sel));
      }))));
  };

  const body = h('main.home', null,
    h('div.home-head', null,
      h('div', null, h('h1', null, 'Admin'), h('p.home-sub', null, 'Everyone the service has verified. Admins own every document; blocked principals are signed out and refused.'),
        h('p.home-sub.small#guests-hint', null, 'Guests opened an “anyone with the link” link without signing in. Block one to end their session everywhere.')),
      h('div.home-actions', null, guestsLabel, h('label.search', null, icon('search', 17), searchInput))),
    table);
  root.replaceChildren(h('div.page-shell', null, topBar(me, 'admin'), body));
  if (!me.admin) {
    guestsLabel.hidden = true;
    table.replaceChildren(emptyState({ art: icon('shield', 36, 'empty-art-icon'), title: 'Admins only', text: 'You need administrator access to manage principals.' }));
    return () => {};
  }
  searchInput.addEventListener('input', draw);
  const load = () => {
    const my = ++seq;
    table.setAttribute('aria-busy', 'true');
    void api.adminPrincipals({ guests: guestsToggle.checked }).then((r) => { if (my === seq) { rows = r.principals; draw(); } }).catch((e) => {
      if (my === seq) table.replaceChildren(emptyState({ title: 'Couldn’t load principals', text: errorMessage(e) }));
    }).finally(() => { if (my === seq) table.setAttribute('aria-busy', 'false'); });
  };
  guestsToggle.addEventListener('change', load);
  load();
  return () => {};
}
