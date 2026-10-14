// The document page: header, toolbar, live editor, comments, preview, panels.

import * as Y from 'yjs';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, drawSelection, dropCursor, highlightSpecialChars, keymap, placeholder, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, redo as cmRedo, undo as cmUndo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { html as htmlLanguage } from '@codemirror/lang-html';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';

import { api, ApiError, atLeast, isGuestMe, signalUnauthorized, ROLE_LABEL, ROLE_VERB, type DocDetail, type GeneralAccess, type Me, type NodeType, type Role, type TreeRoot } from '../lib/api';
import { debounce, h, modKey, altKey, rafThrottle, isMac } from '../lib/dom';
import { icon } from '../lib/icons';
import { splitLabel } from '../lib/format';
import { renderDocument } from '../lib/markdown';
import { embedOf, wrapByType } from '../../src/mdext';
import { openFilesDialog } from './files';
import { searchPeople } from '../lib/people';
import { avatar, confirmDialog, emptyState, errorMessage, openDialog, openMenu, promptDialog, spinner, toast, type MenuItem } from '../lib/ui';
import { navigate } from '../router';
import { guestSignInButton, userMenuButton } from '../pages/shell';
import { onMeChanged, startSignIn, updateMe } from '../lib/session';
import { DocProvider, type ConnStatus } from './provider';
import { remoteCursors } from './cursors';
import { livePreview } from './livepreview';
import { codeLanguages } from './languages';
import { commentHighlights } from './highlights';
import { CommentsRail } from './comments';
import { openShareDialog } from './share';
import { SidePanel } from './panels';
import { formatKeymap, insertBlock, insertLink, insertRule, insertTable, lineKindAt, selectedText, setLineKind, toggleCodeBlock, toggleInline, type LineKind } from './commands';
import { SuggestSession, sharedCoords, suggestionOverlays, type Coords } from './suggest';
import { openPingDialog } from './ping';
import { Binding, nodeInfo, subpagesSource, viewMap, type NodeLabel, nudge } from './nodes/binding';
import { NodeStore } from './nodes/store';
import { nodePos, virtualPos, type Layout, type Mount } from './nodes/layout';
import { NavPanel } from './nav';
import { documentCompletions, forgetDocuments } from './complete';

type Mode = 'edit' | 'split' | 'preview';
const MAX_IMAGE = 15 * 1024 * 1024;
/** Other files (audio, video, documents); the server's DOCS_UPLOAD_MAX_MB is the real limit. */
const MAX_FILE = 300 * 1024 * 1024;
const isImageFile = (f: File) => /^image\/(png|jpeg|gif|webp)$/.test(f.type);

const docHighlight = HighlightStyle.define([
  { tag: t.heading, class: 'tok-heading' },
  { tag: t.strong, class: 'tok-strong' },
  { tag: t.emphasis, class: 'tok-em' },
  { tag: t.strikethrough, class: 'tok-strike' },
  { tag: t.link, class: 'tok-link' },
  { tag: t.url, class: 'tok-url' },
  { tag: t.monospace, class: 'tok-mono' },
  { tag: t.processingInstruction, class: 'tok-mark' },
  { tag: t.quote, class: 'tok-quote' },
  { tag: t.contentSeparator, class: 'tok-mark' },
  { tag: t.labelName, class: 'tok-label' },
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], class: 'tok-kw' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], class: 'tok-str' },
  { tag: [t.number, t.bool, t.null, t.atom], class: 'tok-num' },
  { tag: [t.comment, t.lineComment, t.blockComment], class: 'tok-comment' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: 'tok-fn' },
  { tag: [t.typeName, t.className, t.namespace], class: 'tok-type' },
  { tag: [t.propertyName, t.attributeName], class: 'tok-prop' },
  { tag: t.tagName, class: 'tok-tag' },
  { tag: [t.meta, t.escape], class: 'tok-meta' },
  { tag: t.invalid, class: 'tok-invalid' },
]);

const suggestPrefKey = (docId: string) => `docs.suggest.${docId}`;
function loadSuggestPref(docId: string): boolean { try { return localStorage.getItem(suggestPrefKey(docId)) === '1'; } catch { return false; } }
function saveSuggestPref(docId: string, on: boolean) { try { if (on) localStorage.setItem(suggestPrefKey(docId), '1'); else localStorage.removeItem(suggestPrefKey(docId)); } catch { /* ignore */ } }

function loadMode(): Mode {
  try { const m = localStorage.getItem('docs.mode'); if (m === 'edit' || m === 'split' || m === 'preview') return m; } catch { /* storage may be blocked */ }
  return 'edit';
}
function saveMode(m: Mode) { try { localStorage.setItem('docs.mode', m); } catch { /* ignore */ } }
/** The nav opens by itself when the page was opened through a tree (or was left open), on wide screens. */
function loadNav(): boolean {
  if (window.innerWidth < 1100) return false;
  try { const v = localStorage.getItem('docs.nav'); if (v === '1') return true; if (v === '0') return false; } catch { /* ignore */ }
  return new URLSearchParams(location.search).has('tree');
}
function saveNav(open: boolean) { try { localStorage.setItem('docs.nav', open ? '1' : '0'); } catch { /* ignore */ } }

interface BuildContext {
  /** The server refused local changes: rebuild from a fresh Y.Doc. */
  onResync: (message: string, scrollTop: number) => void;
  restoreScroll?: number;
  /** The navigation panel of the page being replaced: kept across documents opened in the same shell. */
  nav?: NavPanel;
  keepNav?: (nav: NavPanel) => void;
}

/** A mounted document page: its cleanup, plus a way to open another document in the same shell. */
export type DocPage = (() => void) & { open(id: string): void };

export function mountDocPage(root: HTMLElement, me: Me, firstId: string): DocPage {
  let current: (() => void) | null = null;
  let destroyed = false;
  let docId = firstId;
  let nav: NavPanel | null = null;
  const resyncs: number[] = [];
  root.replaceChildren(h('div.doc-loading-page', null, spinner(28), h('p', null, 'Opening document…')));
  document.title = 'Anima Docs';

  const start = (restoreScroll?: number) => void api.doc(docId).then((detail) => {
    if (destroyed || detail.id !== docId) return;
    current?.();
    current = build(root, me, detail, {
      restoreScroll,
      nav: nav ?? undefined,
      keepNav: (n) => { nav = n; },
      onResync: (message, scrollTop) => {
        // Discard the local replica (and its refused edits) and load the server's.
        const now = Date.now();
        resyncs.push(now);
        while (resyncs.length && now - resyncs[0] > 30_000) resyncs.shift();
        if (resyncs.length > 3) { toast(`${message} Reload the page to continue.`, { kind: 'error', timeout: 0 }); return; }
        toast(h('span', null, message, ' Reloaded the latest version.'), { kind: 'info' });
        start(scrollTop);
      },
    });
  }).catch((e) => {
    if (destroyed) return;
    const missing = e instanceof ApiError && (e.status === 404 || e.status === 403);
    const guest = isGuestMe(me);
    root.replaceChildren(h('div.full-center', null, emptyState({
      art: icon(missing ? (guest ? 'unlink' : 'lock') : 'alert', 40, 'empty-art-icon'),
      title: missing ? (guest ? 'This document isn’t available' : 'Document not found') : 'Couldn’t open this document',
      text: missing
        ? (guest ? 'The link you used may have been turned off or expired. Ask whoever sent it for a new one.' : 'It may have been deleted, or you don’t have access. Ask the owner to share it with you.')
        : errorMessage(e),
      action: h('div.row-gap', null,
        h('a.btn.primary', { href: '/', 'data-link': '' }, guest ? 'Your documents' : 'Go to documents'),
        missing && guest ? h('button.btn', { type: 'button', onclick: () => startSignIn() }, icon('login', 16), 'Sign in') : null,
        missing ? null : h('button.btn', { type: 'button', onclick: () => location.reload() }, 'Try again')),
    })));
  });

  start();
  const page = (() => { destroyed = true; current?.(); current = null; nav?.destroy(); nav = null; }) as DocPage;
  // Opening another document from the nav, a band or a breadcrumb: the old page stays until the new one is ready.
  page.open = (id: string) => { if (id === docId && current) return; docId = id; start(); };
  return page;
}

