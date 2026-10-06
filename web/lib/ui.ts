// Shared UI pieces: avatars, badges, toasts, dialogs, menus, tooltips.

import { h, type Child } from './dom';
import { icon } from './icons';
import { guestBase, initials, kindLabel, splitLabel } from './format';
import type { Kind } from './api';

// ------------------------------------------------------------------ avatars & badges

export interface Who { name: string; color?: string; kind?: Kind | string; label?: string; sub?: string }

export function avatar(who: Who, size = 28, opts: { ring?: boolean; title?: string } = {}): HTMLElement {
  const isAgent = who.kind === 'agent' || who.kind === 'service';
  const isGuest = who.kind === 'guest';
  const el = h('span.avatar', {
    class: `${isAgent ? 'is-agent' : ''} ${isGuest ? 'is-guest' : ''} ${opts.ring ? 'ring' : ''}`,
    style: `--av:${who.color ?? '#5f6368'};--sz:${size}px`,
    title: opts.title,
    'aria-label': opts.title,
    role: opts.title ? 'img' : undefined,
  }, h('span.avatar-initials', null, initials(isGuest ? guestBase(who.name) : who.name)));
  if (isAgent) el.append(h('span.avatar-badge', { 'aria-hidden': 'true' }, icon('sparkle', Math.max(8, Math.round(size * 0.36)))));
  else if (isGuest && size >= 22) el.append(h('span.avatar-badge.guest', { 'aria-hidden': 'true' }, icon('link', Math.max(8, Math.round(size * 0.3)))));
  return el;
}

export function kindBadge(kind: Kind | string | undefined, opts: { showHuman?: boolean; compact?: boolean } = {}): HTMLElement | null {
  if (kind === 'guest') return h('span.kind-badge.kind-guest', { title: 'Guest: opened a share link without signing in' }, 'Guest');
  if (kind !== 'agent' && kind !== 'service' && !opts.showHuman) return null;
  const k = kind === 'agent' || kind === 'service' ? kind : 'human';
  return h('span.kind-badge', { class: `kind-${k} ${opts.compact ? 'compact' : ''}`, title: kindLabel(k) },
    k === 'human' ? null : icon(k === 'agent' ? 'sparkle' : 'bot', 11), opts.compact && k !== 'human' ? null : kindLabel(k));
}

/** The name to show next to a kind badge: a guest's "(guest)" becomes the Guest chip. */
export function shownName(who: { name: string; kind?: Kind | string }): string {
  return who.kind === 'guest' ? guestBase(who.name) : who.name;
}

export function issuerBadge(label: string | undefined): HTMLElement | null {
  if (!label) return null;
  const { issuer } = splitLabel(label);
  return issuer ? h('span.issuer-badge', { title: `Verified by ${issuer}` }, icon('check', 10), issuer) : null;
}

/** Name + kind badge + issuer badge. */
export function personName(who: Who, opts: { showHuman?: boolean; you?: boolean } = {}): HTMLElement {
  const { name } = splitLabel(who.label ?? who.name);
  return h('span.person-name', null,
    h('span.pn-text', null, who.name ? shownName({ name: who.name, kind: who.kind }) : name),
    opts.you ? h('span.you-tag', null, '(you)') : null,
    kindBadge(who.kind, { showHuman: opts.showHuman }),
    issuerBadge(who.label));
}

// ------------------------------------------------------------------ toasts

