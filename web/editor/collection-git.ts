// A collection's repository, from the browser: its history (what changed, by
// whom, and bringing things back), and how to clone it with git.

import { api, type GitCommit } from '../lib/api';
import { h } from '../lib/dom';
import { fullTime, relTime } from '../lib/format';
import { icon } from '../lib/icons';
import { confirmDialog, emptyState, errorMessage, openDialog, spinner, toast } from '../lib/ui';

const SIGN = { A: '+', M: '~', D: '−' } as const;
const WORD = { A: 'added', M: 'changed', D: 'removed' } as const;

/** The collection's changes, newest first. `onRestored` runs after something was brought back. */
export function openHistoryDialog(docId: string, canEdit: boolean, onRestored: () => void) {
  const list = h('div.coll-history', { role: 'list' });
  const more = h('button.btn.sm', { type: 'button', hidden: true }, 'Earlier changes');
  let last: string | null = null;

  const restore = async (commit: string, path: string | undefined, question: string, detail: string) => {
    if (!(await confirmDialog({ title: question, message: detail, confirmLabel: 'Restore' }))) return;
    try {
      await api.gitRestore(docId, commit, path);
      toast('Restored', { kind: 'success', timeout: 2200 });
      onRestored();
      last = null;
      list.replaceChildren();
      await load();
    } catch (e) { toast(errorMessage(e), { kind: 'error' }); }
  };

  const row = (c: GitCommit, newest: boolean) => {
    const SHOWN = 6;
    const change = (x: GitCommit['changes'][number]) => h('div.coll-change', { class: `s-${x.status}` },
      h('span.coll-change-sign', { 'aria-label': WORD[x.status], title: WORD[x.status] }, SIGN[x.status]),
      h('span.coll-change-path', { title: x.path }, x.path),
      // A removed file is brought back from the change before; anything else, as it was after this one.
      canEdit && !(newest && x.status !== 'D') && (x.status !== 'D' || c.parent)
        ? h('button.link-btn', { type: 'button', onclick: () => void (x.status === 'D'
          ? restore(c.parent!, x.path, `Bring back ${x.path}?`, 'The file returns as it was before it was removed.')
          : restore(c.oid, x.path, `Restore this version of ${x.path}?`, 'The file becomes what it was after this change. What it is now stays in the history.')) }, x.status === 'D' ? 'Bring back' : 'Restore')
        : null);
    const changes = h('div.coll-changes', null, ...c.changes.slice(0, SHOWN).map(change));
    if (c.changes.length > SHOWN) changes.append(h('button.link-btn', { type: 'button', onclick: (e: MouseEvent) => { (e.currentTarget as HTMLElement).remove(); changes.append(...c.changes.slice(SHOWN).map(change)); } }, `${c.changes.length - SHOWN} more`));
    return h('div.coll-commit', { role: 'listitem' },
      h('div.coll-commit-head', null,
        h('span.coll-commit-what', null, c.message),
        canEdit && !newest ? h('button.btn.sm.ghost', { type: 'button', 'data-tip': 'Make the whole collection what it was after this change', onclick: () => void restore(c.oid, undefined, 'Restore the whole collection to this point?', 'Every file becomes what it was after this change; files added since are removed. Nothing is lost: what is there now stays in the history.') }, icon('restore', 15), 'Restore all') : null),
      h('div.meta', { title: fullTime(c.at) }, `${c.author} · ${relTime(c.at)}`),
      changes);
  };

  const load = async () => {
    more.disabled = true;
    try {
      const first = last === null;
      const { commits } = await api.gitLog(docId, last ?? undefined);
      if (first && !commits.length) { list.replaceChildren(emptyState({ art: icon('history', 32, 'empty-art-icon'), title: 'No changes yet', text: 'Each change to the files is recorded here, with who made it.' })); return; }
      list.append(...commits.map((c, i) => row(c, first && i === 0)));
      if (commits.length) last = commits[commits.length - 1].oid;
      more.hidden = commits.length < 50;
    } catch (e) { if (last === null) list.replaceChildren(h('div.nav-note', null, errorMessage(e))); else toast(errorMessage(e), { kind: 'error' }); }
    finally { more.disabled = false; }
  };
  more.addEventListener('click', () => void load());
  list.replaceChildren(h('div.coll-loading', null, spinner(22)));
  openDialog({ title: 'History', size: 'lg', className: 'coll-history-dialog', body: [list, more] });
  void load().then(() => list.querySelector('.coll-loading')?.remove());
}

/** How to work on the collection with git: the address, the password, what to install. */
export function openCloneDialog(docId: string, canEdit: boolean, guest: boolean) {
  const body = h('div.form-stack.coll-clone', null, h('div.coll-loading', null, spinner(22)));
  openDialog({ title: 'Clone with git', size: 'md', body });
  const copyRow = (label: string, text: string, opts: { secret?: boolean } = {}) => h('label.field', null, h('span.field-label', null, label),
    h('div.coll-copy', null, h('code.coll-copy-text', { class: opts.secret ? 'secret' : '' }, text),
      h('button.btn.sm', { type: 'button', onclick: () => void navigator.clipboard.writeText(text).then(() => toast('Copied', { kind: 'success', timeout: 1800 }), () => toast(text)) }, icon('copy', 15), 'Copy')));
  void api.gitInfo(docId).then((info) => {
    if (!info.available) { body.replaceChildren(h('p.dialog-help', null, 'This server keeps collections without git.')); return; }
    const passwordBox = h('div.field');
    const drawPassword = (made: number | null, fresh?: string) => {
      const make = h('button.btn.sm', { type: 'button', onclick: async () => {
        if (made && !(await confirmDialog({ title: 'Make a new git password?', message: 'The one you have stops working, wherever it is saved.', confirmLabel: 'Make a new one' }))) return;
        try { drawPassword(Date.now(), (await api.gitPassword()).password); } catch (e) { toast(errorMessage(e), { kind: 'error' }); }
      } }, made ? 'Make a new one' : 'Make a git password');
      passwordBox.replaceChildren(
        fresh ? copyRow('Your git password', fresh, { secret: true }) : h('span.field-label', null, 'Password'),
        h('p.meta', null, fresh ? 'Shown this once. git asks for it the first time and can remember it; any user name works. It opens every collection you can open, for git only.'
          : made ? `You made a git password ${relTime(made)}. It is shown only when made; if it is lost, make a new one (the old one stops working).`
            : 'git asks for a user name and a password: any name, and a git password made here. It opens every collection you can open, for git only.'),
        make);
    };
    drawPassword(info.password?.createdAt ?? null);
    body.replaceChildren(
      h('p.dialog-help', null, 'This collection is a git repository: clone it, work on the files with any tool, and push', canEdit ? '. Changes made here and changes pushed are one history.' : ' (you can read it; pushing needs edit access).'),
      copyRow('Clone', `git clone ${info.url}`),
      guest ? h('p.meta', null, 'Sign in with Archipelago to make a git password.') : passwordBox,
      h('p.meta', null, 'PDFs, images and other large files travel through Git LFS: install it (', h('a', { href: 'https://git-lfs.com', target: '_blank', rel: 'noopener' }, 'git-lfs.com'), ') and run ', h('code', null, 'git lfs install'), ' once before cloning. A file over 10 MB must be an LFS file; ', h('code', null, '.gitattributes'), ' in the collection lists which are.'));
  }, (e) => body.replaceChildren(h('div.nav-note', null, errorMessage(e))));
}
