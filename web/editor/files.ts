// Files attached to a document: an HTML page's data, scripts, styles and images,
// and its markdown companion (index.md). Served next to the page, so the page
// loads them by relative URL; agents read them with read_file.

import { api, type DocFile } from '../lib/api';
import { h } from '../lib/dom';
import { icon } from '../lib/icons';
import { confirmDialog, errorMessage, openDialog, promptDialog, spinner, toast } from '../lib/ui';

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function openFilesDialog(docId: string, canEdit: boolean, isPage: boolean) {
  const list = h('div.files-list', { role: 'list' });
  const input = h('input', { type: 'file', multiple: true, hidden: true });
  const folder = h('input.input.sm', { type: 'text', placeholder: 'folder (optional), e.g. data', 'aria-label': 'Folder', pattern: '[A-Za-z0-9._/-]*', style: 'width: 220px' });
  const status = h('div.meta');
  const load = async () => {
    try {
      const r = await api.files(docId);
      list.replaceChildren(...r.files.map((f) => row(f)));
      if (!r.files.length) list.replaceChildren(h('div.nav-note', null, isPage ? 'No files yet. Attach data, scripts, styles or images; the page loads them by relative URL (fetch("data/sim.json")). index.md is the page’s description for agents.' : 'No files attached.'));
    } catch (e) { list.replaceChildren(h('div.nav-note', null, errorMessage(e))); }
  };
  const row = (f: DocFile) => h('div.file-row', { role: 'listitem' },
    icon(/^image\//.test(f.mime) ? 'image' : /json|javascript|css|markdown|text/.test(f.mime) ? 'code' : 'file', 16),
    h('span.file-path', null, f.path, f.path === 'index.md' ? h('span.type-chip', { 'data-tip': 'The markdown companion agents read instead of the HTML' }, 'companion') : null),
    h('span.meta', null, `${f.mime.split(';')[0]} · ${fmtSize(f.size)}`),
    h('span.file-acts', null,
      h('a.link-btn', { href: `/p/${docId}/${f.path}`, target: '_blank', rel: 'noopener' }, 'Open'),
      h('button.link-btn', { type: 'button', onclick: () => { void navigator.clipboard.writeText(`${location.origin}/p/${docId}/${f.path}`).then(() => toast('Link copied', { kind: 'success', timeout: 2000 })); } }, 'Copy link'),
      canEdit ? h('button.link-btn.danger', { type: 'button', onclick: async () => { if (await confirmDialog({ title: `Remove ${f.path}?`, message: 'Links to it stop working.', confirmLabel: 'Remove', danger: true })) { try { await api.deleteFile(docId, f.path); await load(); } catch (e) { toast(errorMessage(e), { kind: 'error' }); } } } }, 'Remove') : null));
  input.addEventListener('change', async () => {
    const files = [...(input.files ?? [])];
    input.value = '';
    const dir = folder.value.trim().replace(/^\/+|\/+$/g, '');
    for (const f of files) {
      const path = `${dir ? `${dir}/` : ''}${f.name}`;
      status.replaceChildren(spinner(14), ` Uploading ${path}…`);
      try { await api.putFile(docId, path, f); }
      catch (e) { toast(`${path}: ${errorMessage(e)}`, { kind: 'error' }); }
    }
    status.replaceChildren();
    await load();
  });
  const newText = async () => {
    const path = await promptDialog({ title: 'New text file', label: 'Path', placeholder: 'index.md, data/notes.json…', confirmLabel: 'Create' });
    if (!path) return;
    try { await api.putFile(docId, path.trim(), new Blob(['\n'], { type: 'text/plain' })); await load(); }
    catch (e) { toast(errorMessage(e), { kind: 'error' }); }
  };
  const body = h('div.form-stack', null,
    isPage ? h('p.meta', null, 'The page loads these by relative URL, e.g. ', h('code', null, 'fetch("data/sim.json")'), '. Agents read them with read_file; ', h('code', null, 'index.md'), ' is what they get instead of the HTML.') : h('p.meta', null, 'Files attached to this document, served at /p/<id>/<path>.'),
    canEdit ? h('div.row-gap', null, folder, h('button.btn.sm', { type: 'button', onclick: () => input.click() }, icon('plus', 14), 'Upload files…'), h('button.btn.ghost.sm', { type: 'button', onclick: () => void newText() }, 'New text file…'), input) : null,
    status, list);
  const d = openDialog({ title: 'Attached files', size: 'md', body, footer: [h('button.btn.ghost', { type: 'button', onclick: () => d.close() }, 'Close')] });
  void load();
}
