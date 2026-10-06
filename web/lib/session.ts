// Who is using the app, shared by every page: a guest's rename reaches each
// place that shows them, and any page can start sign-in that comes back here.

import type { Me } from './api';

let current: Me | null = null;
const listeners = new Set<(me: Me) => void>();

export function currentMe(): Me | null { return current; }
/** A guest: someone who opened an "anyone with the link" share link without signing in. */
export function isGuestSession(): boolean { return current?.kind === 'guest'; }
export function setSessionMe(me: Me | null) { current = me; }

/** The same principal changed (a guest renamed): update it in place and tell everyone showing it. */
export function updateMe(next: Me) {
  if (current && current.sub === next.sub) Object.assign(current, next);
  else current = next;
  for (const fn of [...listeners]) { try { fn(current); } catch (e) { console.error(e); } }
}
export function onMeChanged(fn: (me: Me) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// ------------------------------------------------------------------ sign-in from anywhere

let signInHandler: (returnTo: string) => void = () => location.assign('/');
export function setSignInHandler(fn: (returnTo: string) => void) { signInHandler = fn; }
/** Sign in with Archipelago, then come back to `returnTo` (default: here, or the link that brought a guest here). */
export function startSignIn(returnTo = signInReturnPath()) { signInHandler(returnTo); }

/** A guest on a document they reached through a link comes back through that link once signed in. */
function signInReturnPath(): string {
  const m = /^\/d\/([A-Za-z0-9]+)$/.exec(location.pathname);
  const key = m && isGuestSession() ? linkKeyFor(m[1]) : null;
  return key ? `/l/${key}` : location.pathname;
}

// ------------------------------------------------------------------ links this browser came through

const LINKS_KEY = 'docs.linkKeys';
function readKeys(): Record<string, string> {
  try { const v = JSON.parse(localStorage.getItem(LINKS_KEY) ?? '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
/** Remember which share link opened a document, so a guest who signs in comes back through it. */
export function rememberLinkKey(docId: string, key: string) {
  try {
    const keys = readKeys();
    delete keys[docId];
    keys[docId] = key;
    const entries = Object.entries(keys).slice(-50);
    localStorage.setItem(LINKS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* storage may be blocked */ }
}
export function linkKeyFor(docId: string): string | null {
  const k = readKeys()[docId];
  return typeof k === 'string' && /^[A-Za-z0-9_-]{20,40}$/.test(k) ? k : null;
}
