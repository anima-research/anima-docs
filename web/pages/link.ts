// Share link landing: /l/<key>.
//
// Peek first. Anyone signed in (a member, or a guest on an "anyone" link)
// opens the document straight away at its normal /d/<id> address. Signed-out
// visitors choose between continuing as a guest and signing in; "members"
// links ask for a sign-in. Dead links say so plainly.

import { api, ApiError, isGuestMe, ROLE_VERB, type LinkPeek, type Me } from '../lib/api';
import { h, type Child } from '../lib/dom';
import { icon, logo } from '../lib/icons';
import { errorMessage, spinner } from '../lib/ui';
import { rememberLinkKey, startSignIn } from '../lib/session';
import { navigate } from '../router';

export function mountLinkPage(root: HTMLElement, opts: { key: string; me: Me | null; onMe: (me: Me) => void }): () => void {
  let destroyed = false;
  const path = `/l/${opts.key}`;
  document.title = 'Shared document · Anima Docs';

  const frame = (...children: Child[]) => {
    if (destroyed) return;
    root.replaceChildren(h('main.signin.link-landing', null,
      h('div.signin-card.link-card', { role: 'region', 'aria-label': 'Share link' }, ...children),
      h('p.signin-foot', null, 'Anima Docs: live documents where people and agents write together.')));
    (root.querySelector('[autofocus]') as HTMLElement | null)?.focus();
  };

  const loading = (text: string) => frame(h('div.link-loading', { role: 'status' }, spinner(26), h('p', null, text)));

  const signInButton = (primary: boolean) => h('button.btn.lg.block', { type: 'button', class: primary ? 'primary' : '', onclick: () => startSignIn(path) }, icon('shield', 18), 'Sign in with Archipelago');

  const dead = (message?: string) => {
    document.title = 'Link not working · Anima Docs';
    frame(
      h('div.link-art.dead', { 'aria-hidden': 'true' }, icon('unlink', 26)),
      h('h1', null, 'This link no longer works'),
      h('p.signin-lede', null, message ?? 'It may have expired or been turned off. Ask whoever sent it for a new one.'),
      opts.me ? h('a.btn.lg.block', { href: '/', 'data-link': '' }, isGuestMe(opts.me) ? 'Your documents' : 'Go to documents') : null);
  };

  const failed = (message: string, retry: () => void) => frame(
    h('div.link-art.dead', { 'aria-hidden': 'true' }, icon('alert', 26)),
    h('h1', null, 'Couldn’t open this link'),
    h('p.signin-lede', null, message),
    h('button.btn.primary.lg.block', { type: 'button', onclick: retry }, 'Try again'));

  /** "Members" links: sign in first (guests too: their guest identity can't use it). */
  const membersOnly = (peek: LinkPeek) => {
    document.title = 'Sign in to open · Anima Docs';
    frame(
      h('div.link-art', { 'aria-hidden': 'true' }, icon('users', 26)),
      h('h1', null, 'Sign in with Archipelago to open this document'),
      h('p.signin-lede', null, `This link is for Archipelago members. Once you’re signed in it opens right away, and you can ${ROLE_VERB[peek.role ?? 'viewer']}.`),
      signInButton(true),
      peek.guest && opts.me ? h('p.signin-fine', null, 'You’re browsing as ', h('strong', null, opts.me.name), '. Guests can’t open members-only links.') : null);
  };

  /** "Anyone" links, signed out: continue as a guest, or sign in. */
  const choose = (peek: LinkPeek, error?: string) => {
    document.title = `${peek.title ?? 'Shared document'} · Anima Docs`;
    const name = h('input.input.lg', { type: 'text', name: 'name', placeholder: 'How others will see you', autocomplete: 'nickname', maxlength: '40', 'aria-label': 'Your name (optional)', 'aria-describedby': 'guest-name-hint', autofocus: true });
    const hint = h('p.field-hint#guest-name-hint');
    const drawHint = () => {
      const n = name.value.replace(/\s+/g, ' ').trim();
      hint.replaceChildren(n ? h('span', null, 'Others will see you as ', h('strong', null, `${n} (guest)`), '.') : 'Leave it blank to appear as an anonymous animal, like “Anonymous Heron (guest)”.');
    };
    name.addEventListener('input', drawHint);
    drawHint();
    const go = h('button.btn.primary.lg.block', { type: 'submit' }, 'Continue as guest');
    const errorEl = h('div.form-error', { role: 'alert', hidden: !error }, error ?? '');
    const form = h('form.guest-form', {
      onsubmit: (e: Event) => {
        e.preventDefault();
        go.disabled = true;
        go.replaceChildren(spinner(16), 'Opening…');
        void redeem(peek, name.value.trim() || undefined, (msg) => {
          errorEl.textContent = msg; errorEl.hidden = false;
          go.disabled = false; go.textContent = 'Continue as guest';
        });
      },
    }, h('label.field', null, h('span.field-label', null, 'Your name ', h('span.field-optional', null, '(optional)')), name, hint), go);
    frame(
      h('div.signin-brand', null, logo(40)),
      h('p.link-kicker', null, 'You’ve been sent a document'),
      h('div.link-doc', null,
        h('span.doc-icon', { 'aria-hidden': 'true' }, icon('file', 20)),
        h('div.link-doc-main', null,
          h('div.link-doc-title', null, peek.title ?? 'Untitled document'),
          h('div.link-doc-role', null, icon('globe', 13), `Anyone with the link can ${ROLE_VERB[peek.role ?? 'viewer']}`))),
      errorEl,
      form,
      h('div.or', null, h('span', null, 'or')),
      signInButton(false),
      h('p.signin-fine', null, 'Guests can open this document while the link stays on. Sign in to keep documents, make your own and share them.'));
  };

  /** Open the link: on success the document opens at /d/<id>, which stays reachable while the link is on. */
  async function redeem(peek: LinkPeek, name: string | undefined, onError?: (msg: string) => void) {
    try {
      const r = await api.redeemLink(opts.key, name);
      if (destroyed) return;
      rememberLinkKey(r.docId, opts.key);
      opts.onMe(r.you);
      navigate(`/d/${r.docId}`, { replace: true });
    } catch (e) {
      if (destroyed) return;
      if (e instanceof ApiError && e.status === 404) dead();
      else if (e instanceof ApiError && e.status === 401) membersOnly({ ...peek, audience: 'members' });
      else if (onError) onError(errorMessage(e));
      else failed(errorMessage(e), () => void start());
    }
  }

  async function start() {
    loading('Opening link…');
    let peek: LinkPeek;
    try { peek = await api.peekLink(opts.key); } catch (e) {
      if (destroyed) return;
      if (e instanceof ApiError && e.status === 404) { dead(); return; }
      failed(errorMessage(e), () => void start());
      return;
    }
    if (destroyed) return;
    if (!peek.active) { dead(); return; }
    if (peek.signedIn || (peek.guest && peek.audience === 'anyone')) {
      loading(peek.title ? `Opening “${peek.title}”…` : 'Opening document…');
      await redeem(peek, undefined);
    } else if (peek.audience === 'anyone') choose(peek);
    else membersOnly(peek);
  }

  void start();
  return () => { destroyed = true; };
}
