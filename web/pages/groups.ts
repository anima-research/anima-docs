// Groups: named sets of people and agents to share documents and spaces with, and to mention.
// You see the groups you own or belong to; the owner manages members.

import { api, type Group, type Me, type Person } from '../lib/api';
import { h } from '../lib/dom';
import { icon } from '../lib/icons';
import { peoplePicker } from '../lib/picker';
import { avatar, confirmDialog, emptyState, errorMessage, issuerBadge, kindBadge, promptDialog, spinner, toast } from '../lib/ui';
import { remember } from '../lib/people';
import { topBar } from './shell';

export function mountGroups(root: HTMLElement, me: Me): () => void {
  document.title = 'Groups · Anima Docs';
  let groups: Group[] | null = null;
  let open: string | null = null;
  const list = h('div.groups-list', { 'aria-busy': 'true' }, h('div.list-loading', null, spinner(26)));
  const detail = h('section.group-detail', { hidden: true });

  let seq = 0;
  const load = async (keepOpen = true) => {
    const my = ++seq; // an older answer landing after a newer one must not re-render the page
    try {
      const res = await api.groups();
      if (my !== seq) return;
      groups = res.groups;
      for (const g of groups) remember(g.members.map((m) => ({ ...m, issuer: '', role: 'member', lastSeen: 0 })) as unknown as Person[]);
      draw();
      if (keepOpen && open && groups.some((g) => g.sub === open)) drawDetail();
      else if (open) { open = null; detail.hidden = true; }
    } catch (e) { list.replaceChildren(emptyState({ title: 'Couldn’t load groups', text: errorMessage(e) })); }
  };

  const draw = () => {
    if (!groups) return;
    list.removeAttribute('aria-busy');
    if (!groups.length) { list.replaceChildren(emptyState({ art: icon('users', 36, 'empty-art-icon'), title: 'No groups yet', text: 'A group is a named set of people and agents. Share a document or a space with it, or mention it in a comment to reach everyone in it.' })); return; }
    list.replaceChildren(...groups.map((g) => h('button.group-card', { type: 'button', class: g.sub === open ? 'on' : '', 'aria-pressed': String(g.sub === open), onclick: () => { open = g.sub; draw(); drawDetail(); } },
      h('span.group-avatar', { 'aria-hidden': 'true' }, icon('users', 20)),
      h('span.group-main', null, h('span.group-name', null, g.name), h('span.meta', null, `${g.members.length} member${g.members.length === 1 ? '' : 's'} · ${g.you === 'owner' ? 'you own it' : g.you === 'member' ? 'you are in it' : 'admin view'}`)))));
  };

  const drawDetail = () => {
    const g = groups?.find((x) => x.sub === open);
    if (!g) { detail.hidden = true; return; }
    const manage = g.you === 'owner' || me.admin;
    const members = g.members.map((m) => h('div.member-row', null,
      avatar({ name: m.name, kind: m.kind, color: m.color }, 34),
      h('div.share-who', null, h('div.share-name', null, m.name, m.sub === me.sub ? h('span.you-tag', null, '(you)') : null, kindBadge(m.kind), issuerBadge(m.label)), h('div.share-sub', null, m.sub)),
      manage && m.sub !== g.ownerSub ? h('button.btn.ghost.sm', { type: 'button', onclick: async () => { try { await api.removeFromGroup(g.sub, m.sub); await load(); } catch (e) { toast(errorMessage(e), { kind: 'error' }); } } }, 'Remove') : h('span.meta', null, m.sub === g.ownerSub ? 'owner' : '')));
    const picker = manage ? peoplePicker({
      placeholder: 'Add a person or agent by name', label: 'Add a member',
      exclude: () => new Set(g.members.map((m) => m.sub)),
      onPick: (p) => void add(p.sub),
      onRaw: (text) => void add(text),
    }) : null;
    const add = async (who: string) => { try { await api.addToGroup(g.sub, who); picker?.clear(); await load(); } catch (e) { toast(errorMessage(e), { kind: 'error' }); } };
    const actions = manage ? h('div.row-gap', null,
      h('button.btn.ghost.sm', { type: 'button', onclick: async () => { const name = await promptDialog({ title: 'Rename group', label: 'Name', value: g.name, confirmLabel: 'Rename' }); if (name && name !== g.name) { try { await api.renameGroup(g.sub, name); await load(); } catch (e) { toast(errorMessage(e), { kind: 'error' }); } } } }, 'Rename…'),
      h('button.btn.ghost.sm.danger', { type: 'button', onclick: async () => { if (await confirmDialog({ title: `Delete “${g.name}”?`, message: 'Every share made to the group ends; its members keep what they were given directly.', confirmLabel: 'Delete', danger: true })) { try { await api.deleteGroup(g.sub); open = null; await load(false); } catch (e) { toast(errorMessage(e), { kind: 'error' }); } } } }, 'Delete')) : null;
    detail.hidden = false;
    detail.replaceChildren(
      h('div.group-head', null, h('h2', null, g.name), h('span.meta', null, g.sub), actions),
      h('p.meta', null, 'Share a document or a space with ', h('strong', null, g.name), ' from its Share dialog, or write ', h('code', null, `@${g.name}`), ' in a comment to reach everyone here.', manage ? ' Add members by their exact name.' : ''),
      ...(picker ? [h('div.group-add', null, picker.el)] : []),
      h('div.members-list', null, ...members));
    if (picker) setTimeout(() => picker.input.focus(), 0);
  };

  const newGroup = async () => {
    const name = await promptDialog({ title: 'New group', label: 'Name', placeholder: 'e.g. Research team', confirmLabel: 'Create' });
    if (!name) return;
    try { const g = await api.createGroup(name); open = g.sub; await load(); } catch (e) { toast(errorMessage(e), { kind: 'error' }); }
  };

  root.replaceChildren(h('div.page-shell', null, topBar(me, 'groups'),
    h('main.home.groups-page', null,
      h('div.home-head', null,
        h('div', null, h('h1', null, 'Groups'), h('p.home-sub', null, 'Named sets of people and agents, to share with and to mention. You see the groups you own or belong to.')),
        h('button.btn.primary', { type: 'button', onclick: () => void newGroup() }, icon('plus', 18), 'New group')),
      h('div.groups-layout', null, list, detail))));
  void load();
  return () => { /* nothing to tear down */ };
}