let toastHost: HTMLElement | null = null;
export function toast(message: Child, opts: { kind?: 'info' | 'success' | 'error' | 'mention'; action?: { label: string; onClick: () => void }; timeout?: number } = {}) {
  if (!toastHost) {
    toastHost = h('div.toast-host', { role: 'region', 'aria-live': 'polite', 'aria-label': 'Notifications' });
    // As a popover the host sits in the top layer, above any open modal dialog.
    if ('showPopover' in toastHost) toastHost.setAttribute('popover', 'manual');
    document.body.append(toastHost);
  }
  const host = toastHost;
  const kind = opts.kind ?? 'info';
  const close = () => {
    el.classList.add('leaving');
    setTimeout(() => {
      el.remove();
      if (!host.childElementCount && host.hasAttribute('popover')) { try { host.hidePopover(); } catch { /* not open */ } }
    }, 180);
  };
  const el = h('div.toast', { class: `toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    kind === 'error' ? icon('alert', 18, 'toast-icon') : kind === 'success' ? icon('checkCircle', 18, 'toast-icon') : kind === 'mention' ? icon('at', 18, 'toast-icon') : null,
    h('div.toast-msg', null, message),
    opts.action ? h('button.toast-action', { type: 'button', onclick: () => { opts.action!.onClick(); close(); } }, opts.action.label) : null,
    h('button.toast-close.icon-btn.sm', { type: 'button', 'aria-label': 'Dismiss', onclick: close }, icon('x', 16)));
  host.append(el);
  // Keep the stack short: the oldest toasts make way.
  const live = [...host.querySelectorAll<HTMLElement>('.toast:not(.leaving)')];
  for (const old of live.slice(0, Math.max(0, live.length - 3))) { old.classList.add('leaving'); setTimeout(() => old.remove(), 180); }
  if (host.hasAttribute('popover')) {
    try { if (host.matches(':popover-open')) host.hidePopover(); host.showPopover(); } catch { /* unsupported */ }
  }
  const ms = opts.timeout ?? (kind === 'error' ? 7000 : opts.action ? 9000 : 4000);
  if (ms > 0) setTimeout(close, ms);
  return close;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ------------------------------------------------------------------ dialogs

export interface DialogHandle { el: HTMLDialogElement; body: HTMLElement; close: () => void; setBusy: (b: boolean) => void }

export function openDialog(opts: {
  title: Child;
  body: Child;
  footer?: Child;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  onClose?: () => void;
  className?: string;
  label?: string;
}): DialogHandle {
  const body = h('div.dialog-body', null, opts.body);
  const el = h('dialog.dialog', { class: `dialog-${opts.size ?? 'md'} ${opts.className ?? ''}`, 'aria-label': opts.label },
    h('div.dialog-card', null,
      h('header.dialog-head', null,
        h('h2.dialog-title', null, opts.title),
        h('button.icon-btn.dialog-x', { type: 'button', 'aria-label': 'Close dialog', onclick: () => close() }, icon('x', 18))),
      body,
      opts.footer ? h('footer.dialog-foot', null, opts.footer) : null));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.classList.add('closing');
    setTimeout(() => { el.close(); el.remove(); }, 120);
    opts.onClose?.();
  };
  el.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  el.addEventListener('mousedown', (e) => { if (e.target === el) close(); });
  document.body.append(el);
  el.showModal();
  const first = el.querySelector<HTMLElement>('[autofocus], input:not([type=hidden]):not([disabled]), textarea, select');
  (first ?? el.querySelector<HTMLElement>('.dialog-foot .btn.primary'))?.focus();
  return {
    el, body, close,
    setBusy: (b) => el.classList.toggle('busy', b),
  };
}

export function confirmDialog(opts: { title: string; message: Child; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => { if (!done) { done = true; resolve(v); } d.close(); };
    const ok = h('button.btn', { type: 'button', class: opts.danger ? 'danger' : 'primary', onclick: () => finish(true) }, opts.confirmLabel ?? 'OK');
    const d = openDialog({
      title: opts.title, size: 'sm',
      body: h('div.dialog-text', null, opts.message),
      footer: [h('button.btn.ghost', { type: 'button', onclick: () => finish(false) }, 'Cancel'), ok],
      onClose: () => { if (!done) { done = true; resolve(false); } },
    });
    ok.focus();
  });
}

export function promptDialog(opts: { title: string; label: string; value?: string; placeholder?: string; confirmLabel?: string; help?: Child; maxLength?: number; validate?: (v: string) => string | null }): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input.input', { type: 'text', value: opts.value ?? '', placeholder: opts.placeholder ?? '', 'aria-label': opts.label, autofocus: true, maxlength: opts.maxLength ? String(opts.maxLength) : undefined });
    const err = h('div.field-error', { role: 'alert' });
    const submit = () => {
      const v = input.value.trim();
      const problem = opts.validate?.(v) ?? null;
      if (problem) { err.textContent = problem; input.focus(); return; }
      done = true; resolve(v); d.close();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    const d = openDialog({
      title: opts.title, size: 'sm',
      body: [opts.help ? h('p.dialog-help', null, opts.help) : null, h('label.field', null, h('span.field-label', null, opts.label), input, err)],
      footer: [h('button.btn.ghost', { type: 'button', onclick: () => d.close() }, 'Cancel'), h('button.btn.primary', { type: 'button', onclick: submit }, opts.confirmLabel ?? 'OK')],
      onClose: () => { if (!done) { done = true; resolve(null); } },
    });
    input.select();
  });
}

// ------------------------------------------------------------------ menus

export type MenuItem =
  | { label: string; icon?: string; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string; checked?: boolean }
  | 'separator'
  | { heading: string; plain?: boolean };

let openMenuClose: (() => void) | null = null;

export function openMenu(anchor: HTMLElement, items: MenuItem[], opts: { align?: 'start' | 'end'; className?: string } = {}): () => void {
  openMenuClose?.();
  const menu = h('div.menu', { role: 'menu', class: opts.className });
  const buttons: HTMLButtonElement[] = [];
  for (const it of items) {
    if (it === 'separator') { menu.append(h('div.menu-sep', { role: 'separator' })); continue; }
    if ('heading' in it) { menu.append(h('div.menu-heading', { class: it.plain ? 'plain' : '' }, it.heading)); continue; }
    const b = h('button.menu-item', {
      type: 'button', role: it.checked === undefined ? 'menuitem' : 'menuitemradio', 'aria-checked': it.checked === undefined ? undefined : String(it.checked),
      class: it.danger ? 'danger' : '', disabled: it.disabled,
      onclick: () => { close(); it.onSelect(); },
    }, it.checked !== undefined ? h('span.menu-check', null, it.checked ? icon('check', 16) : null) : it.icon ? icon(it.icon, 16) : null,
      h('span.menu-label', null, it.label), it.hint ? h('span.menu-hint', null, it.hint) : null);
    buttons.push(b);
    menu.append(b);
  }
  document.body.append(menu);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let left = opts.align === 'end' ? r.right - mw : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
    let top = r.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  };
  place();
  anchor.setAttribute('aria-expanded', 'true');
  const onDoc = (e: MouseEvent) => { if (!menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
  const onKey = (e: KeyboardEvent) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') { e.preventDefault(); close(); anchor.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length]?.focus(); }
    else if (e.key === 'Tab') close();
  };
  const onScroll = (e: Event) => { if (!menu.contains(e.target as Node)) close(); };
  setTimeout(() => {
    document.addEventListener('mousedown', onDoc, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
  });
  document.addEventListener('keydown', onKey, true);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', onScroll, true);
    if (openMenuClose === close) openMenuClose = null;
  }
  openMenuClose = close;
  buttons.find((b) => !b.disabled)?.focus({ preventScroll: true });
  return close;
}

// ------------------------------------------------------------------ tooltips

let tipEl: HTMLElement | null = null;
let tipFor: Element | null = null;
let tipTimer = 0;

export function installTooltips() {
  const show = (target: HTMLElement) => {
    const text = target.dataset.tip;
    if (!text) return;
    if (!tipEl) tipEl = h('div.tooltip', { role: 'tooltip' });
    const layer = target.closest('dialog') ?? document.body;
    if (tipEl.parentElement !== layer) layer.append(tipEl);
    tipEl.textContent = text;
    tipEl.classList.add('visible');
    const r = target.getBoundingClientRect();
    const w = tipEl.offsetWidth, th = tipEl.offsetHeight;
    let top = r.bottom + 6;
    if (top + th > window.innerHeight - 4) top = r.top - th - 6;
    tipEl.style.left = `${Math.max(4, Math.min(window.innerWidth - w - 4, r.left + r.width / 2 - w / 2))}px`;
    tipEl.style.top = `${top}px`;
    tipFor = target;
  };
  const hide = () => { clearTimeout(tipTimer); tipEl?.classList.remove('visible'); tipFor = null; };
  document.addEventListener('mouseover', (e) => {
    const t = (e.target as Element).closest?.('[data-tip]') as HTMLElement | null;
    if (t === tipFor) return;
    hide();
    if (t) tipTimer = window.setTimeout(() => show(t), 380);
  });
  document.addEventListener('focusin', (e) => {
    const t = (e.target as Element).closest?.('[data-tip]') as HTMLElement | null;
    hide();
    if (t && t.matches(':focus-visible')) show(t);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('mousedown', hide, true);
  window.addEventListener('scroll', hide, true);
}

// ------------------------------------------------------------------ misc

export function spinner(size = 18): HTMLElement {
  return h('span.spinner', { style: `--sz:${size}px`, role: 'progressbar', 'aria-label': 'Loading' });
}

export function emptyState(opts: { art?: Node; title: string; text?: Child; action?: Child }): HTMLElement {
  return h('div.empty-state', null, opts.art ?? null, h('h3.empty-title', null, opts.title), opts.text ? h('p.empty-text', null, opts.text) : null, opts.action ?? null);
}

export function iconButton(name: string, label: string, onClick: (e: MouseEvent) => void, opts: { cls?: string; tip?: string; size?: number; pressed?: boolean } = {}): HTMLButtonElement {
  return h('button.icon-btn', {
    type: 'button', 'aria-label': label, 'data-tip': opts.tip ?? label, class: opts.cls,
    'aria-pressed': opts.pressed === undefined ? undefined : String(opts.pressed),
    onclick: onClick,
  }, icon(name, opts.size ?? 18));
}
