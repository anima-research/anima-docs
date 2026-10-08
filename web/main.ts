// Anima Docs: browser client entry.

import { api, isGuestMe, setUnauthorizedHandler, type Config, type Me } from './lib/api';
import { h } from './lib/dom';
import { installTooltips, emptyState, errorMessage } from './lib/ui';
import { icon } from './lib/icons';
import { setSessionMe, setSignInHandler, startSignIn } from './lib/session';
import { navigate, startRouter } from './router';
import { handleCallback, rememberReturn, renderSignIn, takeReturn } from './pages/signin';
import { mountHome } from './pages/home';
import { mountAdmin, mountPeople } from './pages/people';
import { mountLinkPage } from './pages/link';
import { topBar } from './pages/shell';
import { mountDocPage } from './editor/page';

const root = document.getElementById('app')!;
let me: Me | null = null;
let config: Config;
let cleanup: (() => void) | null = null;

function setMe(next: Me | null) {
  me = next;
  setSessionMe(next);
}

function unmount() {
  try { cleanup?.(); } catch (e) { console.error(e); }
  cleanup = null;
}

function render(path: string) {
  unmount();
  root.classList.remove('boot');
  root.removeAttribute('aria-busy');
  // Share links work signed in, as a guest, or signed out.
  const link = /^\/l\/([A-Za-z0-9_-]{20,40})$/.exec(path);
  if (link) {
    cleanup = mountLinkPage(root, { key: link[1], me, onMe: (you) => setMe(you) });
    window.scrollTo(0, 0);
    return;
  }
  if (!me) {
    rememberReturn(path);
    renderSignIn(root, config, { onSignedIn: signedIn });
    return;
  }
  const doc = /^\/d\/([A-Za-z0-9]+)$/.exec(path);
  if (doc) cleanup = mountDocPage(root, me, doc[1]);
  else if ((path === '/people' || path === '/admin') && isGuestMe(me)) renderMembersOnly(me);
  else if (path === '/people') cleanup = mountPeople(root, me);
  else if (path === '/admin') cleanup = mountAdmin(root, me);
  else if (path === '/' || path === '/auth/callback') cleanup = mountHome(root, me);
  else {
    root.replaceChildren(h('div.full-center', null, emptyState({ art: icon('alert', 40, 'empty-art-icon'), title: 'Page not found', text: 'That address doesn’t lead anywhere.', action: h('a.btn.primary', { href: '/', 'data-link': '' }, 'Go to documents') })));
  }
  window.scrollTo(0, 0);
}

function signedIn(you: Me) {
  setMe(you);
  navigate(takeReturn(), { replace: true });
}

/** Guests reached a members-only page (people, admin). */
function renderMembersOnly(guest: Me) {
  document.title = 'Sign in · Anima Docs';
  root.replaceChildren(h('div.page-shell', null, topBar(guest, 'people'), h('main.home', null, emptyState({
    art: icon('lock', 40, 'empty-art-icon'),
    title: 'Sign in to see this page',
    text: 'Guests can open the documents shared with them through links. Sign in with Archipelago to see people and agents, and to create and share documents.',
    action: h('div.row-gap', null,
      h('button.btn.primary', { type: 'button', onclick: () => startSignIn() }, icon('login', 16), 'Sign in with Archipelago'),
      h('a.btn', { href: '/', 'data-link': '' }, 'Your documents')),
  }))));
}

/** Sign in, then come back to `returnTo`: Archipelago when configured, else the development form. */
function signInReturning(returnTo: string) {
  rememberReturn(returnTo);
  if (config.issuer) { location.assign('/auth/login'); return; }
  unmount();
  renderSignIn(root, config, { onSignedIn: signedIn });
}

async function boot() {
  installTooltips();
  try {
    const [cfg, who] = await Promise.all([api.config(), api.me()]);
    config = cfg;
    setMe(who.you);
  } catch (e) {
    root.classList.remove('boot');
    root.replaceChildren(h('div.full-center', null, emptyState({ art: icon('offline', 40, 'empty-art-icon'), title: 'Can’t reach Anima Docs', text: errorMessage(e), action: h('button.btn.primary', { type: 'button', onclick: () => location.reload() }, 'Try again') })));
    return;
  }

  setUnauthorizedHandler(() => {
    if (!me) return;
    setMe(null);
    render(location.pathname);
  });
  setSignInHandler(signInReturning);

  if (location.pathname === '/auth/callback') {
    root.classList.remove('boot');
    const r = await handleCallback(root);
    if (r.me) { setMe(r.me); history.replaceState(null, '', takeReturn()); }
    else {
      history.replaceState(null, '', '/');
      renderSignIn(root, config, { error: r.error, onSignedIn: signedIn });
      startRouterLater();
      return;
    }
  }
  startRouter(render);
  keepSessionAlive();
}

/**
 * A tab left open for days (one document, only its live connection) still
 * renews the session: the server extends it on any read, at most daily.
 */
function keepSessionAlive() {
  let last = Date.now();
  const touch = () => { if (!me || Date.now() - last < 3600_000) return; last = Date.now(); void api.me().catch(() => undefined); };
  window.setInterval(touch, 6 * 3600_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') touch(); });
}

/** After a failed callback the sign-in page is up; route normally once signed in. */
function startRouterLater() {
  startRouter((path) => { if (me) render(path); });
}

void boot();
