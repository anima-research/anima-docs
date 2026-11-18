// A file collection: the page of a document of type 'files'. Folders (the
// prefixes of its files' paths), upload by button or by dropping files and
// folders, and a viewer: images, audio, video and PDF as themselves, text in
// an editor that saves back.

import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history as editHistory, historyKeymap, indentWithTab } from '@codemirror/commands';
import { LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { search, searchKeymap } from '@codemirror/search';

import { api, type DocFile } from '../lib/api';
import { h } from '../lib/dom';
import { fullTime, plural, relTime } from '../lib/format';
import { icon } from '../lib/icons';
import { renderDocument } from '../lib/markdown';
import { confirmDialog, emptyState, errorMessage, iconButton, openMenu, promptDialog, spinner, toast, type MenuItem } from '../lib/ui';
import { codeLanguages } from './languages';
import { docHighlight } from './codestyle';

export interface CollectionView { el: HTMLElement; setCanEdit(canEdit: boolean): void; destroy(): void }

type Kind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'other';
interface Folder { name: string; path: string; files: number; bytes: number; updatedAt: number }
interface Job { file: File; path: string }

/** Text larger than this is downloaded, not opened in the editor. */
const MAX_EDIT = 2 * 1024 * 1024;
const JUNK = /^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;

export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const extOf = (path: string) => /\.([A-Za-z0-9]{1,8})$/.exec(baseName(path))?.[1]?.toLowerCase() ?? '';

function kindOf(f: DocFile): Kind {
  const mime = f.mime.split(';')[0];
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('text/') || /^application\/(json|xml|javascript|x-javascript)$/.test(mime)) return 'text';
  return 'other';
}
const iconOf = (k: Kind) => (k === 'image' ? 'image' : k === 'video' ? 'film' : k === 'audio' ? 'music' : k === 'text' ? 'code' : 'file');

function loadLayout(): 'list' | 'grid' { try { return localStorage.getItem('docs.files.layout') === 'grid' ? 'grid' : 'list'; } catch { return 'list'; } }
function saveLayout(l: 'list' | 'grid') { try { localStorage.setItem('docs.files.layout', l); } catch { /* storage may be blocked */ } }

