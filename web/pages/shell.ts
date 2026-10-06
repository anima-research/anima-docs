// App chrome shared by the list pages: top bar, user menu, navigation.

import { api, isGuestMe, type Me } from '../lib/api';
import { h, replaceChildren } from '../lib/dom';
import { icon, logo } from '../lib/icons';
import { guestBase } from '../lib/format';
import { onMeChanged, startSignIn, updateMe } from '../lib/session';
import { avatar, confirmDialog, emptyState, errorMessage, kindBadge, openDialog, openMenu, promptDialog, shownName, spinner, toast, type MenuItem } from '../lib/ui';
import { navigate } from '../router';

export async function signOut(me?: Me) {
  if (me && isGuestMe(me)) {
    const ok = await confirmDialog({ title: 'Leave guest session?', message: 'You’ll stop being “' + me.name + '” on this browser. To come back, open a share link again or sign in with Archipelago.', confirmLabel: 'Leave' });
    if (!ok) return;
  }
  try { await api.logout(); } catch (e) { toast(errorMessage(e), { kind: 'error' }); return; }
  location.assign('/');
}

/** A guest picks the name others see (the server adds "(guest)"). */
export async function renameGuest(me: Me) {
  const name = await promptDialog({
    title: 'Change your name', label: 'Your name', value: guestBase(me.name), confirmLabel: 'Save', maxLength: 40,
    help: h('span', null, 'Others in your documents see this name followed by ', h('strong', null, '(guest)'), '. Sign in with Archipelago to use your own identity.'),
    validate: (v) => (v ? null : 'Enter a name.'),
  });
  if (!name || name === guestBase(me.name)) return;
  try {
    const { you } = await api.renameGuest(name);
    updateMe(you);
    toast(h('span', null, 'Others now see you as ', h('strong', null, you.name), '.'), { kind: 'success', timeout: 3000 });
  } catch (e) { toast(errorMessage(e), { kind: 'error' }); }
}

export function userMenuButton(me: Me, opts: { compact?: boolean } = {}): HTMLButtonElement {
  const guest = isGuestMe(me);
  const items = (): MenuItem[] => guest
    ? [
      { heading: 'Guest through a share link', plain: true },
      { label: 'Change your name…', icon: 'pencil', onSelect: () => void renameGuest(me) },
      { label: 'Your documents', icon: 'file', onSelect: () => navigate('/') },
      'separator',
      { label: 'Sign in with Archipelago', icon: 'login', onSelect: () => startSignIn() },
      { label: 'Leave guest session', icon: 'logout', onSelect: () => void signOut(me) },
    ]
    : [
      { heading: me.sub },
      { label: 'All documents', icon: 'file', onSelect: () => navigate('/') },
      { label: 'People & agents', icon: 'users', onSelect: () => navigate('/people') },
      ...(me.admin ? [{ label: 'Admin', icon: 'shield', onSelect: () => navigate('/admin') }] : []),
      { label: 'Agent notifications', icon: 'bell', onSelect: () => void showWatches() },
      'separator',
      { label: 'Sign out', icon: 'logout', onSelect: () => void signOut() },
    ];
  const btn: HTMLButtonElement = h('button.user-chip', {
    type: 'button', 'aria-haspopup': 'menu', class: `${opts.compact ? 'compact' : ''} ${guest ? 'guest' : ''}`,
    onclick: () => openMenu(btn, items(), { align: 'end', className: 'user-menu' }),
  });
  const draw = () => {
    btn.setAttribute('aria-label', `Account: ${me.name}`);
    if (opts.compact) btn.setAttribute('data-tip', guest ? `You’re ${me.name}` : me.name);
    replaceChildren(btn, avatar(me, opts.compact ? 30 : 28),
      opts.compact ? null : h('span.user-chip-name', null, shownName(me)),
      opts.compact ? null : kindBadge(me.kind, { showHuman: true }),
      opts.compact ? null : icon('chevronDown', 16, 'chev'));
  };
  draw();
  // A guest's rename shows up here at once; the listener retires with the button.
  const off = onMeChanged(() => { if (!btn.isConnected) { off(); return; } draw(); });
  return btn;
}

/** "Sign in" for guests: become a member, keeping the way back to what they were looking at. */
export function guestSignInButton(opts: { compact?: boolean } = {}): HTMLButtonElement {
  return h('button.btn.guest-signin', { type: 'button', class: opts.compact ? 'sm' : '', 'data-tip': 'Sign in with Archipelago to create, share and keep documents', onclick: () => startSignIn() }, icon('login', 16), 'Sign in');
}

export function topBar(me: Me, active: 'docs' | 'people' | 'admin'): HTMLElement {
  const link = (href: string, label: string, ic: string, key: string) =>
    h('a.nav-link', { href, 'data-link': '', class: active === key ? 'active' : '', 'aria-current': active === key ? 'page' : undefined }, icon(ic, 17), h('span', null, label));
  const guest = isGuestMe(me);
  return h('header.topbar', null,
    h('a.brand', { href: '/', 'data-link': '', 'aria-label': 'Archipelago Docs home' }, logo(30), h('span.brand-name', null, 'Archipelago ', h('span.brand-docs', null, 'Docs'))),
    h('nav.nav', { 'aria-label': 'Main' },
      link('/', 'Documents', 'file', 'docs'),
      guest ? null : link('/people', 'People', 'users', 'people'),
      me.admin && !guest ? link('/admin', 'Admin', 'shield', 'admin') : null),
    h('div.topbar-right', null, guest ? guestSignInButton() : null, userMenuButton(me)));
}

async function showWatches() {
  const body = h('div.watches', null, h('div.side-loading', null, spinner(22)));
  openDialog({ title: 'Agent notifications', size: 'md', body });
  try {
    const { watches, defaults } = await api.watches();
    const fmt = (v: unknown) => (Array.isArray(v) ? (v.length ? v.join(', ') : '—') : v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    body.replaceChildren(
      h('p.dialog-help', null, 'When you work as an agent, these settings decide which document activity wakes you. Agents change them with the watch tools; they are shown here for reference.'),
      h('h3.share-section', null, 'Defaults'),
      h('dl.kv', null, Object.entries(defaults).map(([k, v]) => [h('dt', null, k), h('dd', null, fmt(v))])),
      h('h3.share-section', null, 'Watched documents'),
      watches.filter((w) => w.docId !== '*').length
        ? h('ul.watch-list', null, watches.filter((w) => w.docId !== '*').map((w) => h('li', null, h('a', { href: `/d/${w.docId}`, 'data-link': '' }, w.docId), h('code', null, fmt(w.settings)))))
        : emptyState({ title: 'Nothing watched', text: 'You aren’t watching any documents.' }));
  } catch (e) {
    body.replaceChildren(emptyState({ title: 'Couldn’t load settings', text: errorMessage(e) }));
  }
}
