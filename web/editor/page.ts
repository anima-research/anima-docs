// The document page: header, toolbar, live editor, comments, preview, panels.

import * as Y from 'yjs';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, drawSelection, dropCursor, highlightSpecialChars, keymap, placeholder, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';

import { api, ApiError, atLeast, isGuestMe, signalUnauthorized, ROLE_LABEL, ROLE_VERB, type DocDetail, type GeneralAccess, type Me, type Role } from '../lib/api';
import { debounce, h, modKey, altKey, rafThrottle, isMac } from '../lib/dom';
import { icon } from '../lib/icons';
import { splitLabel } from '../lib/format';
import { renderDocument } from '../lib/markdown';
import { searchPeople } from '../lib/people';
import { avatar, confirmDialog, emptyState, errorMessage, openDialog, openMenu, spinner, toast, type MenuItem } from '../lib/ui';
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

type Mode = 'edit' | 'split' | 'preview';
const MAX_IMAGE = 15 * 1024 * 1024;

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

function loadMode(): Mode {
  try { const m = localStorage.getItem('docs.mode'); if (m === 'edit' || m === 'split' || m === 'preview') return m; } catch { /* storage may be blocked */ }
  return 'edit';
}
function saveMode(m: Mode) { try { localStorage.setItem('docs.mode', m); } catch { /* ignore */ } }

interface BuildContext {
  /** The server refused local changes: rebuild from a fresh Y.Doc. */
  onResync: (message: string, scrollTop: number) => void;
  restoreScroll?: number;
}

