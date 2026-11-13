// Signing in with Archipelago in a popup, like signing in with Google: the page stays where it is, so where the
// person was doesn't have to survive a trip through other sites. When the popup comes back signed in, it says so
// on a same-origin BroadcastChannel (which still works when the trip through Google has cut the link between the
// two windows) and closes; the page then loads again, signed in. The page also asks the server when it gets
// focus back, in case the message was missed. A blocked popup means the same window, as before.

import { api, isGuestMe } from './api';
import { h } from './dom';

const CHANNEL = 'docs-signin';
/** Where this page goes once the popup has signed in; null when it isn't waiting on one. */
let returnTo: string | null = null;
let listening = false;

function finish() {
  const to = returnTo;
  if (to === null) return;
  returnTo = null;
  if (to === location.pathname) location.reload();
  else location.replace(to);
}

async function check() {
  if (returnTo === null) return;
  try {
    const { you } = await api.me();
    if (you && !isGuestMe(you)) finish();
  } catch { /* offline: the next focus asks again */ }
}

/** Open Archipelago's sign-in in a popup; false when the browser wouldn't (then it's this window). */
export function signInInPopup(to: string): boolean {
  const w = 520, ht = 720;
  const left = Math.max(0, (screen.width - w) / 2), top = Math.max(0, (screen.height - ht) / 3);
  let popup: Window | null = null;
  try { popup = window.open('/auth/login?popup=1', 'archipelago', `popup=yes,width=${w},height=${ht},left=${left},top=${top}`); } catch { /* blocked */ }
  if (!popup) return false;
  returnTo = to;
  if (!listening) {
    listening = true;
    try { new BroadcastChannel(CHANNEL).onmessage = (e) => { if (e.data === 'signed-in') finish(); }; } catch { /* the focus check covers it */ }
    window.addEventListener('focus', () => void check());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void check(); });
  }
  return true;
}

/**
 * In the popup, signed in: tell the page that opened it, and close. A browser may refuse to close the window
 * (the trip through Google can leave it no longer "opened by a script"); then it says so, and resolves if the
 * person chooses to carry on in this window.
 */
export function handOverFromPopup(root: HTMLElement): Promise<void> {
  try { new BroadcastChannel(CHANNEL).postMessage('signed-in'); } catch { /* the page asks the server when it gets focus */ }
  return new Promise((resolve) => {
    setTimeout(() => window.close(), 150);
    setTimeout(() => {
      root.replaceChildren(h('div.full-center', null, h('div.callback', null,
        h('p', null, 'You’re signed in. You can close this window.'),
        h('button.btn', { type: 'button', onclick: () => resolve() }, 'Carry on in this window'))));
    }, 700);
  });
}
