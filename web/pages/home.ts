// Home: the document list.

import { api, atLeast, isGuestMe, ROLE_VERB, type DocSummary, type Me } from '../lib/api';
import { debounce, h } from '../lib/dom';
import { icon } from '../lib/icons';
import { fullTime, relTime, splitLabel } from '../lib/format';
import { personBySub, searchPeople } from '../lib/people';
import { avatar, confirmDialog, emptyState, errorMessage, kindBadge, openDialog, openMenu, promptDialog, spinner, toast, type MenuItem } from '../lib/ui';
import { startSignIn } from '../lib/session';
import { navigate } from '../router';
import { topBar } from './shell';

type Filter = 'all' | 'owned' | 'shared';

const TEMPLATES: { id: string; name: string; desc: string; title: string; content: string }[] = [
  { id: 'blank', name: 'Blank document', desc: 'Start from an empty page', title: '', content: '' },
  {
    id: 'notes', name: 'Meeting notes', desc: 'Agenda, notes, action items', title: 'Meeting notes',
    content: `# Meeting notes\n\n**Date:** ${new Date().toLocaleDateString(undefined, { dateStyle: 'long' })}\n**Attendees:** \n\n## Agenda\n\n1. \n\n## Notes\n\n- \n\n## Action items\n\n- [ ] \n`,
  },
  {
    id: 'brief', name: 'Project brief', desc: 'Goals, scope, milestones', title: 'Project brief',
    content: '# Project brief\n\n## Summary\n\nOne paragraph on what this is and why it matters.\n\n## Goals\n\n- \n\n## Non-goals\n\n- \n\n## Milestones\n\n| Milestone | Owner | Date |\n| --- | --- | --- |\n|  |  |  |\n\n## Open questions\n\n- \n',
  },
];

