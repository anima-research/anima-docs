// Sign-in: Archipelago identity (production) or the local development issuer.

import { api, type Config, type Me } from '../lib/api';
import { h } from '../lib/dom';
import { icon, logo } from '../lib/icons';
import { errorMessage, spinner } from '../lib/ui';

const RETURN_KEY = 'docs.returnTo';

export function rememberReturn(path: string) {
  try { if (path && path !== '/' && !path.startsWith('/auth/')) sessionStorage.setItem(RETURN_KEY, path); } catch { /* ignore */ }
}
export function takeReturn(): string {
  try { const p = sessionStorage.getItem(RETURN_KEY); sessionStorage.removeItem(RETURN_KEY); if (p && p.startsWith('/') && !p.startsWith('//')) return p; } catch { /* ignore */ }
  return '/';
}

export function renderSignIn(root: HTMLElement, config: Config, opts: { error?: string; onSignedIn: (me: Me) => void }) {
  document.title = 'Sign in · Archipelago Docs';
  const errorEl = h('div.form-error', { role: 'alert', hidden: !opts.error }, opts.error ?? '');
  const showError = (m: string) => { errorEl.textContent = m; errorEl.hidden = false; };

  const parts: (HTMLElement | null)[] = [];
  if (config.issuer) {
    parts.push(h('a.btn.primary.lg.block', { href: '/auth/login', onclick: () => rememberReturn(location.pathname) }, icon('shield', 18), 'Sign in with Archipelago'),
      h('p.signin-fine', null, 'You’ll confirm who you are on ', h('strong', null, config.issuer), ', then come right back.'));
  }
  if (config.dev) {
    const name = h('input.input.lg', { type: 'text', name: 'name', placeholder: 'Your name', autocomplete: 'name', required: true, maxlength: '60', 'aria-label': 'Your name', autofocus: true });
    const admin = h('input', { type: 'checkbox', name: 'admin' });
    const submit = h('button.btn.primary.lg.block', { type: 'submit' }, 'Continue');
    const form = h('form.dev-form', {
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const n = name.value.trim();
        if (!n) { showError('Enter a name to sign in.'); name.focus(); return; }
        submit.disabled = true;
        submit.replaceChildren(spinner(16), 'Signing in…');
        try {
          const { you } = await api.devLogin(n, admin.checked);
          opts.onSignedIn(you);
        } catch (err) {
          showError(errorMessage(err));
          submit.disabled = false;
          submit.textContent = 'Continue';
        }
      },
    },
    config.issuer ? h('div.or', null, h('span', null, 'or')) : null,
    h('div.dev-banner', null, icon('alert', 16), h('span', null, h('strong', null, 'Development sign-in.'), ' Anyone who can reach this server can sign in as anyone. Never enable it in production.')),
    h('label.field', null, h('span.field-label', null, 'Name'), name),
    h('label.check', null, admin, h('span', null, 'Sign in as an administrator')),
    submit);
    parts.push(form);
  }
  if (!config.issuer && !config.dev) parts.push(h('p.signin-fine', null, 'No sign-in method is configured on this server.'));

  root.replaceChildren(h('main.signin', null,
    h('div.signin-card', null,
      h('div.signin-brand', null, logo(52)),
      h('h1', null, 'Archipelago Docs'),
      h('p.signin-lede', null, 'Live documents where people and agents write, edit and discuss together.'),
      errorEl,
      ...parts),
    h('p.signin-foot', null, 'Signing in uses your Archipelago identity. Agents connect separately over MCPL.')));
  (root.querySelector('input[autofocus]') as HTMLInputElement | null)?.focus();
}

/** /auth/callback#token=aid1… → exchange for a session, then leave the URL clean. */
export async function handleCallback(root: HTMLElement): Promise<{ me: Me | null; error?: string }> {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const token = params.get('token');
  const state = params.get('state');
  const err = params.get('error');
  history.replaceState(null, '', '/auth/callback');
  root.replaceChildren(h('div.full-center', null, h('div.callback', null, spinner(26), h('p', null, 'Signing you in…'))));
  if (!token) return { me: null, error: err ? `Sign-in was cancelled (${err}).` : 'The sign-in link was incomplete. Try again.' };
  try {
    const { you } = await api.exchange(token, state);
    return { me: you };
  } catch (e) {
    return { me: null, error: errorMessage(e) };
  }
}
