// Share dialog: add people, people with access, general access, and share links.

import { api, atLeast, ROLE_LABEL, ROLE_VERB, type DocDetail, type GeneralAccess, type LinkRole, type LinkWho, type Me, type Person, type Role, type ShareLink } from '../lib/api';
import { h, replaceChildren } from '../lib/dom';
import { icon } from '../lib/icons';
import { plural, splitLabel, untilTime } from '../lib/format';
import { peoplePicker } from '../lib/picker';
import { personBySub, searchPeople } from '../lib/people';
import { avatar, confirmDialog, errorMessage, issuerBadge, kindBadge, openDialog, spinner, toast } from '../lib/ui';

const GENERAL: { value: GeneralAccess; label: string; help: string }[] = [
  { value: 'restricted', label: 'Restricted', help: 'Only people added here, or who open an active share link, can open it' },
  { value: 'viewer', label: 'Archipelago members can view', help: 'Anyone signed in with Archipelago can find and read it' },
  { value: 'commenter', label: 'Archipelago members can comment', help: 'Anyone signed in with Archipelago can read and comment' },
  { value: 'editor', label: 'Archipelago members can edit', help: 'Anyone signed in with Archipelago can make changes' },
];

const WHO_LABEL: Record<LinkWho, string> = { anyone: 'Anyone with the link', members: 'Archipelago members with the link' };
const EXPIRY: { value: string; label: string; days: number | null }[] = [
  { value: 'never', label: 'Never expires', days: null },
  { value: '1', label: 'Expires in 1 day', days: 1 },
  { value: '7', label: 'Expires in 7 days', days: 7 },
  { value: '30', label: 'Expires in 30 days', days: 30 },
];
const ANYONE_OWNER_ONLY = 'Only the owner can make links that work without signing in';

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** Copy, or show the text to copy by hand when the clipboard is unavailable. */
async function copyWithToast(text: string, done: string) {
  if (await copyText(text)) toast(done, { kind: 'success', timeout: 2200 });
  else toast(h('span', null, 'Copy this link: ', h('code.toast-url', null, text)), { kind: 'info', timeout: 12000 });
}