export function mountHome(root: HTMLElement, me: Me): () => void {
  document.title = 'Documents · Archipelago Docs';
  let filter: Filter = 'all';
  let query = '';
  let docs: DocSummary[] | null = null;
  let loadSeq = 0;
  let destroyed = false;
  /** Guests see only the documents they opened through share links, and can't create or share. */
  const guest = isGuestMe(me);

  const listEl = h('div.doc-list', { role: 'list', 'aria-label': 'Documents', 'aria-busy': 'true' }, h('div.list-loading', null, spinner(26)));
  const searchInput = h('input.input.search-input', { type: 'search', placeholder: 'Search documents', 'aria-label': 'Search documents' });
  const tabs = h('div.tabs', { role: 'tablist', 'aria-label': 'Filter documents' });
  const newBtn = h('button.btn.primary', { type: 'button', onclick: () => newDocDialog() }, icon('plus', 18), 'New document');

  const renderTabs = () => {
    const items: [Filter, string][] = [['all', 'All'], ['owned', 'Owned by me'], ['shared', 'Shared with me']];
    tabs.replaceChildren(...items.map(([f, label]) => h('button.tab', {
      type: 'button', role: 'tab', 'aria-selected': String(filter === f), class: filter === f ? 'on' : '',
      onclick: () => { filter = f; renderTabs(); void load(); },
    }, label)));
  };

  const load = async (quiet = false) => {
    const my = ++loadSeq;
    if (!quiet) listEl.setAttribute('aria-busy', 'true');
    try {
      const res = await api.docs({ q: query || undefined, filter: guest ? undefined : filter });
      if (my !== loadSeq || destroyed) return;
      docs = res.docs;
      renderList();
    } catch (e) {
      if (my !== loadSeq || destroyed) return;
      listEl.replaceChildren(emptyState({ art: icon('alert', 36, 'empty-art-icon'), title: 'Couldn’t load documents', text: errorMessage(e), action: h('button.btn', { type: 'button', onclick: () => void load() }, 'Try again') }));
    } finally { listEl.setAttribute('aria-busy', 'false'); }
  };

  const renderList = () => {
    if (!docs) return;
    if (!docs.length) {
      listEl.replaceChildren(query
        ? emptyState({ art: icon('search', 36, 'empty-art-icon'), title: `No documents match “${query}”`, text: 'Try a different word, or clear the search.', action: h('button.btn', { type: 'button', onclick: () => { searchInput.value = ''; query = ''; void load(); } }, 'Clear search') })
        : guest
          ? emptyState({ art: emptyArt(), title: 'No documents here yet', text: 'Open a share link someone sent you and the document shows up here for as long as the link works.', action: h('button.btn', { type: 'button', onclick: () => startSignIn('/') }, icon('login', 16), 'Sign in with Archipelago') })
        : filter === 'shared'
          ? emptyState({ art: emptyArt(), title: 'Nothing shared with you yet', text: 'When people or agents share documents with you, they show up here.' })
          : emptyState({ art: emptyArt(), title: 'Write your first document', text: 'Documents here are live: everyone you share with, people and agents alike, sees edits and comments as they happen.', action: h('button.btn.primary', { type: 'button', onclick: () => newDocDialog() }, icon('plus', 18), 'New document') }));
      return;
    }
    listEl.replaceChildren(
      h('div.doc-row.doc-row-head', { 'aria-hidden': 'true' }, h('span.c-title', null, 'Name'), h('span.c-owner', null, 'Owner'), h('span.c-updated', null, 'Last updated'), h('span.c-activity', null, ''), h('span.c-menu')),
      ...docs.map(renderRow));
  };

  const renderRow = (d: DocSummary) => {
    const ownerName = splitLabel(d.owner.label).name;
    const mine = d.owner.sub === me.sub;
    const ownerColor = personBySub(d.owner.sub)?.color ?? d.owner.color ?? (mine ? me.color : undefined);
    const menuBtn: HTMLButtonElement = h('button.icon-btn.sm.row-menu', {
      type: 'button', 'aria-label': `Actions for ${d.title}`, 'aria-haspopup': 'menu',
      onclick: (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); openMenu(menuBtn, rowMenu(d), { align: 'end' }); },
    }, icon('more', 18));
    const present = d.present.filter((p) => p.name !== me.name || p.color !== me.color);
    return h('a.doc-row', { href: `/d/${d.id}`, 'data-link': '', role: 'listitem' },
      h('span.c-title', null,
        h('span.doc-icon', { 'aria-hidden': 'true' }, icon('file', 20)),
        h('span.doc-title-text', null, d.title),
        !guest && d.publicLink ? h('span.access-chip.public', { 'data-tip': 'Anyone with a link can open this', 'aria-label': 'Anyone with a link can open this' }, icon('globe', 13)) : null,
        !guest && d.generalAccess !== 'restricted' ? h('span.access-chip.members', { 'data-tip': `Archipelago members can ${ROLE_VERB[d.generalAccess]}`, 'aria-label': `Archipelago members can ${ROLE_VERB[d.generalAccess]}` }, icon('users', 13)) : null,
        d.role !== 'owner' && d.role !== 'editor' ? h('span.role-chip', null, d.role === 'commenter' ? 'Can comment' : 'View only') : null),
      h('span.c-owner', null, avatar({ name: ownerName, color: ownerColor, kind: d.owner.kind }, 24), h('span.owner-name', null, mine ? 'me' : ownerName), kindBadge(d.owner.kind)),
      h('span.c-updated', { title: fullTime(d.updatedAt) }, relTime(d.updatedAt)),
      h('span.c-activity', null,
        present.length ? h('span.row-presence', { 'data-tip': `${present.map((p) => p.name).join(', ')} ${present.length === 1 ? 'is' : 'are'} here now` },
          ...present.slice(0, 3).map((p) => avatar(p, 22, { ring: true })), present.length > 3 ? h('span.presence-more.sm', null, `+${present.length - 3}`) : null) : null,
        d.openComments ? h('span.comment-count', { 'data-tip': `${d.openComments} open comment${d.openComments === 1 ? '' : 's'}` }, icon('comment', 15), String(d.openComments)) : null),
      h('span.c-menu', null, menuBtn));
  };

  const rowMenu = (d: DocSummary): MenuItem[] => [
    { label: 'Open', icon: 'file', onSelect: () => navigate(`/d/${d.id}`) },
    { label: 'Open in new tab', icon: 'external', onSelect: () => window.open(`/d/${d.id}`, '_blank', 'noopener') },
    ...(guest ? [] : [{ label: 'Copy link', icon: 'link', onSelect: () => { void navigator.clipboard.writeText(`${location.origin}/d/${d.id}`).then(() => toast('Link copied', { kind: 'success', timeout: 2000 })); } }]),
    ...(atLeast(d.role, 'editor') ? [{ label: 'Rename', icon: 'pencil', onSelect: () => void rename(d) }] : []),
    ...(atLeast(d.role, 'owner') ? ['separator' as const, { label: 'Delete', icon: 'trash', danger: true, onSelect: () => void remove(d) }] : []),
  ];

  const rename = async (d: DocSummary) => {
    const title = await promptDialog({ title: 'Rename document', label: 'Title', value: d.title, confirmLabel: 'Rename', validate: (v) => (v ? null : 'Enter a title.') });
    if (!title || title === d.title) return;
    try { await api.patchDoc(d.id, { title }); toast('Renamed', { kind: 'success', timeout: 2000 }); void load(true); }
    catch (e) { toast(errorMessage(e), { kind: 'error' }); }
  };
  const remove = async (d: DocSummary) => {
    const ok = await confirmDialog({ title: 'Delete this document?', message: h('span', null, h('strong', null, `“${d.title}”`), ' will be deleted for everyone, including its comments and history.'), confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try { await api.deleteDoc(d.id); toast(`Deleted “${d.title}”`, { kind: 'success' }); void load(true); }
    catch (e) { toast(errorMessage(e), { kind: 'error' }); }
  };

  const newDocDialog = () => {
    let template = TEMPLATES[0];
    const titleIn = h('input.input.lg', { type: 'text', placeholder: 'Untitled document', 'aria-label': 'Title', maxlength: '300', autofocus: true });
    const grid = h('div.template-grid', { role: 'radiogroup', 'aria-label': 'Start from' });
    const drawGrid = () => grid.replaceChildren(...TEMPLATES.map((tp) => h('button.template', {
      type: 'button', role: 'radio', 'aria-checked': String(tp === template), class: tp === template ? 'on' : '',
      onclick: () => { template = tp; if (!titleIn.value.trim() || TEMPLATES.some((x) => x.title === titleIn.value.trim())) titleIn.value = tp.title; drawGrid(); },
    }, h('span.template-thumb', { 'aria-hidden': 'true', class: `tpl-${tp.id}` }, h('span'), h('span'), h('span'), h('span')), h('span.template-name', null, tp.name), h('span.template-desc', null, tp.desc))));
    drawGrid();
    const create = h('button.btn.primary', { type: 'button' }, 'Create');
    const submit = async () => {
      create.disabled = true;
      try {
        const d = await api.createDoc(titleIn.value.trim() || 'Untitled document', template.content || undefined);
        dlg.close();
        navigate(`/d/${d.id}`);
      } catch (e) { toast(errorMessage(e), { kind: 'error' }); create.disabled = false; }
    };
    create.addEventListener('click', () => void submit());
    titleIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } });
    const dlg = openDialog({
      title: 'New document', size: 'md', className: 'new-doc-dialog',
      body: h('div.form-stack', null, h('label.field', null, h('span.field-label', null, 'Title'), titleIn), h('div.field', null, h('span.field-label', null, 'Start from'), grid)),
      footer: [h('button.btn.ghost', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), create],
    });
    titleIn.focus();
  };

  const onSearch = debounce(() => { query = searchInput.value.trim(); void load(); }, 200);
  searchInput.addEventListener('input', onSearch);

  renderTabs();
  root.replaceChildren(h('div.page-shell', null,
    topBar(me, 'docs'),
    h('main.home', null,
      h('div.home-head', null,
        h('div', null, h('h1', null, 'Documents'), guest
          ? h('p.home-sub', null, 'You’re a guest: these are the documents you’ve opened through share links. Each stays here while its link works. ', h('button.link-btn', { type: 'button', onclick: () => startSignIn('/') }, 'Sign in'), ' to create and share your own.')
          : h('p.home-sub', null, `Welcome back, ${me.name.split(/\s+/)[0]}.`)),
        h('div.home-actions', null, h('label.search', null, icon('search', 17), searchInput), guest ? null : newBtn)),
      guest ? null : tabs,
      listEl)));

  void searchPeople('').catch(() => undefined).then(() => { if (docs) renderList(); });
  void load();
  const refresh = window.setInterval(() => { if (document.visibilityState === 'visible') void load(true); }, 15_000);
  const onFocus = () => void load(true);
  window.addEventListener('focus', onFocus);
  return () => { destroyed = true; clearInterval(refresh); window.removeEventListener('focus', onFocus); onSearch.cancel(); };
}