export function mountDocPage(root: HTMLElement, me: Me, docId: string): () => void {
  let current: (() => void) | null = null;
  let destroyed = false;
  const resyncs: number[] = [];
  root.replaceChildren(h('div.doc-loading-page', null, spinner(28), h('p', null, 'Opening document…')));
  document.title = 'Archipelago Docs';

  const start = (restoreScroll?: number) => void api.doc(docId).then((detail) => {
    if (destroyed) return;
    current?.();
    current = build(root, me, detail, {
      restoreScroll,
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
  return () => { destroyed = true; current?.(); current = null; };
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
  const undoManager = new Y.UndoManager(provider.ytext);
  const canEdit = () => atLeast(role, 'editor');

  // ------------------------------------------------------------------ header

  const titleInput = h('input.doc-title', { type: 'text', value: title, 'aria-label': 'Document title', spellcheck: 'false', maxlength: '300' });
  let titleBefore = title;
  const commitTitle = async () => {
    const next = titleInput.value.trim();
    if (!next) { titleInput.value = titleBefore; return; }
    if (next === titleBefore) return;
    try {
      const d = await api.patchDoc(docId, { title: next });
      title = d.title;
      titleBefore = d.title;
      titleInput.value = d.title;
      document.title = `${title} · Archipelago Docs`;
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
  const rolePill = h('span.role-pill');
  const ownerEl = h('span.doc-owner');
  const presenceEl = h('div.presence', { 'aria-label': 'People in this document' });
  const commentsCount = h('span.count-badge', { hidden: true });
  const commentsBtn = h('button.btn.ghost.comments-btn', { type: 'button', 'aria-label': 'Show all comments', 'data-tip': 'All comments', onclick: () => toggleList() }, icon('comment', 18), h('span.btn-label', null, 'Comments'), commentsCount);
  const modeBtns = (['edit', 'split', 'preview'] as Mode[]).map((m) => h('button.seg-btn', {
    type: 'button', role: 'radio', 'data-mode': m, 'aria-label': m === 'edit' ? 'Edit mode' : m === 'split' ? 'Split view' : 'Preview mode',
    'data-tip': m === 'edit' ? 'Edit' : m === 'split' ? 'Split: source and preview' : 'Preview', onclick: () => setMode(m),
  }, icon(m === 'edit' ? 'pencil' : m === 'split' ? 'columns' : 'eye', 16), h('span.seg-label', null, m === 'edit' ? 'Edit' : m === 'split' ? 'Split' : 'Preview')));
  const modeSwitch = h('div.seg.mode-switch', { role: 'radiogroup', 'aria-label': 'View mode' }, modeBtns);
  const shareBtn = h('button.btn.primary.share-btn', { type: 'button', onclick: () => openShareDialog({ docId, me, title, onChanged: (d) => applyDetail(d) }) }, icon('lock', 16, 'share-lock'), h('span.btn-label', null, 'Share'));
  const shareSlot = guest ? guestSignInButton() : shareBtn;
  const moreBtn: HTMLButtonElement = h('button.icon-btn', { type: 'button', 'aria-label': 'More document actions', 'aria-haspopup': 'menu', 'data-tip': 'More', onclick: () => openMenu(moreBtn, moreItems(), { align: 'end' }) }, icon('more', 20));

  const header = h('header.doc-header', null,
    h('a.doc-home', { href: '/', 'data-link': '', 'aria-label': 'All documents', 'data-tip': 'All documents' }, icon('file', 22)),
    h('div.doc-titlebox', null, titleInput, h('div.doc-subline', null, rolePill, ownerEl, statusEl)),
    h('div.doc-header-right', null, presenceEl, commentsBtn, modeSwitch, shareSlot, moreBtn, userMenuButton(me, { compact: true })));

  // ------------------------------------------------------------------ toolbar

  const toolbar = h('div.doc-toolbar', { role: 'toolbar', 'aria-label': 'Formatting' });
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, hidden: true, 'aria-hidden': 'true', class: 'image-file-input' });
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
  const tb = (ic: string, label: string, shortcut: string | null, run: () => void, key?: string) => {
    const b = h('button.tb-btn', { type: 'button', 'aria-label': label, 'data-tip': shortcut ? `${label} (${shortcut})` : label, onmousedown: (e: MouseEvent) => e.preventDefault(), onclick: run }, icon(ic, 18));
    if (key) { b.setAttribute('aria-pressed', 'false'); pressable.set(key, b); }
    return b;
  };
  const sep = () => h('span.tb-sep', { role: 'separator' });
  const editTools = h('div.tb-group.edit-tools', null,
    tb('undo', 'Undo', `${modKey}Z`, () => { undoManager.undo(); view.focus(); }),
    tb('redo', 'Redo', isMac ? '⌘⇧Z' : 'Ctrl+Y', () => { undoManager.redo(); view.focus(); }),
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
    tb('image', guest ? 'Insert image (sign in to add images)' : 'Insert image', null, () => (guest ? needSignInForImages() : fileInput.click())),
    fileInput);
  const commentTool = h('button.tb-btn.tb-comment', { type: 'button', 'aria-label': 'Add comment', 'data-tip': `Add comment (${modKey}${altKey}M)`, onmousedown: (e: MouseEvent) => e.preventDefault(), onclick: () => rail.startDraft() }, icon('commentAdd', 18), h('span.tb-text', null, 'Comment'));
  const readNotice = h('div.tb-notice');
  toolbar.append(editTools, readNotice, h('span.tb-spacer'), commentTool);

  // ------------------------------------------------------------------ body

  const pageEl = h('div.page.editor-page');
  const pageWrap = h('div.page-wrap', null, pageEl);
  const canvas = h('div.doc-canvas', null, pageWrap);
  const editPane = h('div.doc-scroll.edit-pane', { tabindex: '-1' }, canvas);
  const previewBody = h('article.prose.preview-body');
  const previewPage = h('div.page.preview-page', null, previewBody);
  const previewPane = h('div.doc-scroll.preview-pane', { 'aria-label': 'Preview' }, h('div.doc-canvas', null, previewPage));
  const overlay = h('div.doc-overlay', { hidden: true });
  const syncVeil = h('div.sync-veil', null, spinner(24), h('span', null, 'Loading document…'));
  const body = h('div.doc-body', null, editPane, previewPane, overlay);
  const app = h('div.doc-app', null, h('div.doc-chrome', null, header, h('div.doc-toolbar-wrap', null, toolbar)), body);
  pageEl.append(syncVeil);
  root.replaceChildren(app);
  document.title = `${title} · Archipelago Docs`;

  // ------------------------------------------------------------------ editor

  const readOnlyC = new Compartment();
  const placeholderC = new Compartment();
  let view!: EditorView;

  const rail = new CommentsRail({ provider, view: () => view ?? null, me, role: () => role, docId });
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
      doc: provider.ytext.toString(),
      extensions: [
        readOnlyC.of(EditorState.readOnly.of(!canEdit())),
        placeholderC.of(canEdit() ? placeholder('Start writing…  Markdown works: # heading, **bold**, - list, | table |') : []),
        yCollab(provider.ytext, null, { undoManager }),
        remoteCursors(provider.ytext, provider.awareness),
        markdown({ base: markdownLanguage, codeLanguages, addKeymap: true }),
        syntaxHighlighting(docHighlight),
        livePreview,
        commentHighlights,
        EditorView.lineWrapping,
        drawSelection(),
        dropCursor(),
        highlightSpecialChars(),
        search({ top: true }),
        Prec.high(keymap.of([
          { key: 'Mod-Alt-m', run: () => { rail.startDraft(); return true; } },
          { key: 'Mod-k', run: () => { if (canEdit()) linkDialog(); return true; } },
          { key: 'Escape', run: () => { if (rail.active) { rail.setActive(null); return true; } return false; } },
          ...formatKeymap,
        ])),
        keymap.of([...yUndoManagerKeymap, ...defaultKeymap, ...searchKeymap, indentWithTab]),
        EditorView.contentAttributes.of({ 'aria-label': 'Document text', spellcheck: 'true', autocapitalize: 'sentences', 'aria-multiline': 'true' }),
        EditorView.domEventHandlers({
          paste: (e) => {
            const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
            if (!files.length || !canEdit()) return false;
            e.preventDefault();
            if (guest) { needSignInForImages(); return true; }
            void uploadImages(files, view.state.selection.main.head);
            return true;
          },
          drop: (e, v) => {
            const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
            if (!files.length) return false;
            e.preventDefault();
            if (!canEdit()) { toast('You need edit access to add images.', { kind: 'error' }); return true; }
            if (guest) { needSignInForImages(); return true; }
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head;
            void uploadImages(files, pos);
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

  // ------------------------------------------------------------------ toolbar state

  const updateToolbarState = rafThrottle(() => {
    if (!canEdit()) return;
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
    view.dispatch({ effects: [readOnlyC.reconfigure(EditorState.readOnly.of(!canEdit())), placeholderC.reconfigure(canEdit() ? placeholder('Start writing…') : [])] });
    titleInput.readOnly = !canEdit();
    titleInput.title = canEdit() ? 'Rename' : '';
    rolePill.textContent = canEdit() ? (role === 'owner' ? 'Owner' : 'Editing') : role === 'commenter' ? 'Commenting' : 'Viewing';
    rolePill.className = `role-pill role-${role}`;
    rolePill.setAttribute('data-tip', canEdit() ? `You can edit (${ROLE_LABEL[role]})` : role === 'commenter' ? 'You can read and comment' : 'You can read this document');
    app.classList.toggle('can-edit', canEdit());
    app.classList.toggle('can-comment', atLeast(role, 'commenter'));
    editTools.hidden = !canEdit();
    commentTool.hidden = !atLeast(role, 'commenter');
    readNotice.hidden = canEdit();
    readNotice.replaceChildren(icon(role === 'commenter' ? 'comment' : 'eye', 16), role === 'commenter' ? 'You can comment on this document. Select text, then add a comment.' : 'View only. Ask the owner for access to comment or edit.');
    toolbar.classList.toggle('reader', !canEdit());
    rail.refreshPermissions();
    if (announce && prev !== next) {
      toast(h('span', null, 'Your access changed to ', h('strong', null, ROLE_LABEL[next].toLowerCase()), '.'), { kind: atLeast(next, prev) ? 'success' : 'info' });
    }
  }

  function applyDetail(d: { title?: string; owner?: { sub: string; label: string }; generalAccess?: string; publicLink?: boolean; updatedAt?: number }) {
    if (d.title && d.title !== title) {
      title = d.title;
      if (document.activeElement !== titleInput) { titleInput.value = title; titleBefore = title; }
      document.title = `${title} · Archipelago Docs`;
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
  provider.on('hello', ({ role: r, doc }) => { if (r !== role) applyRole(r, true); if (doc) applyDetail(doc); });
  provider.on('synced', () => {
    renderStatus();
    syncVeil.remove();
    rail.setSynced();
    schedulePreview();
    if (ctx.restoreScroll) requestAnimationFrame(() => { editPane.scrollTop = ctx.restoreScroll!; });
    if (canEdit() && provider.ytext.length === 0) view.focus();
  });
  provider.on('threads', (threads, ev) => rail.setThreads(threads, ev));
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
      if (abs) { if (mode === 'preview') setMode('edit'); view.dispatch({ effects: EditorView.scrollIntoView(Math.min(abs.index, view.state.doc.length), { y: 'center' }) }); }
    } catch { /* stale cursor */ }
  };
  provider.awareness.on('change', renderPresence);
  cleanups.push(() => provider.awareness.off('change', renderPresence));
  renderPresence();

  // ------------------------------------------------------------------ modes & layout

  const renderPreview = () => {
    if (mode === 'edit') return;
    previewBody.replaceChildren(renderDocument(provider.ytext.toString()));
    if (!provider.ytext.length) previewBody.replaceChildren(h('p.preview-empty', null, 'This document is empty.'));
  };
  const schedulePreview = debounce(renderPreview, 120);

  function setMode(m: Mode) {
    mode = m;
    saveMode(m);
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
    items.push('separator',
      { label: 'Download as Markdown (.md)', icon: 'download', onSelect: () => { const a = h('a', { href: api.exportUrl(docId), download: '' }); document.body.append(a); a.click(); a.remove(); } },
      // A guest's /d/ address opens only for them: there's nothing useful to copy.
      ...(guest ? [] : [{ label: 'Copy link', icon: 'link', onSelect: () => { void navigator.clipboard.writeText(`${location.origin}/d/${docId}`).then(() => toast('Link copied', { kind: 'success', timeout: 2000 }), () => toast(`${location.origin}/d/${docId}`)); } }]));
    if (atLeast(role, 'owner')) items.push('separator', { label: 'Delete document', icon: 'trash', danger: true, onSelect: () => void deleteDoc() });
    return items;
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
    if (!canEdit()) return;
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
    if (!canEdit() || guest) return;
    // Track the insertion point through concurrent edits while uploading.
    let rel = Y.createRelativePositionFromTypeIndex(provider.ytext, Math.min(at, provider.ytext.length), -1);
    for (const f of files) {
      if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) { toast(`${f.name}: only PNG, JPEG, GIF and WebP images are supported.`, { kind: 'error' }); continue; }
      if (f.size > MAX_IMAGE) { toast(`${f.name} is larger than 15 MB.`, { kind: 'error' }); continue; }
      const close = toast(h('span.uploading', null, spinner(14), `Uploading ${f.name}…`), { timeout: 0 });
      try {
        const info = await api.upload(docId, f);
        const abs = Y.createAbsolutePositionFromRelativePosition(rel, provider.doc);
        const pos = Math.min(abs?.index ?? view.state.selection.main.head, view.state.doc.length);
        const alt = (f.name.replace(/\.[a-z0-9]+$/i, '').replace(/[[\]\\]/g, ' ').trim() || 'image').slice(0, 80);
        const md = `![${alt}](${info.url})`;
        insertBlock(view, md, { at: pos });
        const after = view.state.selection.main.head;
        rel = Y.createRelativePositionFromTypeIndex(provider.ytext, Math.min(after, provider.ytext.length), -1);
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

  return () => {
    for (const c of cleanups) c();
    rail.cancelDraft();
    panel.close();
    provider.destroy();
    document.title = 'Archipelago Docs';
  };
}