export function openShareDialog(opts: { docId: string; me: Me; title: string; onChanged?: (doc: DocDetail) => void }) {
  let doc: DocDetail | null = null;
  let links: ShareLink[] | null = null;
  let linksError: string | null = null;
  let addRole: Role = 'editor';
  const errorEl = h('div.form-error', { role: 'alert', hidden: true });
  const listEl = h('div.share-list', { 'aria-label': 'People with access' }, h('div.share-loading', null, spinner(20)));
  const generalEl = h('div.share-general');
  const linksEl = h('section.share-links', { 'aria-label': 'Share links', hidden: true });
  const addRow = h('div.share-add');

  const showError = (msg: string | null) => { errorEl.hidden = !msg; errorEl.textContent = msg ?? ''; };

  const myRole = (): Role => doc?.role ?? 'viewer';
  let primed = false;
  const reload = async () => {
    try {
      if (!primed) { primed = true; await searchPeople('').catch(() => undefined); }
      doc = await api.doc(opts.docId);
      render();
      opts.onChanged?.(doc);
    } catch (e) { showError(errorMessage(e)); }
  };
  const reloadLinks = async () => {
    try { links = (await api.links(opts.docId)).links; linksError = null; }
    catch (e) { linksError = errorMessage(e); }
    renderLinks();
  };

  const share = async (who: string, role: Role | 'none', label: string) => {
    showError(null);
    d.setBusy(true);
    try {
      await api.share(opts.docId, who, role);
      await reload();
      if (role === 'none') toast(`Removed ${label}`, { kind: 'success', timeout: 2500 });
      else if (role === 'owner') toast(`${label} is now the owner`, { kind: 'success' });
      else toast(`${label} can now ${ROLE_VERB[role]}`, { kind: 'success', timeout: 2500 });
    } catch (e) {
      showError(errorMessage(e));
    } finally { d.setBusy(false); }
  };

  const picker = peoplePicker({
    placeholder: 'Add people or agents by name',
    label: 'Add people or agents',
    exclude: () => new Set([...(doc?.acl.map((a) => a.sub) ?? []), doc?.owner.sub ?? '']),
    onPick: (p: Person) => void share(p.sub, addRole, p.name),
    onRaw: (text) => void share(text, addRole, text.replace(/^@/, '')),
  });

  const roleSelect = (value: Role, onChange: (r: Role | 'none' | 'transfer') => void, opts2: { owner: boolean; label: string }) => {
    const sel = h('select.select.sm', { 'aria-label': opts2.label },
      (['viewer', 'commenter', 'editor'] as Role[]).map((r) => h('option', { value: r, selected: r === value }, ROLE_LABEL[r])),
      opts2.owner ? h('option', { disabled: true }, '──────────') : null,
      opts2.owner ? h('option', { value: 'transfer' }, 'Make owner') : null,
      opts2.owner ? h('option', { value: 'none' }, 'Remove access') : null);
    sel.addEventListener('change', () => {
      const v = sel.value as Role | 'none' | 'transfer';
      sel.value = value;
      onChange(v);
    });
    return sel;
  };

  function render() {
    if (!doc) return;
    const mine = myRole();
    const isOwner = atLeast(mine, 'owner');
    const canShare = atLeast(mine, 'editor');
    // Add people
    if (canShare) {
      const sel = h('select.select', { 'aria-label': 'Role for new people' },
        (['viewer', 'commenter', 'editor'] as Role[]).map((r) => h('option', { value: r, selected: r === addRole }, ROLE_LABEL[r])));
      sel.addEventListener('change', () => { addRole = sel.value as Role; });
      addRow.replaceChildren(picker.el, sel);
      addRow.hidden = false;
    } else addRow.hidden = true;

    // People with access
    const ownerName = splitLabel(doc.owner.label).name;
    const rows: HTMLElement[] = [
      h('div.share-row', null,
        avatar({ name: ownerName, kind: doc.owner.kind, color: personBySub(doc.owner.sub)?.color }, 34),
        h('div.share-who', null,
          h('div.share-name', null, ownerName, doc.owner.sub === opts.me.sub ? h('span.you-tag', null, '(you)') : null, kindBadge(doc.owner.kind), issuerBadge(doc.owner.label)),
          h('div.share-sub', null, doc.owner.sub)),
        h('div.share-role.fixed', null, 'Owner')),
    ];
    for (const a of doc.acl) {
      const name = a.name ?? splitLabel(a.label).name;
      const you = a.sub === opts.me.sub;
      const control = canShare && !you
        ? roleSelect(a.role === 'owner' ? 'editor' : a.role, (r) => {
          if (r === 'transfer') {
            void confirmDialog({ title: 'Transfer ownership?', message: h('span', null, h('strong', null, name), ' will become the owner. The current owner keeps editor access.'), confirmLabel: 'Transfer', danger: true })
              .then((ok) => { if (ok) void share(a.sub, 'owner', name); });
          } else void share(a.sub, r, name);
        }, { owner: isOwner, label: `Access for ${name}` })
        : h('div.share-role.fixed', null, ROLE_LABEL[a.role]);
      rows.push(h('div.share-row', null,
        avatar({ name, kind: a.kind, color: personBySub(a.sub)?.color }, 34),
        h('div.share-who', null,
          h('div.share-name', null, name, you ? h('span.you-tag', null, '(you)') : null, kindBadge(a.kind), issuerBadge(a.label)),
          h('div.share-sub', null, a.sub)),
        control));
    }
    listEl.replaceChildren(h('h3.share-section', null, 'People with access'), ...rows);

    // General access: Archipelago members only (guests come in through links)
    const g = GENERAL.find((x) => x.value === doc!.generalAccess) ?? GENERAL[0];
    const gIcon = h('span.ga-icon', { class: g.value === 'restricted' ? 'restricted' : 'open' }, icon(g.value === 'restricted' ? 'lock' : 'users', 18));
    let control: HTMLElement;
    if (isOwner) {
      const sel = h('select.select.ga-select', { 'aria-label': 'General access' }, GENERAL.map((x) => h('option', { value: x.value, selected: x.value === g.value }, x.label)));
      sel.addEventListener('change', async () => {
        showError(null);
        d.setBusy(true);
        try {
          await api.patchDoc(opts.docId, { generalAccess: sel.value as GeneralAccess });
          await reload();
        } catch (e) { showError(errorMessage(e)); sel.value = g.value; } finally { d.setBusy(false); }
      });
      control = sel;
    } else control = h('div.ga-text', null, g.label);
    generalEl.replaceChildren(h('h3.share-section', null, 'General access'),
      h('div.ga-row', null, gIcon, h('div.ga-main', null, control, h('div.ga-help', null, g.help, isOwner ? null : ' · Only the owner can change this.'))));
    // Links depend on the role only; re-rendering them on every reload would cut the new-link highlight short.
    if (linksRole !== mine) { linksRole = mine; renderLinks(); }
  }

  // ------------------------------------------------------------------ share links

  let formEl: HTMLElement | null = null;
  let flashId: string | null = null;
  let linksRole: Role | null = null;

  function renderLinks() {
    if (!doc) return;
    const isOwner = atLeast(myRole(), 'owner');
    const canShare = atLeast(myRole(), 'editor');
    // Viewers and commenters can't make links; show the section only if they somehow have some.
    if (!canShare && !links?.length) { linksEl.hidden = true; return; }
    linksEl.hidden = false;
    const head = h('div.share-section-row', null,
      h('h3.share-section', null, 'Share links'),
      canShare && !formEl ? h('button.btn.ghost.sm.link-create-btn', { type: 'button', onclick: () => openForm(isOwner) }, icon('plus', 16), 'Create link') : null);
    let body: (HTMLElement | null)[];
    if (linksError) body = [h('p.link-empty', null, `Couldn’t load links: ${linksError}`)];
    else if (!links) body = [h('div.share-loading.sm', null, spinner(18))];
    else if (!links.length) body = formEl ? [] : [h('p.link-empty', null, isOwner
      ? 'Make a link for people who aren’t on the list, including people without an Archipelago account. Turn it off any time.'
      : 'Make a link for Archipelago members who aren’t on the list. Turn it off any time.')];
    else body = [h('div.link-list', null, links.map(linkRow))];
    replaceChildren(linksEl, head, formEl, ...body);
  }

  function linkRow(l: ShareLink): HTMLElement {
    const anyone = l.who === 'anyone';
    const by = l.createdBy.sub === opts.me.sub ? 'you' : splitLabel(l.createdBy.label).name;
    const meta: (string | HTMLElement)[] = [];
    if (l.label) meta.push(h('span.link-label', null, l.label));
    meta.push(`Made by ${by}`);
    meta.push(l.holders ? `Opened by ${plural(l.holders, 'person', 'people')}` : 'Not opened yet');
    if (l.expiresAt) meta.push(h('span.link-expiry', null, icon('clock', 12), `Expires ${untilTime(l.expiresAt)}`));
    const what = `${WHO_LABEL[l.who]} can ${ROLE_VERB[l.role]}`;
    return h('div.link-row', { class: l.id === flashId ? 'new' : '', dataset: { link: l.id, who: l.who } },
      h('span.link-icon', { class: anyone ? 'anyone' : 'members' }, icon(anyone ? 'globe' : 'users', 17)),
      h('div.link-main', null,
        h('div.link-title', null, WHO_LABEL[l.who], h('span.link-role', null, ` · can ${ROLE_VERB[l.role]}`)),
        h('div.link-meta', null, meta.flatMap((m, i) => (i ? [h('span.dot-sep', { 'aria-hidden': 'true' }, '·'), m] : [m])))),
      h('button.btn.sm.link-copy', { type: 'button', 'aria-label': `Copy link: ${what}`, onclick: () => void copyWithToast(l.url, 'Link copied') }, icon('copy', 15), 'Copy'),
      h('button.icon-btn.sm.link-revoke', { type: 'button', 'aria-label': `Revoke link: ${what}`, 'data-tip': 'Turn off this link', onclick: () => void revoke(l) }, icon('trash', 16)));
  }

  function openForm(isOwner: boolean) {
    let who: LinkWho = 'members';
    const roleSel = h('select.select.sm', { 'aria-label': 'Link access' },
      (['viewer', 'commenter', 'editor'] as LinkRole[]).map((r) => h('option', { value: r, selected: r === 'viewer' }, `Can ${ROLE_VERB[r]}`)));
    const expirySel = h('select.select.sm', { 'aria-label': 'Link expiry' }, EXPIRY.map((x) => h('option', { value: x.value }, x.label)));
    const labelIn = h('input.input.sm', { type: 'text', placeholder: 'Label (optional)', 'aria-label': 'Link label', maxlength: '80' });
    const help = h('p.link-help');
    const seg = h('div.seg.link-who', { role: 'radiogroup', 'aria-label': 'Who can use the link' });
    const drawWho = () => {
      seg.replaceChildren(...(['anyone', 'members'] as LinkWho[]).map((w) => {
        const disabled = w === 'anyone' && !isOwner;
        return h('button.seg-btn', {
          type: 'button', role: 'radio', 'aria-checked': String(who === w), class: `${who === w ? 'on' : ''} ${disabled ? 'is-disabled' : ''}`,
          'aria-disabled': disabled ? 'true' : undefined, 'data-tip': disabled ? ANYONE_OWNER_ONLY : undefined,
          onclick: () => {
            if (disabled) { help.classList.remove('nudge'); void help.offsetWidth; help.classList.add('nudge'); return; }
            who = w; drawWho();
          },
        }, icon(w === 'anyone' ? 'globe' : 'users', 15), w === 'anyone' ? 'Anyone with the link' : 'Archipelago members');
      }));
      help.replaceChildren(...(who === 'anyone'
        ? [icon('info', 14), h('span', null, 'Works without signing in. Visitors who aren’t signed in join as guests, like “Anonymous Heron (guest)”.')]
        : [icon('info', 14), h('span', null, 'Works for anyone signed in with Archipelago. ', isOwner ? 'Guests can’t use it.' : `${ANYONE_OWNER_ONLY}.`)]));
    };
    drawWho();
    const create = h('button.btn.primary.sm', { type: 'button' }, 'Create link');
    const cancel = h('button.btn.ghost.sm', { type: 'button', onclick: () => { formEl = null; renderLinks(); } }, 'Cancel');
    const submit = async () => {
      showError(null);
      create.disabled = true;
      d.setBusy(true);
      try {
        const days = EXPIRY.find((x) => x.value === expirySel.value)?.days ?? null;
        const label = labelIn.value.trim();
        const l = await api.createLink(opts.docId, { who, role: roleSel.value as LinkRole, ...(label ? { label } : {}), ...(days ? { expiresInDays: days } : {}) });
        formEl = null;
        flashId = l.id;
        setTimeout(() => { if (flashId === l.id) flashId = null; }, 2500);
        links = [...(links ?? []).filter((x) => x.id !== l.id), l];
        renderLinks();
        const copied = await copyText(l.url);
        const what = `${l.who === 'anyone' ? 'Anyone' : 'Archipelago members'} with it can ${ROLE_VERB[l.role]}.`;
        toast(copied ? h('span', null, h('strong', null, 'Link created and copied. '), what) : h('span', null, 'Link created. ', what, ' ', h('code.toast-url', null, l.url)), { kind: 'success', timeout: copied ? 4500 : 12000 });
        void reload();
      } catch (e) {
        showError(errorMessage(e));
        create.disabled = false;
      } finally { d.setBusy(false); }
    };
    create.addEventListener('click', () => void submit());
    labelIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } });
    formEl = h('div.link-form', { role: 'group', 'aria-label': 'New share link' },
      seg, help,
      h('div.link-form-row', null, roleSel, expirySel, labelIn),
      h('div.link-form-actions', null, cancel, create));
    renderLinks();
    requestAnimationFrame(() => (seg.querySelector('.seg-btn.on') as HTMLElement | null)?.focus());
  }

  async function revoke(l: ShareLink) {
    const ok = await confirmDialog({
      title: 'Turn off this link?',
      message: h('span', null,
        'It stops working right away. ',
        l.holders ? h('span', null, h('strong', null, plural(l.holders, 'person', 'people')), ' who opened it will lose the access it gave them.') : null,
        ' This can’t be undone, but you can make a new link.'),
      confirmLabel: 'Turn off', danger: true,
    });
    if (!ok) return;
    showError(null);
    d.setBusy(true);
    try {
      await api.revokeLink(opts.docId, l.id);
      links = (links ?? []).filter((x) => x.id !== l.id);
      renderLinks();
      toast('Link turned off', { kind: 'success', timeout: 2500 });
      void reload();
    } catch (e) { showError(errorMessage(e)); void reloadLinks(); } finally { d.setBusy(false); }
  }

  const copy = h('button.btn.ghost', {
    type: 'button',
    'data-tip': 'This document’s address. It opens for people who already have access.',
    onclick: () => void copyWithToast(`${location.origin}/d/${opts.docId}`, 'Link copied'),
  }, icon('link', 16), 'Copy link');

  const d = openDialog({
    title: h('span', null, 'Share “', h('span.share-title', null, opts.title), '”'),
    label: `Share ${opts.title}`,
    size: 'md',
    className: 'share-dialog',
    body: [addRow, errorEl, listEl, generalEl, linksEl],
    footer: [copy, h('span.spacer'), h('button.btn.primary', { type: 'button', onclick: () => d.close() }, 'Done')],
  });
  void Promise.all([reload(), reloadLinks()]).then(() => { if (!addRow.hidden) picker.input.focus(); });
}