function emptyArt(): HTMLElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg class="empty-art" width="132" height="96" viewBox="0 0 132 96" aria-hidden="true">
    <rect x="30" y="8" width="56" height="72" rx="6" class="ea-sheet"/>
    <rect x="46" y="16" width="56" height="72" rx="6" class="ea-sheet front"/>
    <rect x="54" y="28" width="30" height="4" rx="2" class="ea-line strong"/>
    <rect x="54" y="38" width="40" height="3" rx="1.5" class="ea-line"/>
    <rect x="54" y="45" width="36" height="3" rx="1.5" class="ea-line"/>
    <rect x="54" y="52" width="38" height="3" rx="1.5" class="ea-line"/>
    <path d="M58 70c3-5 7-7 11-7s8 2 11 7z" class="ea-island"/>
    <path d="M52 74c3-2 6-2 9 0s6 2 9 0 6-2 9 0 6 2 9 0" class="ea-wave"/>
    <circle cx="104" cy="22" r="9" class="ea-badge"/>
    <path d="M104 17.5l1.3 3.2 3.2 1.3-3.2 1.3-1.3 3.2-1.3-3.2-3.2-1.3 3.2-1.3z" class="ea-star"/>
  </svg>`;
  return tpl.content.firstElementChild as HTMLElement;
}