function build(root: HTMLElement, me: Me, detail: DocDetail, ctx: BuildContext): () => void {
  const docId = detail.id;
  let title = detail.title;
  let role: Role = detail.role;
  let mode: Mode = loadMode();
  let listOpen = false;
  /** Guests came in through an "anyone" link: no sharing, uploads, assigning or directory. */
  const guest = isGuestMe(me);
  let generalAccess: GeneralAccess = detail.generalAccess;
  let publicLink = !!detail.publicLink;
  const cleanups: (() => void)[] = [];

  const provider = new DocProvider(docId);
  provider.role = role;
  provider.awareness.setLocalStateField('user', { name: me.name, color: me.color, sub: me.sub, kind: me.kind });
  const canEdit = () => atLeast(role, 'editor');
  /** Every node in the view: the root (this provider) and whatever it mounts, opened on demand. */
  const nodes = new NodeStore(docId, provider);
  const treeParam = new URLSearchParams(location.search).get('tree');
  const isSection = () => !!detail.section || title === '';
  const openNode = (id: string, tree: string | null = nav.tree) => navigate(`/d/${id}${tree ? `?tree=${encodeURIComponent(tree)}` : ''}`);
  const labelOf = (id: string): NodeLabel | undefined => {
    const p = nodes.get(id);
    if (!p) return undefined;
    const i = nodes.info.get(id);
    const t = p.synced ? p.ytext.toString() : '';
    const first = t.split('\n').find((l) => l.trim() && !/^\{\{node:/.test(l))?.replace(/^#+\s*/, '').slice(0, 60) ?? '';
    return { title: i?.title ?? (id === docId ? title : ''), section: i ? i.section : id === docId ? isSection() : false, type: i?.type ?? 'markdown', loaded: p.synced, chars: t.length, lines: t ? t.split('\n').length : 0, first };
  };
  const navDeps = { docId, role: () => role, tree: treeParam, onOpen: (id: string, tree: string | null) => openNode(id, tree), label: (id: string) => labelOf(id), onChanged: () => { updateCrumbs(); refreshFooter(); }, pickDocument: (title: string) => pickDocument(title) };
  const nav = ctx.nav ?? new NavPanel(navDeps);
  if (ctx.nav) nav.rebind(navDeps);
  ctx.keepNav?.(nav);
  const binding = new Binding({
    store: nodes,
    canEdit: (node) => (node === docId ? canEdit() : atLeast(nodes.get(node)?.role ?? null, 'editor')),
    onNotice: (m) => toast(m, { kind: 'info', timeout: 3500 }),
    onMergeRequest: (m) => void mergeSection(m),
    onOpen: (id) => openNode(id),
    onName: (id) => void nameSection(id),
    onType: (id, anchor) => typeMenu(id, anchor),
    onLayout: (L) => { nav.setLayout(L); schedulePreview(); updateCrumbs(); },
  });
  /** Suggesting mode: your edits become suggestions (see suggest.ts). */
  let session: SuggestSession | null = null;
  /** applyDocType has run once (the view exists); role changes after that re-apply it. */
  let typeApplied = false;
  let switching = false;
  const suggesting = () => !!session;
  /** Can type into the editor: an editor, or anyone suggesting. */
  const canWrite = () => canEdit() || (suggesting() && atLeast(role, 'commenter'));
  const coords = (): Coords => session?.coords ?? sharedCoords;

  // ------------------------------------------------------------------ header

  const titleInput = h('input.doc-title', { type: 'text', value: title, 'aria-label': 'Document title', spellcheck: 'false', maxlength: '300', placeholder: detail.section ? 'Unnamed section — name it to make it a document' : 'Untitled' });
  let titleBefore = title;
  const commitTitle = async () => {
    const next = titleInput.value.trim();
    if (next === titleBefore) return;
    try {
      const d = await api.patchDoc(docId, { title: next });
      title = d.title;
      titleBefore = d.title;
      titleInput.value = d.title;
      forgetDocuments();
      void nav.refresh();
      document.title = `${title || 'Section'} · Anima Docs`;
      toast(d.title ? (titleBefore === '' ? 'Named: this section is a document of its own now.' : 'Renamed') : 'This is a nameless section now, reachable through the documents that mount it.', { kind: 'success', timeout: 3000 });
    } catch (e) {
      toast(errorMessage(e), { kind: 'error' });
      titleInput.value = titleBefore;
    }
  };
  titleInput.addEventListener('focus', () => { titleBefore = title; });
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); titleInput.blur(); view.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); titleInput.value = titleBefore; titleInput.blur(); }
  });
  titleInput.addEventListener('blur', () => void commitTitle());

  const statusEl = h('span.conn', { role: 'status', 'aria-live': 'polite' });
  const crumbsEl = h('span.doc-crumbs');
  const navBtn = h('button.icon-btn.nav-btn', { type: 'button', 'aria-label': 'Pages and sections', 'data-tip': 'Pages and sections', 'aria-pressed': 'false', onclick: () => setNav(!navOpen, true) }, icon('columns', 20));
  const rolePill = h('span.role-pill');
  const ownerEl = h('span.doc-owner');
  const presenceEl = h('div.presence', { 'aria-label': 'People in this document' });
  const commentsCount = h('span.count-badge', { hidden: true });
  const pingBtn = h('button.btn.ghost.ping-btn', { type: 'button', 'aria-label': 'Ping an agent', 'data-tip': 'Ask an agent to look at this', onclick: () => pingAgent() }, icon('bell', 18), h('span.btn-label', null, 'Ping'));
  const commentsBtn = h('button.btn.ghost.comments-btn', { type: 'button', 'aria-label': 'Show all comments', 'data-tip': 'All comments', onclick: () => toggleList() }, icon('comment', 18), h('span.btn-label', null, 'Comments'), commentsCount);
  const modeBtns = (['edit', 'split', 'preview'] as Mode[]).map((m) => h('button.seg-btn', {
    type: 'button', role: 'radio', 'data-mode': m, 'aria-label': m === 'edit' ? 'Edit mode' : m === 'split' ? 'Split view' : 'Preview mode',
    'data-tip': m === 'edit' ? 'Edit' : m === 'split' ? 'Split: source and preview' : 'Preview', onclick: () => setMode(m, { chosen: true }),
  }, icon(m === 'edit' ? 'pencil' : m === 'split' ? 'columns' : 'eye', 16), h('span.seg-label', null, m === 'edit' ? 'Edit' : m === 'split' ? 'Split' : 'Preview')));
  const modeSwitch = h('div.seg.mode-switch', { role: 'radiogroup', 'aria-label': 'View mode' }, modeBtns);
  const shareBtn = h('button.btn.primary.share-btn', { type: 'button', onclick: () => openShareDialog({ docId, me, title, onChanged: (d) => applyDetail(d) }) }, icon('lock', 16, 'share-lock'), h('span.btn-label', null, 'Share'));
  const shareSlot = guest ? guestSignInButton() : shareBtn;
  /** HTML pages: the rendered page in its own tab. */
  const openPageLink = h('a.btn.ghost.sm.open-page', { href: `/p/${docId}`, target: '_blank', rel: 'noopener', hidden: true, 'data-tip': 'Open the rendered page in a new tab' }, icon('external', 16), h('span.tb-text', null, 'Open page'));
  const moreBtn: HTMLButtonElement = h('button.icon-btn', { type: 'button', 'aria-label': 'More document actions', 'aria-haspopup': 'menu', 'data-tip': 'More', onclick: () => openMenu(moreBtn, moreItems(), { align: 'end' }) }, icon('more', 20));

  const header = h('header.doc-header', null,
    h('a.doc-home', { href: '/', 'data-link': '', 'aria-label': 'All documents', 'data-tip': 'All documents' }, icon('file', 22)),
    navBtn,
    h('div.doc-titlebox', null, titleInput, h('div.doc-subline', null, crumbsEl, rolePill, ownerEl, statusEl)),
    h('div.doc-header-right', null, presenceEl, guest ? null : pingBtn, commentsBtn, modeSwitch, openPageLink, shareSlot, moreBtn, userMenuButton(me, { compact: true })));

  // ------------------------------------------------------------------ toolbar

  const toolbar = h('div.doc-toolbar', { role: 'toolbar', 'aria-label': 'Formatting' });
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, hidden: true, 'aria-hidden': 'true', class: 'image-file-input' });
  const galleryInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, hidden: true, 'aria-hidden': 'true', class: 'gallery-file-input' });
  const anyFileInput = h('input', { type: 'file', multiple: true, hidden: true, 'aria-hidden': 'true', class: 'any-file-input' });
  const avInput = h('input', { type: 'file', accept: 'audio/*,video/*,.mp3,.m4a,.wav,.ogg,.flac,.mp4,.webm,.mov,.m4v', multiple: true, hidden: true, 'aria-hidden': 'true', class: 'av-file-input' });
  anyFileInput.addEventListener('change', () => { const files = [...(anyFileInput.files ?? [])]; anyFileInput.value = ''; if (files.length) void uploadFiles(files, view.state.selection.main.head); });
  avInput.addEventListener('change', () => { const files = [...(avInput.files ?? [])]; avInput.value = ''; if (files.length) void uploadFiles(files, view.state.selection.main.head); });
  galleryInput.addEventListener('change', () => {
    const files = [...(galleryInput.files ?? [])];
    galleryInput.value = '';
    if (files.length) void insertGallery(files);
  });
  // Insert: things that are more than text.
  const insertBtn: HTMLButtonElement = h('button.tb-btn.insert-btn', {
    type: 'button', 'aria-haspopup': 'menu', 'aria-label': 'Insert', 'data-tip': 'Insert a gallery, a sidebar panel, a section…', onmousedown: (e: MouseEvent) => e.preventDefault(),
    onclick: () => openMenu(insertBtn, [
      { label: 'Gallery from images…', icon: 'image', onSelect: () => (guest ? needSignInForImages() : galleryInput.click()) },
      { label: 'Empty gallery block', icon: 'image', onSelect: () => { insertBlock(view, '```gallery\n\n```', { select: [11, 11] }); view.focus(); } },
      'separator',
      { label: 'Audio or video file…', icon: 'play', onSelect: () => (guest ? needSignInForImages() : avInput.click()) },
      { label: 'YouTube or Vimeo video…', icon: 'play', onSelect: () => void embedVideoDialog() },
      { label: 'Any file…', icon: 'download', onSelect: () => (guest ? needSignInForImages() : anyFileInput.click()) },
      'separator',
      { label: 'Math, inline: $…$', icon: 'sparkle', hint: '$x$', onSelect: () => { toggleInline(view, '$'); view.focus(); } },
      { label: 'Math block: $$ … $$', icon: 'sparkle', onSelect: () => { insertBlock(view, '$$\n\n$$', { select: [3, 3] }); view.focus(); } },
      'separator',
      { label: 'Sidebar panel: new…', icon: 'columns', onSelect: () => void newPanel('aside') },
      { label: 'Sidebar panel: existing document…', icon: 'columns', onSelect: () => void mountExisting('aside') },
      'separator',
      { label: 'New section here (split)', icon: 'columns', hint: `${modKey}↵`, onSelect: () => void splitHere() },
      { label: 'New empty section', icon: 'file', onSelect: () => void newPanel('inline') },
      { label: 'Mount an existing document…', icon: 'file', onSelect: () => void mountExisting('inline') },
    ], { align: 'start' }),
  }, icon('plus', 18), h('span.tb-text', null, 'Insert'), icon('chevronDown', 14));
  fileInput.addEventListener('change', () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = '';
    if (files.length) void uploadImages(files, view.state.selection.main.head);
  });
  const styleLabel = h('span.style-label', null, 'Normal text');
  const styleBtn: HTMLButtonElement = h('button.tb-btn.style-btn', {
    type: 'button', 'aria-haspopup': 'menu', 'aria-label': 'Text style', 'data-tip': 'Text style',
    onclick: () => openMenu(styleBtn, ([['p', 'Normal text', 0], ['h1', 'Heading 1', 1], ['h2', 'Heading 2', 2], ['h3', 'Heading 3', 3], ['h4', 'Heading 4', 4]] as [LineKind, string, number][])
      .map(([k, label, n]) => ({ label, checked: lineKindAt(view.state) === k, hint: `${modKey}${altKey}${n}`, onSelect: () => setLineKind(view, k) })), { className: 'style-menu' }),
  }, styleLabel, icon('chevronDown', 14));
  const pressable = new Map<string, HTMLButtonElement>();
  let imageTool!: HTMLButtonElement;
  const tb = (ic: string, label: string, shortcut: string | null, run: () => void, key?: string) => {
    const b = h('button.tb-btn', { type: 'button', 'aria-label': label, 'data-tip': shortcut ? `${label} (${shortcut})` : label, onmousedown: (e: MouseEvent) => e.preventDefault(), onclick: run }, icon(ic, 18));
    if (key) { b.setAttribute('aria-pressed', 'false'); pressable.set(key, b); }
    return b;
  };
  const sep = () => h('span.tb-sep', { role: 'separator' });
  imageTool = tb('image', guest ? 'Insert image (sign in to add images)' : 'Insert image', null, () => (guest ? needSignInForImages() : fileInput.click()));
  const editTools = h('div.tb-group.edit-tools', null,
    tb('undo', 'Undo', `${modKey}Z`, () => { if (suggesting()) cmUndo(view); else binding.runUndo(false); view.focus(); }),
    tb('redo', 'Redo', isMac ? '⌘⇧Z' : 'Ctrl+Y', () => { if (suggesting()) cmRedo(view); else binding.runUndo(true); view.focus(); }),
    sep(), styleBtn, sep(),
    tb('bold', 'Bold', `${modKey}B`, () => toggleInline(view, '**'), 'StrongEmphasis'),
    tb('italic', 'Italic', `${modKey}I`, () => toggleInline(view, '*'), 'Emphasis'),
    tb('strike', 'Strikethrough', isMac ? '⌘⇧X' : 'Ctrl+Shift+X', () => toggleInline(view, '~~'), 'Strikethrough'),
    tb('code', 'Inline code', `${modKey}E`, () => toggleInline(view, '`'), 'InlineCode'),
    tb('link', 'Insert link', `${modKey}K`, () => linkDialog(), 'Link'),
    sep(),
    tb('list', 'Bulleted list', isMac ? '⌘⇧8' : 'Ctrl+Shift+8', () => setLineKind(view, 'ul'), 'ul'),
    tb('listOrdered', 'Numbered list', isMac ? '⌘⇧7' : 'Ctrl+Shift+7', () => setLineKind(view, 'ol'), 'ol'),
    tb('listChecks', 'Checklist', isMac ? '⌘⇧9' : 'Ctrl+Shift+9', () => setLineKind(view, 'task'), 'task'),
    tb('quote', 'Quote', null, () => setLineKind(view, 'quote'), 'quote'),
    sep(),
    tb('codeBlock', 'Code block', null, () => toggleCodeBlock(view)),
    tb('table', 'Insert table', null, () => insertTable(view)),
    tb('hr', 'Horizontal line', null, () => insertRule(view)),
    imageTool,
    sep(),
    insertBtn,
    fileInput, galleryInput);
  const commentTool = h('button.tb-btn.tb-comment', { type: 'button', 'aria-label': 'Add comment', 'data-tip': `Add comment (${modKey}${altKey}M)`, onmousedown: (e: MouseEvent) => e.preventDefault(), onclick: () => rail.startDraft() }, icon('commentAdd', 18), h('span.tb-text', null, 'Comment'));
  const readNotice = h('div.tb-notice');
  // Editing / Suggesting switch, the state of your suggestions, and reviewing others'.
  const writeModeLabel = h('span.tb-text');
  const writeModeBtn: HTMLButtonElement = h('button.tb-btn.write-mode', {
    type: 'button', 'aria-haspopup': 'menu', onmousedown: (e: MouseEvent) => e.preventDefault(),
    onclick: () => openMenu(writeModeBtn, [
      { label: 'Editing', icon: 'pencil', checked: !suggesting(), hint: 'Edit directly', onSelect: () => void setSuggesting(false) },
      { label: 'Suggesting', icon: 'suggest', checked: suggesting(), hint: 'Edits become suggestions', onSelect: () => void setSuggesting(true) },
    ], { align: 'end', className: 'write-mode-menu' }),
  }, h('span.wm-icon'), writeModeLabel, h('span.wm-chev', null, icon('chevronDown', 14)));
  const suggestStatus = h('span.sugg-status', { role: 'status', 'aria-live': 'polite' });
  const reviewLabel = h('span.tb-text');
  const reviewBtn: HTMLButtonElement = h('button.tb-btn.review-btn', {
    type: 'button', 'aria-haspopup': 'menu', hidden: true, onmousedown: (e: MouseEvent) => e.preventDefault(),
    onclick: () => openMenu(reviewBtn, [
      { label: 'Next suggestion', icon: 'arrowLeft', onSelect: () => { if (listOpen === false && rail.layout === 'drawer') toggleList(true); rail.nextSuggestion(); } },
      ...(canEdit() ? ['separator' as const,
        { label: 'Accept all', icon: 'check', onSelect: () => void rail.decideAll('accept') },
        { label: 'Reject all', icon: 'x', danger: true, onSelect: () => void rail.decideAll('reject') }] : []),
    ], { align: 'end' }),
  }, icon('suggest', 16), reviewLabel);
  toolbar.append(editTools, readNotice, h('span.tb-spacer'), suggestStatus, reviewBtn, writeModeBtn, commentTool);

  // ------------------------------------------------------------------ body

  const pageEl = h('div.page.editor-page');
  const pageWrap = h('div.page-wrap', null, pageEl);
  const canvas = h('div.doc-canvas', null, pageWrap);
  const editPane = h('div.doc-scroll.edit-pane', { tabindex: '-1' }, canvas);
  const previewBody = h('article.prose.preview-body');
  const previewPage = h('div.page.preview-page', null, previewBody);
  const previewCanvas = h('div.doc-canvas', null, previewPage);
  // An HTML page previews as itself, in a sandboxed frame (opaque origin: its scripts cannot reach this app).
  const pageFrame = h('iframe.page-frame', { title: 'Page preview', sandbox: 'allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock allow-presentation', hidden: true });
  const previewPane = h('div.doc-scroll.preview-pane', { 'aria-label': 'Preview' }, previewCanvas, pageFrame);
  const overlay = h('div.doc-overlay', { hidden: true });
  const syncVeil = h('div.sync-veil', null, spinner(24), h('span', null, 'Loading document…'));
  const body = h('div.doc-body', null, editPane, previewPane, overlay);
  const app = h('div.doc-app', null, h('div.doc-chrome', null, header, h('div.doc-toolbar-wrap', null, toolbar)), body);
  pageEl.append(syncVeil);
  root.replaceChildren(app);
  document.title = `${title || 'Section'} · Anima Docs`;

  // ------------------------------------------------------------------ editor

  const readOnlyC = new Compartment();
  /** The language and the inline previews switch with the document's type (markdown vs an HTML page). */
  const langC = new Compartment();
  const liveC = new Compartment();
  const placeholderC = new Compartment();
  /** How edits reach the shared text: directly (editing) or as suggestions. */
  const syncC = new Compartment();
  const liveSync = () => [];
  const suggestSync = (s: SuggestSession) => [s.extension(), history(), keymap.of(historyKeymap)];
  let view!: EditorView;

  const rail = new CommentsRail({ provider, nodes, layout: () => binding.current, view: () => view ?? null, me, role: () => role, docId, coords, session: () => session });
  rail.onSuggestionsChange = (n) => {
    reviewBtn.hidden = n === 0;
    reviewLabel.textContent = `${n} suggestion${n === 1 ? '' : 's'}`;
    reviewBtn.setAttribute('aria-label', `${n} open suggestion${n === 1 ? '' : 's'}: review`);
  };
  pageWrap.append(rail.fab);
  canvas.append(rail.el);
  rail.onCountChange = (n) => { commentsCount.hidden = n === 0; commentsCount.textContent = String(n); commentsBtn.setAttribute('aria-label', `Show all comments (${n} open)`); };
  rail.onDrawerChange = (open) => { listOpen = open; if (open) panel.close(); computeLayout(); };

  const panel = new SidePanel({ docId, role: () => role, title: () => title });
  body.append(panel.el);
  panel.onClose = () => computeLayout();

  const onUpdate = (u: ViewUpdate) => {
    if (u.docChanged) { rail.onDocChanged(); schedulePreview(); }
    if (u.selectionSet || u.focusChanged || u.docChanged) {
      const user = u.transactions.some((tr) => tr.isUserEvent('select') || tr.isUserEvent('input') || tr.isUserEvent('delete'));
      rail.onSelection(u.view, user && u.selectionSet);
      updateToolbarState();
    }
    if (u.geometryChanged || u.heightChanged || u.viewportChanged) { rail.layoutSoon(); fabSoon(); }
  };
  const fabSoon = rafThrottle(() => view && rail.updateFab(view));

  view = new EditorView({
    parent: pageEl,
    state: EditorState.create({
      doc: binding.layout().text,
      extensions: [
        readOnlyC.of(EditorState.readOnly.of(!canWrite())),
        placeholderC.of(canEdit() ? placeholder('Start writing…  Markdown works: # heading, **bold**, - list, | table |') : []),
        // The node binding is always on; suggesting adds the session on top (the binding hands it shared changes).
        binding.extensions(), nodeInfo.of(labelOf), subpagesSource.of(() => nav.subpagesNotInline()), viewMap.of(() => coords()),
        syncC.of(liveSync()),
        remoteCursors(nodes, () => binding.current, coords),
        suggestionOverlays,
        // `[[` links to a document, `{{` mounts one inline.
        documentCompletions({ currentId: () => docId, canMount: () => canWrite() }),
        langC.of(markdown({ base: markdownLanguage, codeLanguages, addKeymap: true })),
        syntaxHighlighting(docHighlight),
        liveC.of(livePreview),
        commentHighlights,
        EditorView.lineWrapping,
        drawSelection(),
        dropCursor(),
        highlightSpecialChars(),
        search({ top: true }),
        Prec.high(keymap.of([
          { key: 'Mod-Alt-m', run: () => { rail.startDraft(); return true; } },
          { key: 'Mod-k', run: () => { if (canWrite()) linkDialog(); return true; } },
          { key: 'Mod-Enter', run: () => { void splitHere(); return true; } },
          { key: 'Escape', run: () => { if (rail.active) { rail.setActive(null); return true; } return false; } },
          ...formatKeymap,
        ])),
        keymap.of([...defaultKeymap, ...searchKeymap, indentWithTab]),
        EditorView.contentAttributes.of({ 'aria-label': 'Document text', spellcheck: 'true', autocapitalize: 'sentences', 'aria-multiline': 'true' }),
        EditorView.domEventHandlers({
          paste: (e) => {
            const files = [...(e.clipboardData?.files ?? [])];
            if (!files.length || !canWrite()) return false;
            e.preventDefault();
            if (suggesting()) { toast(canEdit() ? 'Switch to Editing to add files.' : 'Files can’t be suggested yet; describe them in a comment.', { kind: 'info' }); return true; }
            if (guest) { needSignInForImages(); return true; }
            void uploadFiles(files, view.state.selection.main.head);
            return true;
          },
          drop: (e, v) => {
            const files = [...(e.dataTransfer?.files ?? [])];
            if (!files.length) return false;
            e.preventDefault();
            if (!canEdit()) { toast('You need edit access to add files.', { kind: 'error' }); return true; }
            if (suggesting()) { toast('Switch to Editing to add files.', { kind: 'info' }); return true; }
            if (guest) { needSignInForImages(); return true; }
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head;
            void uploadFiles(files, pos);
            return true;
          },
          click: (e) => {
            const hl = (e.target as Element).closest?.('[data-thread]') as HTMLElement | null;
            if (hl?.dataset.thread) rail.setActive(hl.dataset.thread);
            return false;
          },
        }),
        EditorView.updateListener.of(onUpdate),
      ],
    }),
  });
  cleanups.push(() => view.destroy());

  // ------------------------------------------------------------------ nodes: nav, crumbs, structural operations

  let navOpen = loadNav();
  body.prepend(nav.el);
  /** `remember`: the person chose; a default is never persisted as a choice. */
  function setNav(open: boolean, remember = false) {
    navOpen = open;
    app.classList.toggle('nav-open', open);
    navBtn.setAttribute('aria-pressed', String(open));
    if (remember) saveNav(open);
    computeLayout();
    requestAnimationFrame(() => view.requestMeasure());
  }
  function updateCrumbs() {
    const c = nav.crumbs();
    if (c.length < 2) { crumbsEl.replaceChildren(); crumbsEl.hidden = true; return; }
    crumbsEl.hidden = false;
    const parts: HTMLElement[] = [];
    c.slice(0, -1).forEach((x, i) => { if (i) parts.push(h('span.crumb-sep', null, '›')); parts.push(h('a.crumb', { href: `/d/${x.id}?tree=${encodeURIComponent(nav.tree ?? '')}`, 'data-link': '' }, x.title || 'Untitled')); });
    crumbsEl.replaceChildren(...parts);
  }
  /** The Subpages footer reads a facet: nudge the view when the tree changes. */
  function refreshFooter() { if (view && !session) view.dispatch({ effects: nudge.of(null) }); }
  provider.on('tree', () => void nav.refresh());

  /** Where the cursor is, as (node, offset). */
  function cursorNode(): { node: string; offset: number } | null {
    return nodePos(binding.current, view.state.selection.main.head);
  }
  async function splitHere() {
    if (!canEdit() || suggesting()) { toast('Splitting needs edit access (and not suggesting mode).', { kind: 'info' }); return; }
    const at = cursorNode();
    if (!at) { toast('Put the cursor where the new section should start.', { kind: 'info' }); return; }
    if (!binding.opts.canEdit(at.node)) { toast('That section is read-only for you.', { kind: 'info' }); return; }
    try {
      const d = await api.split(at.node, at.offset);
      toast(h('span', null, 'Split: the rest is a section now. ', h('button.link-btn', { type: 'button', onclick: () => void nameSection(d.id) }, 'Name it')), { kind: 'success', timeout: 6000 });
    } catch (e) { toast(errorMessage(e), { kind: 'error' }); }
  }
  /** A YouTube or Vimeo address becomes an embed line: `![title](url)`. */
  async function embedVideoDialog() {
    if (!canWrite()) return;
    const url = await promptDialog({ title: 'Embed a video', label: 'YouTube or Vimeo address', placeholder: 'https://www.youtube.com/watch?v=…', confirmLabel: 'Embed' });
    if (!url) return;
    const e = embedOf(url.trim());
    if (!e || (e.kind !== 'youtube' && e.kind !== 'vimeo')) { toast('That is not a YouTube or Vimeo video address.', { kind: 'error' }); return; }
    insertBlock(view, `![](${url.trim()})`);
    view.focus();
  }

  /** Upload files of any kind at the cursor: images as images, audio and video as players, the rest as file links. */
  async function uploadFiles(files: File[], at: number) {
    const images = files.filter(isImageFile), others = files.filter((f) => !isImageFile(f));
    if (images.length) await uploadImages(images, at);
    if (!others.length || !canEdit() || guest || suggesting()) return;
    for (const f of others) {
      if (f.size > MAX_FILE) { toast(`${f.name} is larger than ${MAX_FILE / 1024 / 1024} MB.`, { kind: 'error' }); continue; }
      const close = toast(h('span.uploading', null, spinner(14), `Uploading ${f.name}…`), { timeout: 0 });
      try {
        const info = await api.upload(docId, f, f.name);
        const label = (f.name.replace(/[[\]\\]/g, ' ').trim() || 'file').slice(0, 120);
        const md = info.kind === 'audio' || info.kind === 'video' ? `![${label.replace(/\.[a-z0-9]+$/i, '')}](${info.url})` : `[${label}](${info.url})`;
        insertBlock(view, md, { at: Math.min(view.state.selection.main.head, view.state.doc.length) });
      } catch (e) {
        if (e instanceof ApiError && e.status === 429) { toast(`${errorMessage(e)} Files can be added again tomorrow.`, { kind: 'error' }); close(); break; }
        toast(`${f.name}: ${errorMessage(e)}`, { kind: 'error' });
      } finally { close(); }
    }
  }

  /** Upload images and insert them as one gallery block at the cursor. */
  async function insertGallery(files: File[]) {
    if (!canWrite() || guest) return;
    const lines: string[] = [];
    for (const f of files) {
      if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) { toast(`${f.name}: only PNG, JPEG, GIF and WebP images are supported.`, { kind: 'error' }); continue; }
      if (f.size > MAX_IMAGE) { toast(`${f.name} is larger than 15 MB.`, { kind: 'error' }); continue; }
      const close = toast(h('span.uploading', null, spinner(14), `Uploading ${f.name}…`), { timeout: 0 });
      try {
        const info = await api.upload(docId, f);
        const alt = (f.name.replace(/\.[a-z0-9]+$/i, '').replace(/[[\]\\|]/g, ' ').trim() || 'image').slice(0, 80);
        lines.push(`![${alt}](${info.url})`);
      } catch (e) { toast(`${f.name}: ${errorMessage(e)}`, { kind: 'error' }); }
      finally { close(); }
    }
    if (!lines.length) return;
    insertBlock(view, '```gallery\n' + lines.join('\n') + '\n```');
    view.focus();
  }

  /** A new node (a section or a sidebar panel), mounted at the cursor. */
  async function newPanel(role: 'aside' | 'inline') {
    if (!canEdit()) { toast('You need edit access to add sections.', { kind: 'info' }); return; }
    const at = cursorNode();
    if (!at || !binding.opts.canEdit(at.node)) { toast('Put the cursor where it should go.', { kind: 'info' }); return; }
    // Sections are nameless until named (the band's "Name…"); a panel asks, since its name is its heading in the wiki.
    const title = role === 'aside' ? await promptDialog({ title: 'New sidebar panel', label: 'Name', placeholder: 'e.g. Facts (shown as a panel in the wiki)', confirmLabel: 'Create' }) : '';
    if (title === null) return;
    try {
      const d = await api.createSection(at.node, { title: title.trim(), content: role === 'aside' ? '| | |\n|---|---|\n| Key | Value |\n' : '', mount: false });
      insertBlock(view, `{{node:${d.id}${role === 'aside' ? '|aside' : ''}}}`);
      view.focus();
    } catch (e) { toast(errorMessage(e), { kind: 'error' }); }
  }

  /** Pick a document you can open and mount it at the cursor (inline, or as a panel). */
  async function mountExisting(role: 'aside' | 'inline') {
    if (!canEdit()) { toast('You need edit access to mount documents.', { kind: 'info' }); return; }
    const chosen = await pickDocument(role === 'aside' ? 'Add as a sidebar panel' : 'Mount a document');
    if (!chosen) return;
    insertBlock(view, `{{node:${chosen.id}${role === 'aside' ? '|aside' : ''}}}`);
    view.focus();
  }

  function pickDocument(title: string): Promise<{ id: string; title: string } | null> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: { id: string; title: string } | null) => { if (!done) { done = true; resolve(v); } d.close(); };
      const input = h('input.input', { type: 'search', placeholder: 'Search documents', 'aria-label': 'Search documents', autofocus: true });
      const list = h('div.pick-list', { role: 'listbox' });
      const load = debounce(async () => {
        try {
          const r = await api.docs({ q: input.value.trim() || undefined });
          list.replaceChildren(...r.docs.filter((x) => x.id !== docId).slice(0, 30).map((x) => h('button.pick-row', { type: 'button', role: 'option', onclick: () => finish({ id: x.id, title: x.title }) }, icon('file', 16), h('span', null, x.title || 'Untitled'), h('span.meta', null, x.role))));
          if (!list.childElementCount) list.replaceChildren(h('div.meta', null, 'Nothing matches.'));
        } catch (e) { list.replaceChildren(h('div.meta', null, errorMessage(e))); }
      }, 150);
      input.addEventListener('input', () => load());
      const d = openDialog({ title, size: 'sm', body: h('div.form-stack', null, input, list), footer: [h('button.btn.ghost', { type: 'button', onclick: () => finish(null) }, 'Cancel')], onClose: () => finish(null) });
      void load();
    });
  }

  async function mergeSection(m: Mount) {
    if (!binding.opts.canEdit(m.parent)) { toast('You can’t edit the containing document.', { kind: 'info' }); return; }
    const l = labelOf(m.child);
    const name = l?.section ? 'this section' : `“${l?.title || 'Untitled'}”`;
    const ok = await confirmDialog({ title: `Merge ${name} into the text?`, message: 'Its text replaces the section boundary here. If it is mounted elsewhere too it is copied in and stays a node; otherwise its comments come along and it stops being a section.', confirmLabel: 'Merge' });
    if (!ok) { view.focus(); return; }
    try {
      const r = await api.merge(m.parent, m.child);
      toast(r.copied ? 'Copied in (it is still mounted elsewhere).' : 'Merged.', { kind: 'success', timeout: 3000 });
    } catch (e) { toast(errorMessage(e), { kind: 'error' }); }
    view.focus();
  }
  /** Place this document in a space (under its root; drag it elsewhere in the panel): everyone who can open the space can then open it. */
  async function addToSpace() {
    let spaces: TreeRoot[] = [];
    try { spaces = (await api.trees()).trees.filter((t) => atLeast(t.role, 'editor') && t.root !== docId).sort((a, b) => (a.title || '').localeCompare(b.title || '')); }
    catch (e) { toast(errorMessage(e), { kind: 'error' }); return; }
    if (!spaces.length) { toast('No space you can edit yet. Make a document a space from the left panel first.', { kind: 'info' }); return; }
    let chosen: TreeRoot | null = null;
    const list = h('div.pick-list', { role: 'listbox' }, ...spaces.map((t) => h('button.pick-row', { type: 'button', role: 'option', onclick: () => { chosen = t; d.close(); } }, icon('columns', 16), h('span', null, t.title || 'Untitled'), h('span.meta', null, t.role))));
    const d = openDialog({ title: 'Add to a space', size: 'sm', body: h('div.form-stack', null, h('p.meta', null, 'Everyone who can open the space will be able to open this document.'), list), footer: [h('button.btn.ghost', { type: 'button', onclick: () => d.close() }, 'Cancel')], onClose: () => {
      if (!chosen) return;
      const t = chosen;
      void api.place(t.root, t.root, docId).then(async () => { toast(h('span', null, 'Added to ', h('strong', null, t.title || 'Untitled'), '.'), { kind: 'success', timeout: 4000 }); nav.tree = t.root; await nav.refresh(); openNode(docId, t.root); }).catch((e) => toast(errorMessage(e), { kind: 'error' }));
    } });
  }

  /** Change how a node renders: markdown, latex (each paragraph a display formula) or text (verbatim). */
  function typeMenu(id: string, anchor: HTMLElement) {
    const cur = labelOf(id)?.type ?? 'markdown';
    const canChange = id === docId ? canEdit() : binding.opts.canEdit(id);
    const kinds: [NodeType, string, string][] = [['markdown', 'Markdown', 'text with formatting'], ['html', 'HTML page', 'a whole page with its own styles and scripts, shown in a sandbox'], ['latex', 'LaTeX (math)', 'each paragraph is a display formula'], ['text', 'Plain text', 'shown verbatim, monospace']];
    openMenu(anchor, [
      { heading: 'Node type' },
      ...kinds.map(([t, label, hint]) => ({ label, hint, checked: cur === t, disabled: !canChange, onSelect: () => { void api.patchDoc(id, { type: t }).then(() => { toast(`Now ${label}.`, { kind: 'success', timeout: 2500 }); if (id === docId) setTimeout(applyDocType, 50); else schedulePreview(); }).catch((e) => toast(errorMessage(e), { kind: 'error' })); } })),
    ], { align: 'start' });
  }
  async function nameSection(id: string) {
    const name = await promptDialog({ title: 'Name this section', label: 'Name', placeholder: 'A name makes it a document of its own', confirmLabel: 'Name' });
    if (name === null) return;
    try { await api.patchDoc(id, { title: name }); toast(name ? 'Named. It shows in trees and lists now.' : 'Nameless.', { kind: 'success', timeout: 3000 }); }
    catch (e) { toast(errorMessage(e), { kind: 'error' }); }
  }

  // ------------------------------------------------------------------ toolbar state

  const updateToolbarState = rafThrottle(() => {
    if (!canWrite()) return;
    const kind = lineKindAt(view.state);
    styleLabel.textContent = kind.startsWith('h') ? `Heading ${kind[1]}` : 'Normal text';
    const active = new Set<string>([kind]);
    const head = view.state.selection.main.head;
    for (let n: any = syntaxTree(view.state).resolveInner(head, -1); n; n = n.parent) active.add(n.name);
    for (const [k, b] of pressable) b.setAttribute('aria-pressed', String(active.has(k)));
  });

  // ------------------------------------------------------------------ role & meta

  function applyRole(next: Role, announce = false) {
    const prev = role;
    role = next;
    provider.role = next;
    // Commenters suggest; viewers only read. Editors keep whichever mode they chose.
    if (!atLeast(role, 'commenter') && session) void setSuggesting(false);
    else if (role === 'commenter' && !session && provider.synced) void setSuggesting(true);
    refreshWriteUi();
    titleInput.readOnly = !canEdit();
    titleInput.title = canEdit() ? 'Rename' : '';
    rolePill.textContent = canEdit() ? (role === 'owner' ? 'Owner' : 'Editing') : role === 'commenter' ? 'Commenting' : 'Viewing';
    if (typeApplied && prev !== next) applyDocType(); // a reader of an HTML page sees the page
    rolePill.className = `role-pill role-${role}`;
    rolePill.setAttribute('data-tip', canEdit() ? `You can edit (${ROLE_LABEL[role]})` : role === 'commenter' ? 'You can suggest edits and comment' : 'You can read this document');
    app.classList.toggle('can-edit', canEdit());
    app.classList.toggle('can-comment', atLeast(role, 'commenter'));
    commentTool.hidden = !atLeast(role, 'commenter');
    pingBtn.hidden = !atLeast(role, 'commenter');
    rail.refreshPermissions();
    if (announce && prev !== next) {
      toast(h('span', null, 'Your access changed to ', h('strong', null, ROLE_LABEL[next].toLowerCase()), '.'), { kind: atLeast(next, prev) ? 'success' : 'info' });
    }
  }

  /** Toolbar and editor state for the current role and writing mode. */
  function refreshWriteUi() {
    const sug = suggesting();
    view.dispatch({ effects: [
      readOnlyC.reconfigure(EditorState.readOnly.of(!canWrite() || switching)),
      placeholderC.reconfigure(canEdit() && !sug ? placeholder('Start writing…') : []),
    ] });
    app.classList.toggle('suggesting', sug);
    editTools.hidden = !canWrite();
    imageTool.hidden = sug;
    readNotice.hidden = canWrite() || role === 'commenter';
    readNotice.replaceChildren(icon('eye', 16), role === 'commenter' ? 'Connecting…' : 'View only. Ask the owner for access to comment or edit.');
    toolbar.classList.toggle('reader', !canWrite());
    writeModeBtn.hidden = !atLeast(role, 'commenter');
    writeModeBtn.disabled = !canEdit();
    writeModeBtn.classList.toggle('on', sug);
    writeModeBtn.querySelector('.wm-icon')!.replaceChildren(icon(sug ? 'suggest' : 'pencil', 16));
    writeModeLabel.textContent = sug ? 'Suggesting' : 'Editing';
    writeModeBtn.setAttribute('data-tip', canEdit()
      ? (sug ? 'Suggesting: your edits become suggestions the owner can accept or reject' : 'Editing: your changes go straight into the document')
      : 'You can suggest edits: type in the document and the owner reviews them');
    writeModeBtn.setAttribute('aria-label', `Writing mode: ${sug ? 'Suggesting' : 'Editing'}`);
    renderSuggestStatus();
  }

  const renderSuggestStatus = () => {
    const s = session;
    if (!s) { suggestStatus.replaceChildren(); suggestStatus.hidden = true; return; }
    suggestStatus.hidden = false;
    const stuck = s.stuck;
    if (stuck) {
      suggestStatus.className = 'sugg-status error';
      suggestStatus.replaceChildren(icon('alert', 14), `${stuck} change${stuck === 1 ? '' : 's'} not saved`,
        h('button.link-btn', { type: 'button', onclick: () => s.discardStuck() }, 'Discard'));
    } else if (s.unsaved) {
      suggestStatus.className = 'sugg-status saving';
      suggestStatus.replaceChildren(h('span.dot-pulse'), h('span.sugg-status-text', null, 'Saving…'));
      suggestStatus.setAttribute('data-tip', 'Saving your changes as suggestions');
    } else {
      suggestStatus.className = 'sugg-status';
      suggestStatus.replaceChildren(...(s.count ? [icon('cloudCheck', 15), h('span.sugg-status-text', null, 'Suggestions saved')] : []));
      suggestStatus.setAttribute('data-tip', 'Your changes are saved as suggestions. The owner accepts or rejects them.');
    }
  };
  const sessionChanged = rafThrottle(() => { renderSuggestStatus(); rail.render(); rail.onDocChanged(); });

  /** Enter or leave suggesting mode. */
  async function setSuggesting(on: boolean, opts: { remember?: boolean } = {}) {
    if (switching || on === suggesting()) return;
    if (on && !atLeast(role, 'commenter')) return;

    if (!on && role === 'commenter') return; // commenters can only suggest
    if (opts.remember !== false && canEdit()) saveSuggestPref(docId, on);
    if (on) {
      if (!provider.synced) { wantSuggest = true; return; }
      const s = new SuggestSession({ provider, meSub: me.sub, nodes, layout: () => binding.current });
      s.onChange = sessionChanged;
      s.onError = (m) => toast(`A suggestion couldn’t be saved: ${m}`, { kind: 'error' });
      s.onNotice = (m) => toast(m, { kind: 'info', timeout: 8000 });
      session = s;
      binding.suspend((R) => s.remote(R));
      view.dispatch({ effects: syncC.reconfigure(suggestSync(s)) });
      s.onThreads(rail.threads);
      refreshWriteUi();
      rail.refreshPermissions();
      rail.onDocChanged();
      return;
    }
    const s = session!;
    // Save first; anything still unsaved (offline, or refused) would be lost on leaving.
    await s.sync().catch(() => false);
    if (session !== s) return;
    const unsaved = s.unsaved;
    if (unsaved && !(await confirmDialog({
      title: 'Leave suggesting?',
      message: `${unsaved} of your changes ${provider.status === 'online' ? 'couldn’t be saved' : 'aren’t saved yet (you’re offline)'} and will be lost if you switch to editing now.`,
      confirmLabel: 'Leave anyway', danger: true,
    }))) return;
    if (session !== s) return;
    switching = true;
    refreshWriteUi();
    try {
      await s.finish();
    } finally {
      session = null;
      switching = false;
      view.dispatch({ effects: syncC.reconfigure(liveSync()) });
      binding.resume();
      refreshWriteUi();
      rail.refreshPermissions();
      rail.onDocChanged();
    }
  }
  let wantSuggest = false;

  function applyDetail(d: { title?: string; owner?: { sub: string; label: string }; generalAccess?: string; publicLink?: boolean; updatedAt?: number }) {
    if (typeof d.title === 'string' && d.title !== title) {
      title = d.title;
      if (document.activeElement !== titleInput) { titleInput.value = title; titleBefore = title; }
      document.title = `${title || 'Section'} · Anima Docs`;
      titleInput.placeholder = title ? 'Untitled' : 'Unnamed section — name it to make it a document';
    }
    if (d.owner) {
      const name = splitLabel(d.owner.label).name;
      ownerEl.textContent = d.owner.sub === me.sub ? 'Owned by you' : `Owned by ${name}`;
    }
    // Realtime meta carries no publicLink: keep what we last heard from the API.
    if (d.generalAccess) generalAccess = d.generalAccess as GeneralAccess;
    if (typeof d.publicLink === 'boolean') publicLink = d.publicLink;
    if (d.generalAccess || typeof d.publicLink === 'boolean') {
      const open = generalAccess !== 'restricted';
      const tip = [publicLink ? 'Anyone with a link can open this' : null, open ? `Archipelago members can ${ROLE_VERB[generalAccess as Role]}` : null].filter(Boolean).join(' · ') || 'Restricted: only people added can open';
      shareBtn.replaceChildren(icon(publicLink ? 'globe' : open ? 'users' : 'lock', 16, 'share-lock'), h('span.btn-label', null, 'Share'));
      shareBtn.setAttribute('data-tip', tip);
      shareBtn.setAttribute('aria-label', `Share. ${tip}`);
      shareBtn.classList.toggle('public', publicLink);
    }
  }
  applyDetail(detail);
  applyRole(role);

  // ------------------------------------------------------------------ connection status

  let statusTimer = 0;
  const renderStatus = () => {
    clearTimeout(statusTimer);
    const s: ConnStatus = provider.status;
    statusEl.className = `conn conn-${s}`;
    if (s === 'online') {
      statusEl.replaceChildren(icon('cloudCheck', 15), provider.synced ? 'Saved' : 'Syncing…');
      statusEl.setAttribute('data-tip', 'Changes sync live to everyone in this document');
    } else if (s === 'connecting') {
      statusEl.replaceChildren(h('span.dot-pulse'), 'Connecting…');
      statusEl.removeAttribute('data-tip');
    } else if (s === 'offline') {
      const secs = Math.max(0, Math.ceil((provider.retryAt - Date.now()) / 1000));
      statusEl.replaceChildren(icon('offline', 15), provider.hasUnsent ? 'Offline · your edits will sync when you reconnect' : `Offline · retrying${secs ? ` in ${secs}s` : '…'}`,
        h('button.link-btn', { type: 'button', onclick: () => provider.retryNow() }, 'Retry'));
      statusEl.setAttribute('data-tip', 'Can’t reach the server');
      statusTimer = window.setTimeout(renderStatus, 1000);
    } else {
      statusEl.replaceChildren(icon('alert', 15), 'Disconnected');
    }
    app.classList.toggle('is-offline', s !== 'online');
  };
  renderStatus();
  cleanups.push(() => clearTimeout(statusTimer));

  provider.on('status', renderStatus);
  // Back online: save suggestions typed while away.
  provider.on('status', (st) => { if (st === 'online' && session?.unsaved) void session.sync(); });
  provider.on('hello', ({ role: r, doc }) => { if (r !== role) applyRole(r, true); if (doc) applyDetail(doc); });
  provider.on('synced', () => {
    renderStatus();
    syncVeil.remove();
    rail.setSynced();
    if (!session && (wantSuggest || role === 'commenter' || (canEdit() && loadSuggestPref(docId)))) { wantSuggest = false; void setSuggesting(true, { remember: false }); }
    schedulePreview();
    if (ctx.restoreScroll) requestAnimationFrame(() => { editPane.scrollTop = ctx.restoreScroll!; });
    if (canEdit() && provider.ytext.length === 0) view.focus();
  });
  cleanups.push(nodes.onThreads((threads, ev) => { session?.onThreads(threads); rail.setThreads(threads, ev); }));
  provider.on('meta', (d) => applyDetail(d));
  provider.on('role', (r) => applyRole(r, true));
  // A guest renamed (here or in another tab): show it, and re-announce so others see the new name.
  const announce = () => provider.awareness.setLocalStateField('user', { name: me.name, color: me.color, sub: me.sub, kind: me.kind });
  provider.on('you', (you) => { if (you.sub === me.sub) updateMe(you); });
  cleanups.push(onMeChanged(() => { announce(); rail.refreshPermissions(); }));
  provider.on('error', (m) => toast(m, { kind: 'error' }));
  provider.on('resync', (message) => ctx.onResync(message, editPane.scrollTop));
  provider.on('closed', ({ code, reason }) => {
    if (code === 4001) {
      // Session expired or signed out elsewhere: back to sign-in, returning here afterwards.
      toast('Your session ended. Sign in again to continue.', { kind: 'info' });
      signalUnauthorized();
      return;
    }
    if (code === 4004) {
      toast(h('span', null, h('strong', null, `“${title}”`), ' was deleted.'), { kind: 'info' });
      navigate('/');
      return;
    }
    // 4003: blocked, signed out, or access removed (for a guest: the link was turned off). Stop and explain.
    view.dispatch({ effects: readOnlyC.reconfigure(EditorState.readOnly.of(true)) });
    const blocked = /block/i.test(reason);
    overlay.hidden = false;
    overlay.replaceChildren(h('div.overlay-card', { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'overlay-title' },
      icon(blocked ? 'lock' : guest ? 'unlink' : 'lock', 34, 'overlay-icon'),
      h('h2#overlay-title', null, blocked ? 'You can’t use this document right now' : guest ? 'This link was turned off' : 'Your access was removed'),
      h('p', null, blocked
        ? 'Your session was signed out or blocked on this service. Contact an administrator if this is unexpected.'
        : guest
          ? 'You opened this document through a share link that no longer works, so your access has ended. Ask whoever sent it for a new one.'
          : 'Someone changed the sharing settings, so you can no longer open this document.'),
      h('div.row-gap', null,
        h('a.btn.primary', { href: '/', 'data-link': '' }, guest ? 'Your documents' : 'Go to documents'),
        guest && !blocked ? h('button.btn', { type: 'button', onclick: () => startSignIn('/') }, icon('login', 16), 'Sign in') : null)));
  });

  // ------------------------------------------------------------------ presence

  const renderPresence = rafThrottle(() => {
    const seen = new Map<string, { name: string; color: string; kind: string; client: number; cursor: any }>();
    provider.awareness.getStates().forEach((s: any, client: number) => {
      if (client === provider.doc.clientID || !s?.user?.sub || s.user.sub === me.sub) return;
      const prev = seen.get(s.user.sub);
      if (!prev || (!prev.cursor && s.cursor)) seen.set(s.user.sub, { name: s.user.name, color: s.user.color, kind: s.user.kind, client, cursor: s.cursor });
    });
    const people = [...seen.values()].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'human' ? -1 : 1));
    const shown = people.slice(0, 5);
    presenceEl.replaceChildren(...shown.map((p) => {
      const what = p.kind === 'agent' ? 'Agent' : p.kind === 'service' ? 'Service' : '';
      return h('button.presence-btn', {
        type: 'button', 'aria-label': `${p.name}${what ? ` (${what.toLowerCase()})` : ''}: jump to cursor`, 'data-tip': `${p.name}${what ? ` · ${what}` : ''}${p.cursor ? '' : ' · viewing'}`,
        onclick: () => jumpTo(p.cursor),
      }, avatar(p, 30, { ring: true }));
    }), ...(people.length > 5 ? [h('span.presence-more', { 'data-tip': people.slice(5).map((p) => p.name).join(', ') }, `+${people.length - 5}`)] : []));
    presenceEl.hidden = people.length === 0;
  });
  const jumpTo = (cursor: any) => {
    if (!cursor?.head) return;
    try {
      const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.head), provider.doc);
      if (abs) { if (mode === 'preview') setMode('edit'); view.dispatch({ effects: EditorView.scrollIntoView(Math.min(coords().toView(abs.index), view.state.doc.length), { y: 'center' }) }); }
    } catch { /* stale cursor */ }
  };
  provider.awareness.on('change', renderPresence);
  cleanups.push(() => provider.awareness.off('change', renderPresence));
  renderPresence();

  // ------------------------------------------------------------------ modes & layout

  /** The flattened text for rendering: latex and text nodes wrapped by type (markdown as is). */
  function renderSource(L: Layout): string {
    const typeOf = (id: string) => labelOf(id)?.type ?? 'markdown';
    let text = L.text;
    const wrapped: Mount[] = [];
    // Deepest and latest first, so earlier offsets stay valid and an outer wrap covers inner ones.
    for (const m of [...L.mounts].sort((a, b) => b.from - a.from || b.depth - a.depth)) {
      if (m.collapsed || !m.loaded || typeOf(m.child) === 'markdown') continue;
      if (wrapped.some((w) => w.from <= m.from && m.to <= w.to)) continue;
      text = text.slice(0, m.from) + wrapByType(text.slice(m.from, m.to), typeOf(m.child)) + text.slice(m.to);
      wrapped.push(m);
    }
    return wrapByType(text, typeOf(docId));
  }
  let frameKey = '';
  const renderPreview = () => {
    if (mode === 'edit') return;
    if (isHtml()) {
      // The page is served from what is saved; edits sync within milliseconds, so a reload after a pause shows them.
      const t = binding.current.text;
      const key = `${t.length}:${t.slice(0, 2000)}:${t.slice(-2000)}`;
      if (key !== frameKey) { frameKey = key; pageFrame.src = `/p/${docId}?v=${Date.now().toString(36)}`; }
      return;
    }
    const text = renderSource(binding.current);
    previewBody.replaceChildren(renderDocument(text));
    if (!text.length) previewBody.replaceChildren(h('p.preview-empty', null, 'This document is empty.'));
  };
  const schedulePreviewMd = debounce(renderPreview, 120);
  const schedulePreviewHtml = debounce(renderPreview, 900);
  const schedulePreview = () => (isHtml() ? schedulePreviewHtml() : schedulePreviewMd());
  // The live node info once the socket said hello; the fetched detail before that.
  const isHtml = () => (nodes.info.get(docId)?.type ?? detail.type ?? 'markdown') === 'html';
  /** Apply the document's type: language, inline previews, toolbar and preview surface. */
  function applyDocType() {
    typeApplied = true;
    const html = isHtml();
    app.classList.toggle('html-doc', html);
    view.dispatch({ effects: [langC.reconfigure(html ? htmlLanguage() : markdown({ base: markdownLanguage, codeLanguages, addKeymap: true })), liveC.reconfigure(html ? [] : livePreview)] });
    pageFrame.hidden = !html;
    previewCanvas.hidden = html;
    openPageLink.hidden = !html;
    frameKey = '';
    // An HTML page opens as the page; the source is a click away (Edit or Split). Readers always get the page.
    if (html && (!canWrite() || !modeChosen) && mode !== 'preview') { setMode('preview'); return; }
    if (mode !== 'edit') renderPreview();
  }

  /** The person chose a mode on this page (an HTML page otherwise opens as the page). */
  let modeChosen = false;
  function setMode(m: Mode, opts: { chosen?: boolean } = {}) {
    mode = m;
    if (opts.chosen) modeChosen = true;
    // An HTML page's default (preview) is not remembered as the person's mode for documents.
    if (opts.chosen || !isHtml()) saveMode(m);
    app.dataset.mode = m;
    for (const b of modeBtns) {
      const on = b.dataset.mode === m;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    if (m !== 'edit') renderPreview();
    computeLayout();
    if (m !== 'preview') requestAnimationFrame(() => view.requestMeasure());
  }

  function computeLayout() {
    const wide = body.clientWidth >= 1180 - (panel.kind ? 0 : 0);
    const margin = mode === 'edit' && wide && !listOpen && !panel.kind;
    rail.setLayout(margin ? 'margin' : 'drawer');
    if (margin) { if (rail.el.parentElement !== canvas) canvas.append(rail.el); }
    else if (rail.el.parentElement !== body) body.append(rail.el);
    if (!margin && rail.drawerOpen !== listOpen) rail.setDrawer(listOpen);
    app.classList.toggle('rail-margin', margin);
    app.classList.toggle('panel-open', !!panel.kind || (listOpen && !margin));
    commentsBtn.classList.toggle('on', listOpen);
    commentsBtn.setAttribute('aria-pressed', String(listOpen));
    rail.layoutSoon();
  }

  function toggleList(open = !listOpen) {
    listOpen = open;
    if (open) panel.close();
    computeLayout();
    rail.setDrawer(open);
  }

  const ro = new ResizeObserver(rafThrottle(() => computeLayout()));
  ro.observe(body);
  cleanups.push(() => ro.disconnect());
  setMode(mode);
  setNav(navOpen);
  // Everything the update listener touches exists now: start reconciling the view with the nodes.
  binding.attach(view);
  // For tests and debugging: the live editor objects of the open page.
  applyDocType();
  cleanups.push(nodes.onMeta((id) => { if (id === docId && app.classList.contains('html-doc') !== isHtml()) applyDocType(); }));
  (window as unknown as { __anima?: unknown }).__anima = { view, binding, nodes, nav: () => nav, docId };
  cleanups.push(() => { delete (window as unknown as { __anima?: unknown }).__anima; });

  // Split mode: keep the preview roughly in step with the source.
  let syncing = false;
  const syncScroll = (from: HTMLElement, to: HTMLElement) => () => {
    if (mode !== 'split' || syncing) return;
    syncing = true;
    const ratio = from.scrollTop / Math.max(1, from.scrollHeight - from.clientHeight);
    to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
    requestAnimationFrame(() => { syncing = false; });
  };
  editPane.addEventListener('scroll', syncScroll(editPane, previewPane), { passive: true });
  previewPane.addEventListener('scroll', syncScroll(previewPane, editPane), { passive: true });
  editPane.addEventListener('scroll', fabSoon, { passive: true });

  // ------------------------------------------------------------------ actions

  function moreItems(): MenuItem[] {
    const items: MenuItem[] = [
      { label: 'Version history', icon: 'history', onSelect: () => openPanel('versions') },
      { label: 'Activity', icon: 'activity', onSelect: () => openPanel('activity') },
    ];
    if (atLeast(role, 'commenter')) items.push({ label: 'Comment on whole document', icon: 'comment', onSelect: () => void rail.commentOnDocument() });
    if (atLeast(role, 'commenter') && !guest) items.push({ label: 'Ping an agent…', icon: 'bell', onSelect: () => pingAgent() });
    items.push('separator',
      { label: 'Download as Markdown (.md)', icon: 'download', onSelect: () => { const a = h('a', { href: api.exportUrl(docId), download: '' }); document.body.append(a); a.click(); a.remove(); } },
      // A guest's /d/ address opens only for them: there's nothing useful to copy.
      ...(guest ? [] : [{ label: 'Copy link', icon: 'link', onSelect: () => { void navigator.clipboard.writeText(`${location.origin}/d/${docId}`).then(() => toast('Link copied', { kind: 'success', timeout: 2000 }), () => toast(`${location.origin}/d/${docId}`)); } }]));
    if (!guest) items.push({ label: 'Attached files…', icon: 'file', onSelect: () => openFilesDialog(docId, canEdit(), isHtml()) });
    if (isHtml() && !guest) items.push({ label: 'Copy page link', icon: 'link', onSelect: () => { const url = `${location.origin}/p/${docId}`; void navigator.clipboard.writeText(url).then(() => toast('Page link copied', { kind: 'success', timeout: 2000 }), () => toast(url)); } });
    if (canEdit() && !guest && !detail.section) items.push({ label: 'Add to a space…', icon: 'columns', onSelect: () => void addToSpace() });
    if (canEdit()) items.push({ label: `Document type: ${labelOf(docId)?.type ?? 'markdown'}…`, icon: 'file', onSelect: () => typeMenu(docId, moreBtn) });
    if (nav.tree === docId && atLeast(role, 'owner')) items.push({ label: 'Stop being a space', icon: 'x', onSelect: () => void nav.dropTree() });
    if (atLeast(role, 'owner')) items.push('separator', { label: 'Delete document', icon: 'trash', danger: true, onSelect: () => void deleteDoc() });
    return items;
  }

  /** Ask an agent to look at this document (about the selection, if any). */
  function pingAgent(preselect?: string) {
    const sel = view.state.selection.main;
    const selection = sel.empty ? null : { text: view.state.sliceDoc(sel.from, sel.to), line: view.state.doc.lineAt(sel.from).number };
    openPingDialog({ docId, selection, preselect });
  }

  function openPanel(kind: 'versions' | 'activity') {
    listOpen = false;
    rail.setDrawer(false);
    panel.open(kind);
    computeLayout();
  }

  async function deleteDoc() {
    const ok = await confirmDialog({ title: 'Delete this document?', message: h('span', null, h('strong', null, `“${title}”`), ' will be deleted for everyone, including its comments and history. This can’t be undone.'), confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api.deleteDoc(docId);
      toast(`Deleted “${title}”`, { kind: 'success' });
      navigate('/');
    } catch (e) { toast(errorMessage(e), { kind: 'error' }); }
  }

  function linkDialog() {
    if (!canWrite()) return;
    const range = { ...view.state.selection.main };
    const sel = selectedText(view);
    const looksUrl = /^https?:\/\/\S+$/.test(sel);
    const textIn = h('input.input', { type: 'text', value: looksUrl ? '' : sel, placeholder: 'Text to display', 'aria-label': 'Text' });
    const urlIn = h('input.input', { type: 'url', value: looksUrl ? sel : '', placeholder: 'https://example.com', 'aria-label': 'Link', autofocus: true });
    const err = h('div.field-error', { role: 'alert' });
    const submit = () => {
      let url = urlIn.value.trim();
      if (!url) { err.textContent = 'Enter a link.'; urlIn.focus(); return; }
      if (!/^[a-z][\w+.-]*:/i.test(url) && !url.startsWith('/') && !url.startsWith('#')) url = `https://${url}`;
      if (/^(javascript|data|vbscript):/i.test(url)) { err.textContent = 'That kind of link isn’t allowed.'; return; }
      d.close();
      insertLink(view, textIn.value.trim(), url, { from: range.from, to: range.to });
    };
    for (const i of [textIn, urlIn]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    const d = openDialog({
      title: 'Insert link', size: 'sm',
      body: h('div.form-stack', null, h('label.field', null, h('span.field-label', null, 'Text'), textIn), h('label.field', null, h('span.field-label', null, 'Link'), urlIn), err),
      footer: [h('button.btn.ghost', { type: 'button', onclick: () => d.close() }, 'Cancel'), h('button.btn.primary', { type: 'button', onclick: submit }, 'Insert')],
      onClose: () => requestAnimationFrame(() => view.focus()),
    });
    urlIn.focus();
  }

  function needSignInForImages() {
    toast('Sign in to add images. Guests can write and comment, but not upload.', { kind: 'info', action: { label: 'Sign in', onClick: () => startSignIn() } });
  }

  async function uploadImages(files: File[], at: number) {
    if (!canEdit() || guest || suggesting()) return;
    // Track the insertion point through concurrent edits while uploading (in the node under it).
    let np = nodePos(binding.current, at);
    let np2 = np && nodes.get(np.node) ? np : null;
    let rel = np2 ? Y.createRelativePositionFromTypeIndex(nodes.get(np2.node)!.ytext, Math.min(np2.offset, nodes.get(np2.node)!.ytext.length), -1) : null;
    for (const f of files) {
      if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) { toast(`${f.name}: only PNG, JPEG, GIF and WebP images are supported.`, { kind: 'error' }); continue; }
      if (f.size > MAX_IMAGE) { toast(`${f.name} is larger than 15 MB.`, { kind: 'error' }); continue; }
      const close = toast(h('span.uploading', null, spinner(14), `Uploading ${f.name}…`), { timeout: 0 });
      try {
        const info = await api.upload(docId, f);
        const p = np2 ? nodes.get(np2.node) : null;
        const abs = rel && p ? Y.createAbsolutePositionFromRelativePosition(rel, p.doc) : null;
        const pos = Math.min((abs && np2 ? virtualPos(binding.current, np2.node, abs.index, 'end') : null) ?? view.state.selection.main.head, view.state.doc.length);
        const alt = (f.name.replace(/\.[a-z0-9]+$/i, '').replace(/[[\]\\]/g, ' ').trim() || 'image').slice(0, 80);
        const md = `![${alt}](${info.url})`;
        insertBlock(view, md, { at: pos });
        const after = view.state.selection.main.head;
        np = nodePos(binding.current, after);
        np2 = np && nodes.get(np.node) ? np : null;
        rel = np2 ? Y.createRelativePositionFromTypeIndex(nodes.get(np2.node)!.ytext, Math.min(np2.offset, nodes.get(np2.node)!.ytext.length), -1) : null;
      } catch (e) {
        if (e instanceof ApiError && e.status === 429) { toast(`${errorMessage(e)} Images can be added again tomorrow.`, { kind: 'error' }); close(); break; }
        toast(`${f.name}: ${errorMessage(e)}`, { kind: 'error' });
      } finally { close(); }
    }
  }

  // Refresh relative times in cards once a minute.
  const tick = window.setInterval(() => rail.render(), 60_000);
  cleanups.push(() => clearInterval(tick));
  void searchPeople('').catch(() => undefined);

  // Deep link: /d/<id>#comment-<threadId>
  const hashThread = /^#comment-(\w+)$/.exec(location.hash)?.[1];
  if (hashThread) provider.on('synced', () => setTimeout(() => rail.focusThread(hashThread), 50));

  // Leaving with suggestions still being saved: let the browser warn.
  const beforeUnload = (e: BeforeUnloadEvent) => { if (session?.unsaved) { void session.sync(); e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  cleanups.push(() => window.removeEventListener('beforeunload', beforeUnload));

  return () => {
    const s = session;
    for (const c of cleanups) c();
    binding.detach();
    nodes.destroy();
    rail.cancelDraft();
    panel.close();
    // Navigating away inside the app: finish saving suggestions before closing the connection.
    if (s?.unsaved) void s.sync().catch(() => false).finally(() => provider.destroy());
    else provider.destroy();
    document.title = 'Anima Docs';
  };
}