export function collectionView(opts: { docId: string; canEdit: boolean }): CollectionView {
  const { docId } = opts;
  let canEdit = opts.canEdit;
  let files: DocFile[] = [];
  let loaded = false;
  let failed: string | null = null;
  let cwd = '';
  /** The path of the file shown in the viewer. */
  let shown: string | null = null;
  let layout = loadLayout();
  let destroyed = false;
  /** Folders made here that hold nothing yet (a folder exists on the server only through its files). */
  const emptyFolders = new Set<string>();
  /** The open text file's editor, and what was last saved. */
  let editor: { view: EditorView; path: string; saved: string } | null = null;

  const thumbUrl = (f: DocFile) => `/api/docs/${docId}/thumb/${f.path.split('/').map(encodeURIComponent).join('/')}?v=${f.mediaId.slice(0, 12)}`;
  /** A file's address for showing it here: the version in it makes a replaced file a new address (addresses are cached for a minute). */
  const srcOf = (f: DocFile) => `${f.url}?v=${f.mediaId.slice(0, 12)}`;
  const linkTo = (path: string) => `${location.origin}/d/${docId}${path ? `?at=${encodeURIComponent(path)}` : ''}`;
  const fileAt = (path: string) => files.find((f) => f.path === path) ?? null;

  // ------------------------------------------------------------------ the address: ?at=<folder or file>

  const readAt = () => (new URLSearchParams(location.search).get('at') ?? '').normalize('NFC').replace(/^\/+|\/+$/g, '');
  const writeAt = (path: string, push: boolean) => {
    const u = new URL(location.href);
    if (path) u.searchParams.set('at', path); else u.searchParams.delete('at');
    const next = u.pathname + u.search;
    if (next === location.pathname + location.search) return;
    if (push) history.pushState(null, '', next); else history.replaceState(null, '', next);
  };
  const applyAt = () => {
    const at = readAt();
    const f = at ? fileAt(at) : null;
    cwd = f ? parentOf(at) : at;
    shown = f ? at : null;
  };
  const onPop = () => { if (!leaveEditor()) { writeAt(shown ?? cwd, true); return; } applyAt(); render(); };
  window.addEventListener('popstate', onPop);

  const go = (dir: string) => { if (!leaveEditor()) return; cwd = dir; shown = null; writeAt(dir, true); render(); main.scrollTop = 0; };
  const show = (path: string | null) => { if (!leaveEditor()) return; shown = path; writeAt(path ?? cwd, true); render(); };

  // ------------------------------------------------------------------ what is here

  function entries(dir = cwd): { folders: Folder[]; here: DocFile[] } {
    const base = dir ? `${dir}/` : '';
    const folders = new Map<string, Folder>();
    const here: DocFile[] = [];
    for (const f of files) {
      if (!f.path.startsWith(base)) continue;
      const rest = f.path.slice(base.length);
      const cut = rest.indexOf('/');
      if (cut < 0) { here.push(f); continue; }
      const name = rest.slice(0, cut);
      const d = folders.get(name) ?? { name, path: base + name, files: 0, bytes: 0, updatedAt: 0 };
      d.files++; d.bytes += f.size; d.updatedAt = Math.max(d.updatedAt, f.updatedAt);
      folders.set(name, d);
    }
    for (const p of emptyFolders) if (parentOf(p) === dir && !folders.has(baseName(p))) folders.set(baseName(p), { name: baseName(p), path: p, files: 0, bytes: 0, updatedAt: 0 });
    return { folders: [...folders.values()].sort((a, b) => byName(a.name, b.name)), here: here.sort((a, b) => byName(a.path, b.path)) };
  }

  async function load(quiet = false) {
    try {
      const r = await api.files(docId);
      if (destroyed) return;
      files = r.files;
      for (const p of [...emptyFolders]) if (files.some((f) => f.path.startsWith(`${p}/`))) emptyFolders.delete(p);
      const first = !loaded;
      loaded = true; failed = null;
      if (first) applyAt();
      // While a text file is open with changes, the list refreshes behind it and the editor stays.
      if (!(editor && shown === editor.path)) render();
    } catch (e) {
      if (destroyed || (quiet && loaded)) return;
      failed = errorMessage(e);
      render();
    }
  }

  // ------------------------------------------------------------------ chrome

  const crumbs = h('nav.coll-crumbs', { 'aria-label': 'Folder' });
  const summary = h('span.coll-summary.meta');
  const layoutBtns = (['list', 'grid'] as const).map((l) => h('button.seg-btn', { type: 'button', role: 'radio', 'aria-label': l === 'list' ? 'List' : 'Grid', 'data-tip': l === 'list' ? 'List' : 'Grid', onclick: () => { layout = l; saveLayout(l); render(); } }, icon(l === 'list' ? 'rows' : 'grid', 16)));
  const layoutSwitch = h('div.seg', { role: 'radiogroup', 'aria-label': 'Layout' }, layoutBtns);
  const pickFiles = h('input', { type: 'file', multiple: true, hidden: true });
  const pickFolder = h('input', { type: 'file', hidden: true, webkitdirectory: '' });
  const newFolderBtn = h('button.btn.sm.ghost', { type: 'button', onclick: () => void newFolder() }, icon('folderPlus', 16), h('span.btn-label', null, 'New folder'));
  const uploadBtn: HTMLButtonElement = h('button.btn.sm.primary', { type: 'button', 'aria-haspopup': 'menu', onclick: () => openMenu(uploadBtn, [
    { label: 'Upload files…', icon: 'file', onSelect: () => pickFiles.click() },
    { label: 'Upload a folder…', icon: 'folder', onSelect: () => pickFolder.click() },
  ], { align: 'end' }) }, icon('upload', 16), 'Upload');
  const bar = h('div.coll-bar', null, crumbs, h('span.tb-spacer'), summary, layoutSwitch, newFolderBtn, uploadBtn, pickFiles, pickFolder);
  const main = h('div.coll-main');
  const dropVeil = h('div.coll-drop', { hidden: true }, icon('upload', 28), h('span'));
  const uploads = h('div.coll-uploads', { hidden: true, role: 'status', 'aria-live': 'polite' });
  const el = h('div.coll', null, bar, main, dropVeil, uploads);

  pickFiles.addEventListener('change', () => { const list = [...(pickFiles.files ?? [])]; pickFiles.value = ''; void upload(list.map((file) => ({ file, path: join(cwd, file.name) }))); });
  pickFolder.addEventListener('change', () => { const list = [...(pickFolder.files ?? [])]; pickFolder.value = ''; void upload(list.map((file) => ({ file, path: join(cwd, (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name) }))); });

  function renderCrumbs() {
    const parts = cwd ? cwd.split('/') : [];
    const crumb = (label: string, path: string, last: boolean) => (last && !shown
      ? h('span.coll-crumb.current', { 'aria-current': 'page' }, label)
      : h('button.coll-crumb', { type: 'button', onclick: () => go(path) }, label));
    crumbs.replaceChildren(crumb('All files', '', parts.length === 0),
      ...parts.flatMap((p, i) => [h('span.coll-crumb-sep', { 'aria-hidden': 'true' }, icon('chevronRight', 14)), crumb(p, parts.slice(0, i + 1).join('/'), i === parts.length - 1)]));
  }

  // ------------------------------------------------------------------ the folder

  function fileMenu(f: DocFile): MenuItem[] {
    const items: MenuItem[] = [
      { label: 'Open', icon: 'eye', onSelect: () => show(f.path) },
      { label: 'Open in a new tab', icon: 'external', onSelect: () => window.open(f.url, '_blank', 'noopener') },
      { label: 'Download', icon: 'download', onSelect: () => download(f) },
      { label: 'Copy link', icon: 'link', onSelect: () => copy(linkTo(f.path)) },
    ];
    if (canEdit) items.push('separator',
      { label: 'Rename…', icon: 'pencil', onSelect: () => void rename(f.path, false) },
      { label: 'Move…', icon: 'folder', onSelect: () => void moveTo(f.path) },
      'separator', { label: 'Delete', icon: 'trash', danger: true, onSelect: () => void remove(f.path, false, 1) });
    return items;
  }
  function folderMenu(d: Folder): MenuItem[] {
    const items: MenuItem[] = [{ label: 'Open', icon: 'folder', onSelect: () => go(d.path) }, { label: 'Copy link', icon: 'link', onSelect: () => copy(linkTo(d.path)) }];
    if (canEdit && d.files) items.push('separator',
      { label: 'Rename…', icon: 'pencil', onSelect: () => void rename(d.path, true) },
      { label: 'Move…', icon: 'folder', onSelect: () => void moveTo(d.path) },
      'separator', { label: 'Delete', icon: 'trash', danger: true, onSelect: () => void remove(d.path, true, d.files) });
    else if (canEdit) items.push('separator', { label: 'Remove', icon: 'trash', danger: true, onSelect: () => { emptyFolders.delete(d.path); render(); } });
    return items;
  }
  const menuButton = (label: string, items: () => MenuItem[]) => {
    const b: HTMLButtonElement = h('button.icon-btn.sm.coll-more', { type: 'button', 'aria-label': label, 'aria-haspopup': 'menu', onclick: (e: MouseEvent) => { e.stopPropagation(); openMenu(b, items(), { align: 'end' }); } }, icon('more', 16));
    return b;
  };
  /** An image's thumbnail, falling back to its icon when no picture can be made of it. */
  const thumb = (f: DocFile, size: number) => {
    const k = kindOf(f);
    if (k !== 'image') return icon(iconOf(k), size, 'coll-icon');
    const img = h('img.coll-thumb-img', { src: thumbUrl(f), alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => img.replaceWith(icon('image', size, 'coll-icon')), { once: true });
    return img;
  };

  function renderFolder() {
    const { folders, here } = entries();
    const bytes = here.reduce((n, f) => n + f.size, 0) + folders.reduce((n, d) => n + d.bytes, 0);
    const count = here.length + folders.reduce((n, d) => n + d.files, 0);
    summary.textContent = count ? `${plural(count, 'file')} · ${fmtSize(bytes)}` : '';
    if (!folders.length && !here.length) {
      main.replaceChildren(emptyState({
        art: icon(cwd ? 'folder' : 'upload', 36, 'empty-art-icon'),
        title: cwd ? 'This folder is empty' : 'No files yet',
        text: canEdit ? 'Drop files or folders here, or use Upload. Any kind of file is fine: PDFs, photos, data.' : 'Nothing has been added here.',
        action: canEdit ? h('button.btn.primary', { type: 'button', onclick: () => pickFiles.click() }, icon('upload', 16), 'Upload files') : null,
      }));
      return;
    }
    if (layout === 'grid') {
      main.replaceChildren(h('div.coll-grid', { role: 'list' },
        ...folders.map((d) => h('div.coll-tile.folder', { role: 'listitem' },
          h('button.coll-tile-open', { type: 'button', onclick: () => go(d.path) }, h('span.coll-tile-art', null, icon('folder', 44, 'coll-icon')), h('span.coll-tile-name', { title: d.name }, d.name), h('span.coll-tile-meta.meta', null, d.files ? plural(d.files, 'file') : 'Empty')),
          menuButton(`Actions for ${d.name}`, () => folderMenu(d)))),
        ...here.map((f) => h('div.coll-tile', { role: 'listitem' },
          h('button.coll-tile-open', { type: 'button', onclick: () => show(f.path) }, h('span.coll-tile-art', null, thumb(f, 44)), h('span.coll-tile-name', { title: baseName(f.path) }, baseName(f.path)), h('span.coll-tile-meta.meta', null, fmtSize(f.size))),
          menuButton(`Actions for ${baseName(f.path)}`, () => fileMenu(f))))));
      return;
    }
    main.replaceChildren(h('div.coll-list', { role: 'list' },
      h('div.coll-row.head', { 'aria-hidden': 'true' }, h('span.c-name', null, 'Name'), h('span.c-size', null, 'Size'), h('span.c-when', null, 'Changed'), h('span.c-more')),
      ...folders.map((d) => h('div.coll-row', { role: 'listitem' },
        h('button.c-name.coll-open', { type: 'button', onclick: () => go(d.path) }, icon('folder', 18, 'coll-icon folder'), h('span.coll-name', null, d.name)),
        h('span.c-size.meta', null, d.files ? `${plural(d.files, 'file')} · ${fmtSize(d.bytes)}` : 'Empty'),
        h('span.c-when.meta', { title: d.updatedAt ? fullTime(d.updatedAt) : '' }, d.updatedAt ? relTime(d.updatedAt) : ''),
        h('span.c-more', null, menuButton(`Actions for ${d.name}`, () => folderMenu(d))))),
      ...here.map((f) => h('div.coll-row', { role: 'listitem' },
        h('button.c-name.coll-open', { type: 'button', onclick: () => show(f.path) }, icon(iconOf(kindOf(f)), 18, 'coll-icon'), h('span.coll-name', null, baseName(f.path))),
        h('span.c-size.meta', null, fmtSize(f.size)),
        h('span.c-when.meta', { title: fullTime(f.updatedAt) }, relTime(f.updatedAt)),
        h('span.c-more', null, menuButton(`Actions for ${baseName(f.path)}`, () => fileMenu(f)))))));
  }

  // ------------------------------------------------------------------ the viewer

  /** Leaving an edited text file: ask first. True when it is fine to go. */
  function leaveEditor(): boolean {
    if (!editor) return true;
    if (editor.view.state.doc.toString() !== editor.saved && !window.confirm(`Discard your changes to ${baseName(editor.path)}?`)) return false;
    editor.view.destroy();
    editor = null;
    return true;
  }

  function renderViewer(f: DocFile) {
    const kind = kindOf(f);
    const siblings = entries(parentOf(f.path)).here;
    const i = siblings.findIndex((x) => x.path === f.path);
    const step = (d: number) => { const n = siblings[i + d]; if (n) show(n.path); };
    const tools = h('span.coll-view-tools');
    const head = h('div.coll-view-bar', null,
      iconButton('arrowLeft', 'Back to the folder', () => show(null)),
      h('span.coll-view-name', { title: f.path }, baseName(f.path)),
      h('span.meta', null, `${fmtSize(f.size)}${siblings.length > 1 ? ` · ${i + 1} of ${siblings.length}` : ''}`),
      h('span.tb-spacer'), tools,
      siblings.length > 1 ? iconButton('chevronLeft', 'Previous file', () => step(-1), { cls: i <= 0 ? 'off' : '' }) : null,
      siblings.length > 1 ? iconButton('chevronRight', 'Next file', () => step(1), { cls: i >= siblings.length - 1 ? 'off' : '' }) : null,
      iconButton('download', 'Download', () => download(f)),
      menuButton('More', () => fileMenu(f).filter((m) => m === 'separator' || !('label' in m) || (m.label !== 'Open' && m.label !== 'Download'))));
    const stage = h('div.coll-stage', { class: `kind-${kind}` });
    const noPreview = (why: string) => stage.replaceChildren(emptyState({ art: icon(iconOf(kind), 40, 'empty-art-icon'), title: baseName(f.path), text: why, action: h('button.btn.primary', { type: 'button', onclick: () => download(f) }, icon('download', 16), 'Download') }));
    if (kind === 'image') {
      const img = h('img.coll-image', { src: srcOf(f), alt: baseName(f.path) });
      img.addEventListener('error', () => noPreview('This browser cannot show this kind of image.'), { once: true });
      stage.append(img);
    } else if (kind === 'video') stage.append(h('video.coll-video', { src: srcOf(f), controls: '', playsinline: '', preload: 'metadata' }));
    else if (kind === 'audio') stage.append(icon('music', 48, 'coll-icon'), h('audio.coll-audio', { src: srcOf(f), controls: '', preload: 'metadata' }));
    // A PDF is shown by the browser's own viewer, from the media address (which may be framed here; a file's own address is sandboxed, and PDF viewers refuse a sandbox).
    else if (kind === 'pdf') stage.append(h('iframe.coll-pdf', { src: `/media/${f.mediaId}`, title: baseName(f.path) }));
    else if (kind === 'text' && f.size <= MAX_EDIT) void openText(f, stage, tools);
    else noPreview(kind === 'text' ? `Too large to open here (${fmtSize(f.size)}).` : 'No preview for this kind of file.');
    main.replaceChildren(h('div.coll-view', null, head, stage));
  }

  async function openText(f: DocFile, stage: HTMLElement, tools: HTMLElement) {
    stage.replaceChildren(spinner(22));
    let text: string;
    try {
      const r = await fetch(srcOf(f), { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`Could not read the file (${r.status}).`);
      text = await r.text();
    } catch (e) { if (shown === f.path) stage.replaceChildren(emptyState({ art: icon('alert', 36, 'empty-art-icon'), title: 'Couldn’t open this file', text: errorMessage(e) })); return; }
    if (destroyed || shown !== f.path) return;
    const ext = extOf(f.path);
    const isMd = ext === 'md' || ext === 'markdown';
    const lang = new Compartment();
    const saveBtn = h('button.btn.sm.primary', { type: 'button', disabled: true, onclick: () => void save() }, 'Save');
    const dirty = () => view.state.doc.toString() !== editor?.saved;
    const save = async () => {
      if (!editor || !dirty()) return;
      const now = view.state.doc.toString();
      saveBtn.disabled = true;
      try {
        const nf = await api.putFile(docId, f.path, new Blob([now], { type: 'text/plain' }));
        files = files.map((x) => (x.path === nf.path ? nf : x));
        if (editor) editor.saved = now;
        toast('Saved', { kind: 'success', timeout: 1800 });
      } catch (e) { toast(errorMessage(e), { kind: 'error' }); }
      saveBtn.disabled = !dirty();
    };
    const view = new EditorView({
      state: EditorState.create({ doc: text, extensions: [
        lineNumbers(), highlightSpecialChars(), editHistory(), drawSelection(), search(), EditorView.lineWrapping,
        syntaxHighlighting(docHighlight), lang.of([]),
        EditorState.readOnly.of(!canEdit), EditorView.editable.of(canEdit),
        keymap.of([{ key: 'Mod-s', run: () => { void save(); return true; } }, indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        EditorView.updateListener.of((u) => { if (u.docChanged) saveBtn.disabled = !dirty(); }),
      ] }),
    });
    editor = { view, path: f.path, saved: text };
    const support = isMd ? Promise.resolve(markdown({ base: markdownLanguage, codeLanguages })) : LanguageDescription.matchLanguageName(codeLanguages, ext, true)?.load();
    void support?.then((s) => { if (editor?.view === view) view.dispatch({ effects: lang.reconfigure(s) }); });

    const source = h('div.coll-source', null, view.dom);
    if (!isMd) { stage.replaceChildren(source); tools.replaceChildren(...(canEdit ? [saveBtn] : [])); return; }
    // Markdown opens rendered; its source is a click away.
    const rendered = h('article.prose.coll-rendered');
    // Pictures beside the file are the collection's files: a relative address in the source becomes the stored
    // image's own (the renderer keeps only addresses it knows to be safe, and that is one).
    const withPictures = (md: string) => md.replace(/(!\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g, (all: string, open: string, url: string, close: string) => {
      if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(url)) return all;
      let rel = url; try { rel = decodeURIComponent(url); } catch { /* as written */ }
      const parts: string[] = [];
      for (const part of join(parentOf(f.path), rel).split('/')) { if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part); }
      const target = fileAt(parts.join('/').normalize('NFC'));
      return target ? `${open}/media/${target.mediaId}${close}` : all;
    });
    const draw = () => rendered.replaceChildren(renderDocument(withPictures(view.state.doc.toString())));
    let asSource = false;
    const modes = (['Read', canEdit ? 'Edit' : 'Source'] as const).map((label, n) => h('button.seg-btn', { type: 'button', role: 'radio', onclick: () => setSource(n === 1) }, label));
    const setSource = (on: boolean) => {
      asSource = on;
      modes.forEach((b, n) => { b.classList.toggle('on', (n === 1) === on); b.setAttribute('aria-checked', String((n === 1) === on)); });
      if (!on) draw();
      stage.replaceChildren(on ? source : rendered);
      if (on) view.focus();
    };
    tools.replaceChildren(h('div.seg', { role: 'radiogroup', 'aria-label': 'View' }, modes), ...(canEdit ? [saveBtn] : []));
    setSource(asSource);
  }

  // ------------------------------------------------------------------ actions

  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast('Link copied', { kind: 'success', timeout: 2000 }), () => toast(text));
  const download = (f: DocFile) => { const a = h('a', { href: `${f.url}?download=1`, download: baseName(f.path) }); document.body.append(a); a.click(); a.remove(); };
  const nameProblem = (v: string) => (!v ? 'Enter a name.' : /[/\\]/.test(v) ? 'A name cannot contain a slash.' : v === '.' || v === '..' || v.toLowerCase() === '.git' ? 'That name is not allowed.' : null);

  async function newFolder() {
    const name = await promptDialog({ title: 'New folder', label: 'Name', confirmLabel: 'Create', maxLength: 255, validate: nameProblem });
    if (!name) return;
    const path = join(cwd, name.normalize('NFC'));
    if (fileAt(path)) { toast(`${name} is a file here.`, { kind: 'error' }); return; }
    emptyFolders.add(path);
    go(path);
  }
  async function rename(path: string, folder: boolean) {
    const was = baseName(path);
    const name = await promptDialog({ title: folder ? 'Rename folder' : 'Rename file', label: 'Name', value: was, confirmLabel: 'Rename', maxLength: 255, validate: nameProblem });
    if (!name || name === was) return;
    await move(path, join(parentOf(path), name));
  }
  async function moveTo(path: string) {
    const dir = await promptDialog({ title: `Move ${baseName(path)}`, label: 'To folder', value: parentOf(path), placeholder: 'e.g. papers/2024 (empty for the top)', confirmLabel: 'Move', help: 'The folder is made if it does not exist yet.', validate: (v) => (/\\/.test(v) ? 'Use "/" between folder names.' : null) });
    if (dir === null) return;
    const to = join(dir.replace(/^\/+|\/+$/g, ''), baseName(path));
    if (to !== path) await move(path, to);
  }
  async function move(from: string, to: string) {
    try {
      const r = await api.moveFile(docId, from, to.normalize('NFC'));
      if (shown === from) { if (!leaveEditor()) return; shown = to.normalize('NFC'); cwd = parentOf(shown); writeAt(shown, false); }
      else if (cwd === from || cwd.startsWith(`${from}/`)) { cwd = to + cwd.slice(from.length); writeAt(cwd, false); }
      toast(r.moved === 1 ? 'Moved' : `Moved ${r.moved} files`, { kind: 'success', timeout: 2000 });
    } catch (e) { toast(errorMessage(e), { kind: 'error' }); }
    await load();
  }
  async function remove(path: string, folder: boolean, count: number) {
    const ok = await confirmDialog({ title: `Delete ${baseName(path)}?`, message: folder ? `The folder and the ${plural(count, 'file')} in it will be deleted. This cannot be undone.` : 'The file will be deleted. This cannot be undone.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      if (folder) await api.deleteFolder(docId, path); else await api.deleteFile(docId, path);
      if (shown === path) { editor?.view.destroy(); editor = null; shown = null; writeAt(cwd, false); }
    } catch (e) { toast(errorMessage(e), { kind: 'error' }); }
    await load();
  }

  // ------------------------------------------------------------------ uploading

  let uploading = false;
  async function upload(jobs: Job[]) {
    if (!canEdit || !jobs.length) return;
    if (uploading) { toast('An upload is still running; add these when it finishes.', { kind: 'info' }); return; }
    jobs = jobs.map((j) => ({ file: j.file, path: j.path.normalize('NFC') })).filter((j) => !JUNK.test(baseName(j.path)) && !j.path.split('/').some((p) => p.toLowerCase() === '.git'));
    if (!jobs.length) return;
    const clash = jobs.filter((j) => fileAt(j.path));
    if (clash.length) {
      const replace = await confirmDialog({ title: `Replace ${clash.length === 1 ? baseName(clash[0].path) : `${clash.length} files`}?`, message: clash.length === 1 ? 'A file with this name is already here. Replacing it cannot be undone.' : `${clash.length} of these files are already here. Replacing them cannot be undone; Cancel uploads only the new ones.`, confirmLabel: 'Replace', danger: true });
      if (!replace) jobs = jobs.filter((j) => !fileAt(j.path));
      if (!jobs.length) return;
    }
    uploading = true;
    const total = jobs.length, bytes = jobs.reduce((n, j) => n + j.file.size, 0);
    let done = 0, sent = 0;
    const failures: string[] = [];
    const status = () => { uploads.hidden = false; uploads.replaceChildren(spinner(14), h('span', null, `Uploading ${Math.min(done + 1, total)} of ${total} (${fmtSize(sent)} of ${fmtSize(bytes)})`)); };
    status();
    const queue = [...jobs];
    const worker = async () => {
      for (let j = queue.shift(); j; j = queue.shift()) {
        try { await api.putFile(docId, j.path, j.file); }
        catch (e) { failures.push(`${j.path}: ${errorMessage(e)}`); }
        done++; sent += j.file.size;
        if (!destroyed) status();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    uploading = false;
    if (destroyed) return;
    uploads.hidden = true;
    if (failures.length) {
      uploads.hidden = false;
      uploads.replaceChildren(icon('alert', 14), h('span', null, `${failures.length} of ${total} could not be uploaded: `, failures.slice(0, 3).join('; '), failures.length > 3 ? ` and ${failures.length - 3} more.` : ''), h('button.link-btn', { type: 'button', onclick: () => { uploads.hidden = true; } }, 'Dismiss'));
    } else toast(total === 1 ? `Uploaded ${baseName(jobs[0].path)}` : `Uploaded ${total} files`, { kind: 'success', timeout: 2500 });
    await load();
  }

  /** What was dropped: files, and folders walked to their files. */
  function dropped(dt: DataTransfer): Promise<Job[]> {
    type Entry = { isFile: boolean; isDirectory: boolean; name: string; file(ok: (f: File) => void, no: (e: unknown) => void): void; createReader(): { readEntries(ok: (e: Entry[]) => void, no: (e: unknown) => void): void } };
    // Entries must be taken while the drop event is still being handled.
    const roots = [...dt.items].filter((i) => i.kind === 'file').map((i) => (i as unknown as { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.() ?? null);
    const plain = [...dt.files];
    if (!roots.some(Boolean)) return Promise.resolve(plain.map((file) => ({ file, path: join(cwd, file.name) })));
    const out: Job[] = [];
    const walk = async (e: Entry, dir: string): Promise<void> => {
      if (e.isFile) { out.push({ file: await new Promise<File>((ok, no) => e.file(ok, no)), path: join(dir, e.name) }); return; }
      if (!e.isDirectory) return;
      const reader = e.createReader();
      for (;;) {
        const batch = await new Promise<Entry[]>((ok, no) => reader.readEntries(ok, no));
        if (!batch.length) break;
        for (const c of batch) await walk(c, join(dir, e.name));
      }
    };
    return (async () => { for (const r of roots) if (r) await walk(r, cwd); return out; })();
  }
  let dragDepth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  el.addEventListener('dragenter', (e) => { if (!canEdit || !hasFiles(e)) return; e.preventDefault(); dragDepth++; dropVeil.hidden = false; dropVeil.lastElementChild!.textContent = `Drop to upload to ${cwd ? baseName(cwd) : 'this collection'}`; });
  el.addEventListener('dragover', (e) => { if (canEdit && hasFiles(e)) { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; } });
  el.addEventListener('dragleave', () => { if (dragDepth > 0 && --dragDepth === 0) dropVeil.hidden = true; });
  el.addEventListener('drop', (e) => {
    if (!canEdit || !hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0; dropVeil.hidden = true;
    void dropped(e.dataTransfer!).then((jobs) => upload(jobs), (err) => toast(errorMessage(err), { kind: 'error' }));
  });

  // ------------------------------------------------------------------ keys, refresh

  const onKey = (e: KeyboardEvent) => {
    if (!shown || !el.isConnected || el.closest('[hidden]') || document.querySelector('dialog[open]')) return;
    const t = e.target as HTMLElement;
    if (t.closest('.cm-editor, input, textarea, select, [contenteditable="true"], video, audio')) return;
    if (e.key === 'Escape') { e.preventDefault(); show(null); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const siblings = entries(parentOf(shown)).here;
      const n = siblings[siblings.findIndex((x) => x.path === shown) + (e.key === 'ArrowLeft' ? -1 : 1)];
      if (n) { e.preventDefault(); show(n.path); }
    }
  };
  document.addEventListener('keydown', onKey);
  // Others (people, agents, pushes) change the collection too: look again when the tab comes back.
  const onVisible = () => { if (document.visibilityState === 'visible' && !uploading) void load(true); };
  document.addEventListener('visibilitychange', onVisible);

  function render() {
    if (destroyed) return;
    if (editor && shown !== editor.path) { editor.view.destroy(); editor = null; }
    el.classList.toggle('viewing', !!shown);
    newFolderBtn.hidden = uploadBtn.hidden = !canEdit || !!shown;
    layoutSwitch.hidden = summary.hidden = !!shown;
    layoutBtns.forEach((b, n) => { const on = (n === 0) === (layout === 'list'); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    renderCrumbs();
    if (!loaded) { main.replaceChildren(failed ? emptyState({ art: icon('alert', 36, 'empty-art-icon'), title: 'Couldn’t load the files', text: failed, action: h('button.btn', { type: 'button', onclick: () => void load() }, 'Try again') }) : h('div.coll-loading', null, spinner(24))); return; }
    const f = shown ? fileAt(shown) : null;
    if (shown && !f) { shown = null; writeAt(cwd, false); }
    if (f) renderViewer(f); else renderFolder();
  }

  render();
  void load();

  return {
    el,
    setCanEdit(next) { if (next === canEdit) return; canEdit = next; if (!(editor && shown === editor.path)) render(); },
    destroy() {
      destroyed = true;
      editor?.view.destroy();
      window.removeEventListener('popstate', onPop);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisible);
    },
  };
}
