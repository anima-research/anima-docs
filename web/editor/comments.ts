// Google-Docs-style comments: a margin of thread cards aligned to their anchors
// (or a drawer on narrow screens / other modes), highlights in the editor, a
// floating "add comment" button, replies, resolve, edit/delete, assign.
// Suggestions are threads too: their cards show the change with Accept and
// Reject, and the change itself is drawn in the editor (see suggest.ts).

import * as Y from 'yjs';
import { EditorView } from '@codemirror/view';
import { atLeast, isGuestMe, type Me, type Person, type Role, type Thread, type ThreadComment } from '../lib/api';
import { autosize, h, modKey, altKey, rafThrottle } from '../lib/dom';
import { icon } from '../lib/icons';
import { fullTime, relTime } from '../lib/format';
import { excerpt, renderComment } from '../lib/markdown';
import { attachMentions, personBySub, remember } from '../lib/people';
import { peoplePicker } from '../lib/picker';
import { avatar, confirmDialog, emptyState, errorMessage, kindBadge, openDialog, openMenu, shownName, toast, type MenuItem } from '../lib/ui';
import { setHighlights, type Anchored } from './highlights';
import type { DocProvider, ThreadEvent } from './provider';
import { resolveRel, setOverlays, sharedCoords, wordDiff, type Coords, type OverlayItem, type SuggestSession } from './suggest';

const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytesToB64 = (b: Uint8Array) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); };

type Range = { from: number; to: number };
type Filter = 'open' | 'resolved' | 'all';

interface Card {
  el: HTMLElement;
  body: HTMLElement;
  reply: HTMLElement | null;
  replyInput: HTMLTextAreaElement | null;
  editing: Map<string, HTMLTextAreaElement>;
  /** Editing a suggestion's text from its card. */
  revising: HTMLTextAreaElement | null;
  sig: string;
}

export class CommentsRail {
  readonly el: HTMLElement;
  readonly fab: HTMLButtonElement;
  private cardsEl: HTMLElement;
  private headEl: HTMLElement;
  private emptyEl: HTMLElement;
  threads: Thread[] = [];
  private anchors = new Map<string, Range | null>();
  active: string | null = null;
  private draft: { range: Range; anchor: { start: string; end: string }; quote: string; card: HTMLElement; input: HTMLTextAreaElement } | null = null;
  private cards = new Map<string, Card>();
  layout: 'margin' | 'drawer' = 'margin';
  drawerOpen = false;
  private filter: Filter = 'open';
  private hlSig = '';
  private synced = false;
  private seenEvents = new Set<string>();
  onCountChange: (open: number) => void = () => {};
  /** Open suggestions changed (count). */
  onSuggestionsChange: (open: number) => void = () => {};
  onDrawerChange: (open: boolean) => void = () => {};

  constructor(private deps: {
    provider: DocProvider; view: () => EditorView | null; me: Me; role: () => Role | null; docId: string;
    /** Shared-text ↔ editor positions (they differ while suggesting). */
    coords?: () => Coords;
    /** The suggesting session, while you're suggesting. */
    session?: () => SuggestSession | null;
  }) {
    this.headEl = h('div.rail-head');
    this.cardsEl = h('div.rail-cards');
    this.emptyEl = emptyState({
      art: icon('comment', 36, 'empty-art-icon'),
      title: 'No comments yet',
      text: `Select text and press the comment button (${modKey}${altKey}M) to start a discussion. Mention people or agents with @.`,
    });
    this.emptyEl.classList.add('rail-empty');
    this.el = h('aside.comment-rail.margin', { 'aria-label': 'Comments' }, this.headEl, this.cardsEl, this.emptyEl);
    this.fab = h('button.comment-fab', { type: 'button', 'aria-label': 'Add comment', 'data-tip': `Add comment (${modKey}${altKey}M)`, hidden: true, onmousedown: (e: MouseEvent) => e.preventDefault(), onclick: () => this.startDraft() }, icon('commentAdd', 18));
    this.renderHead();
  }

  get canComment() { return atLeast(this.deps.role(), 'commenter'); }
  get canDecide() { return atLeast(this.deps.role(), 'editor'); }
  get openCount() { return this.threads.filter((t) => !t.resolved).length; }
  private get coords(): Coords { return this.deps.coords?.() ?? sharedCoords; }
  openSuggestions() { return this.threads.filter((t) => t.suggestion?.status === 'open'); }

  // ------------------------------------------------------------------ data

  setSynced() {
    this.synced = true;
    this.resolveAnchors(true);
    this.render();
  }

  setThreads(threads: Thread[], event?: ThreadEvent) {
    this.threads = threads;
    for (const t of threads) for (const c of t.comments) remember([{ ...c.author, issuer: '', role: 'member', lastSeen: 0 } as Person].filter((p) => !personBySub(p.sub)));
    if (this.active && !threads.some((t) => t.id === this.active)) this.active = null;
    this.resolveAnchors(true);
    this.renderHead();
    this.render();
    this.onCountChange(this.openCount);
    this.onSuggestionsChange(this.openSuggestions().length);
    if (event) this.notify(event);
  }

  /** Jump to the next open suggestion after the active one (in document order). */
  nextSuggestion() {
    const list = this.openSuggestions()
      .map((t) => ({ t, at: this.anchors.get(t.id)?.from ?? Infinity }))
      .sort((a, b) => a.at - b.at);
    if (!list.length) return;
    const i = list.findIndex((x) => x.t.id === this.active);
    this.focusThread(list[(i + 1) % list.length].t.id);
  }

  /** Decisions on your suggestions, gathered briefly so "Accept all" makes one toast. */
  private decided: { by: string; name: string; accepted: number; rejected: number; last: string } | null = null;
  private decidedTimer = 0;
  private noteDecision(ev: ThreadEvent, name: string) {
    const d = this.decided && this.decided.by === ev.actor ? this.decided : (this.flushDecisions(), this.decided = { by: ev.actor, name, accepted: 0, rejected: 0, last: ev.threadId });
    if (ev.kind === 'accepted') d.accepted++; else d.rejected++;
    d.last = ev.threadId;
    clearTimeout(this.decidedTimer);
    this.decidedTimer = window.setTimeout(() => this.flushDecisions(), 700);
  }
  private flushDecisions() {
    clearTimeout(this.decidedTimer);
    const d = this.decided;
    this.decided = null;
    if (!d) return;
    const n = d.accepted + d.rejected;
    const what = n === 1 ? 'your suggestion' : `${n} of your suggestions`;
    const verb = d.rejected === 0 ? 'accepted' : d.accepted === 0 ? 'rejected' : `decided on (${d.accepted} accepted, ${d.rejected} rejected)`;
    toast(h('span', null, h('strong', null, d.name), ` ${verb} ${what}`), { kind: d.rejected === 0 ? 'success' : 'info', action: { label: 'View', onClick: () => this.focusThread(d.last) }, timeout: 8000 });
  }

  private notify(ev: ThreadEvent) {
    const key = `${ev.kind}:${ev.commentId}`;
    if (ev.actor === this.deps.me.sub || this.seenEvents.has(key)) return;
    this.seenEvents.add(key);
    const t = this.threads.find((x) => x.id === ev.threadId);
    if (!t) return;
    const c = t.comments.find((x) => x.id === ev.commentId) ?? t.comments[0];
    const who = c?.author.sub === ev.actor ? c.author : (t.comments.find((x) => x.author.sub === ev.actor)?.author ?? personBySub(ev.actor));
    const name = who?.name ?? 'Someone';
    const agent = who?.kind === 'agent' ? ' ✦' : '';
    const view = { label: 'View', onClick: () => this.focusThread(t.id) };
    if ((ev.kind === 'accepted' || ev.kind === 'rejected') && t.comments[0]?.author.sub === this.deps.me.sub) {
      this.noteDecision(ev, `${name}${agent}`);
      return;
    }
    if (t.suggestion && (ev.kind === 'edited' || ev.kind === 'accepted' || ev.kind === 'rejected')) return;
    if ((ev.kind === 'created' || ev.kind === 'replied' || ev.kind === 'edited') && c?.mentions.includes(this.deps.me.sub)) {
      toast(h('span', null, h('strong', null, `${name}${agent}`), ' mentioned you: ', h('span.toast-quote', null, `“${excerpt(c.body, 90)}”`)), { kind: 'mention', action: view, timeout: 12000 });
    } else if (ev.kind === 'assigned' && t.assignee?.sub === this.deps.me.sub) {
      toast(h('span', null, h('strong', null, `${name}${agent}`), ' assigned a comment to you'), { kind: 'mention', action: view, timeout: 12000 });
    } else if (ev.kind === 'created' || ev.kind === 'replied') {
      const card = this.cards.get(t.id);
      card?.el.classList.add('flash');
      setTimeout(() => card?.el.classList.remove('flash'), 1600);
    }
  }

  /** Re-resolve every anchor against the local replica (in editor positions) and refresh highlights. */
  resolveAnchors(force = false) {
    const p = this.deps.provider;
    const c = this.coords;
    const session = this.deps.session?.() ?? null;
    for (const t of this.threads) {
      if (!t.rel || !this.synced) { this.anchors.set(t.id, null); continue; }
      // Your suggestions being edited in place sit where the session drew them.
      const own = session?.viewRange(t.id);
      if (own) { this.anchors.set(t.id, own); continue; }
      const at = resolveRel(t.rel, p.doc, p.ytext);
      if (!at) { this.anchors.set(t.id, null); continue; }
      if (at.point) { const v = c.toView(at.from, -1); this.anchors.set(t.id, { from: v, to: v }); continue; }
      const from = c.toView(at.from, 1), to = Math.max(from, c.toView(at.to, -1));
      if (to > from) this.anchors.set(t.id, { from, to });
      // Hidden by your own pending deletion: still there in the shared text.
      else if (c.suggesting && at.to > at.from) this.anchors.set(t.id, { from, to: from });
      else this.anchors.set(t.id, null);
    }
    this.pushHighlights(force);
  }

  private isOrphan(t: Thread) {
    return !!t.rel && this.synced && !this.anchors.get(t.id);
  }

  /** Highlights are dispatched outside the editor's update cycle (never from a listener). */
  private hlForce = false;
  private hlTimer = 0;
  private pushHighlights(force = false) {
    this.hlForce ||= force;
    if (this.hlTimer) return;
    this.hlTimer = window.setTimeout(() => {
      this.hlTimer = 0;
      const f = this.hlForce;
      this.hlForce = false;
      this.flushHighlights(f);
    }, 0);
  }

  private flushHighlights(force: boolean) {
    const view = this.deps.view();
    if (!view) return;
    const ranges: Anchored[] = [];
    const overlays: OverlayItem[] = [];
    const editing = this.deps.session?.()?.ids ?? new Set<string>();
    for (const t of this.threads) {
      if (t.resolved) continue;
      const r = this.anchors.get(t.id);
      if (!r) continue;
      if (t.suggestion) {
        if (t.suggestion.status !== 'open' || editing.has(t.id)) continue;
        overlays.push({ id: t.id, from: r.from, to: r.to, original: t.suggestion.original, text: t.suggestion.text, outdated: t.suggestion.outdated, active: this.active === t.id });
      } else if (r.to > r.from) ranges.push({ id: t.id, from: r.from, to: r.to });
    }
    const draft = this.draft?.range ?? null;
    const sig = JSON.stringify([ranges, overlays, this.active, draft]);
    if (!force && sig === this.hlSig) return;
    this.hlSig = sig;
    view.dispatch({ effects: [setHighlights.of({ ranges, active: this.active, draft }), setOverlays.of(overlays)] });
  }

  /** Doc changed: anchors move (throttled to a frame). */
  readonly onDocChanged = rafThrottle(() => {
    if (this.draft) {
      // Keep the draft's range on the text it was made for.
      const p = this.deps.provider;
      const s = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(b64ToBytes(this.draft.anchor.start)), p.doc);
      const e = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(b64ToBytes(this.draft.anchor.end)), p.doc);
      const c = this.coords;
      if (s && e) { const from = c.toView(s.index, 1); this.draft.range = { from, to: Math.max(from, c.toView(e.index, -1)) }; }
    }
    this.resolveAnchors();
    this.layoutSoon();
  });

  // ------------------------------------------------------------------ selection & activation

  threadAt(pos: number): string | null {
    let best: { id: string; len: number } | null = null;
    for (const t of this.threads) {
      if (t.resolved) continue;
      const r = this.anchors.get(t.id);
      if (r && r.from <= pos && pos <= r.to && (!best || r.to - r.from < best.len)) best = { id: t.id, len: r.to - r.from };
    }
    return best?.id ?? null;
  }

  setActive(id: string | null, opts: { scroll?: boolean; focusReply?: boolean } = {}) {
    if (id === this.active && !opts.scroll && !opts.focusReply) return;
    this.active = id;
    for (const [tid, card] of this.cards) card.el.classList.toggle('active', tid === id);
    this.render();
    this.pushHighlights();
    if (id && opts.scroll) {
      const r = this.anchors.get(id);
      const view = this.deps.view();
      if (r && view) view.dispatch({ effects: EditorView.scrollIntoView(r.from, { y: 'center' }) });
      requestAnimationFrame(() => this.cards.get(id)?.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    }
    if (id && opts.focusReply) requestAnimationFrame(() => this.cards.get(id)?.replyInput?.focus({ preventScroll: true }));
  }

  /** From a toast or a link: reveal a thread wherever it is. */
  focusThread(id: string) {
    const t = this.threads.find((x) => x.id === id);
    if (!t) return;
    if (t.resolved && this.filter === 'open') this.filter = 'all';
    if (this.layout === 'drawer' && !this.drawerOpen) this.setDrawer(true);
    this.setActive(id, { scroll: true });
  }

  /** Editor selection changed (from the page's update listener). */
  onSelection(view: EditorView, userInitiated: boolean) {
    const sel = view.state.selection.main;
    this.updateFab(view);
    if (!userInitiated) return;
    if (sel.empty) {
      const id = this.threadAt(sel.head);
      if (id !== this.active && (id || !this.draft)) this.setActive(id);
    }
  }

  updateFab(view: EditorView) {
    const sel = view.state.selection.main;
    const show = this.canComment && !sel.empty && !this.draft && this.synced && view.hasFocus;
    if (!show) { this.fab.hidden = true; return; }
    const wrap = this.fab.parentElement;
    if (!wrap) return;
    const block = view.lineBlockAt(sel.head);
    const y = view.documentTop + block.top - wrap.getBoundingClientRect().top;
    this.fab.style.top = `${Math.max(0, y + Math.min(block.height, 40) / 2 - 18)}px`;
    this.fab.hidden = false;
  }

  // ------------------------------------------------------------------ drafts

  startDraft() {
    const view = this.deps.view();
    if (!view || !this.canComment) return;
    const sel = view.state.selection.main;
    if (sel.empty) {
      toast('Select some text to comment on.', { kind: 'info' });
      return;
    }
    const ytext = this.deps.provider.ytext;
    const c = this.coords;
    const sFrom = c.toShared(sel.from, 1), sTo = c.toShared(sel.to, -1);
    if (sTo <= sFrom) {
      toast('That text is only in your suggestion so far. Comment on text that’s in the document, or add a note to the suggestion’s card.', { kind: 'info' });
      return;
    }
    if (this.layout === 'drawer' && !this.drawerOpen) this.setDrawer(true);
    const anchor = {
      start: bytesToB64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, sFrom, 0))),
      end: bytesToB64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, sTo, -1))),
    };
    const quote = view.state.sliceDoc(sel.from, sel.to);
    this.cancelDraft();
    const input = h('textarea.comment-input', { rows: 2, placeholder: 'Add a comment… Use @ to mention people or agents', 'aria-label': 'New comment' });
    const submit = h('button.btn.primary.sm', { type: 'button', disabled: true, onclick: () => void this.submitDraft() }, 'Comment');
    attachMentions(input, { excludeSub: this.deps.me.sub });
    input.addEventListener('input', () => { submit.disabled = !input.value.trim(); this.layoutSoon(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void this.submitDraft(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.cancelDraft(true); }
    });
    autosize(input, 240);
    const card = h('div.thread-card.draft.active', { dataset: { id: '__draft' } },
      h('div.comment-head', null, avatar(this.deps.me, 30), h('div.comment-meta', null, h('div.comment-author', null, h('span.ca-name', null, shownName(this.deps.me)), isGuestMe(this.deps.me) ? kindBadge('guest') : null))),
      this.layout === 'drawer' ? h('blockquote.card-quote', null, quote) : null,
      input,
      h('div.card-actions', null, h('span.kbd-hint', null, `${modKey}Enter to send`), h('button.btn.ghost.sm', { type: 'button', onclick: () => this.cancelDraft(true) }, 'Cancel'), submit));
    this.draft = { range: { from: sel.from, to: sel.to }, anchor, quote, card, input };
    this.fab.hidden = true;
    this.active = null;
    this.render();
    this.pushHighlights();
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  }

  cancelDraft(refocus = false) {
    if (!this.draft) return;
    this.draft.card.remove();
    this.draft = null;
    this.render();
    this.pushHighlights();
    if (refocus) this.deps.view()?.focus();
  }

  private async submitDraft() {
    const d = this.draft;
    if (!d) return;
    const body = d.input.value.trim();
    if (!body) return;
    d.card.classList.add('busy');
    try {
      const res = await this.deps.provider.request<{ id: string; warnings?: string[] }>({ type: 'comment.create', body, anchor: d.anchor });
      for (const w of res.warnings ?? []) toast(w, { kind: 'info', timeout: 9000 });
      this.draft = null;
      d.card.remove();
      this.active = res.id;
      this.render();
      this.pushHighlights();
    } catch (e) {
      d.card.classList.remove('busy');
      toast(errorMessage(e), { kind: 'error' });
    }
  }

  /** A comment on the whole document (no anchor). */
  async commentOnDocument() {
    const body = await composeDialog({ title: 'Comment on the whole document', me: this.deps.me, confirm: 'Comment' });
    if (!body) return;
    try {
      const res = await this.deps.provider.request<{ id: string; warnings?: string[] }>({ type: 'comment.create', body, anchor: null });
      for (const w of res.warnings ?? []) toast(w, { kind: 'info', timeout: 9000 });
      this.focusThread(res.id);
    } catch (e) { toast(errorMessage(e), { kind: 'error' }); }
  }

  // ------------------------------------------------------------------ layout mode

  setLayout(layout: 'margin' | 'drawer') {
    if (this.layout === layout) return;
    this.layout = layout;
    if (layout === 'margin' && this.drawerOpen) this.drawerOpen = false;
    this.el.classList.toggle('drawer', layout === 'drawer');
    this.el.classList.toggle('margin', layout === 'margin');
    this.applyDrawer();
    this.renderHead();
    for (const c of this.cards.values()) c.sig = '';
    this.render();
  }

  setDrawer(open: boolean) {
    this.drawerOpen = open;
    this.applyDrawer();
    this.renderHead();
    this.render();
    this.onDrawerChange(open);
  }

  private applyDrawer() {
    this.el.classList.toggle('open', this.layout === 'drawer' && this.drawerOpen);
    this.el.setAttribute('aria-hidden', String(this.layout === 'drawer' && !this.drawerOpen));
  }

  private renderHead() {
    const tabs: [Filter, string][] = [['open', 'Open'], ['resolved', 'Resolved'], ['all', 'All']];
    const pending = this.openSuggestions();
    const review = this.canDecide && pending.length > 1
      ? h('div.rail-review', null,
        h('span.rail-review-label', null, icon('pencil', 14), `${pending.length} suggestions`),
        h('button.link-btn', { type: 'button', onclick: () => void this.decideAll('accept') }, 'Accept all'),
        h('button.link-btn.danger', { type: 'button', onclick: () => void this.decideAll('reject') }, 'Reject all'))
      : null;
    this.headEl.replaceChildren(
      h('div.rail-title', null, h('h2', null, 'Comments'), h('button.icon-btn.sm.rail-close', { type: 'button', 'aria-label': 'Close comments', onclick: () => this.setDrawer(false) }, icon('x', 18))),
      h('div.seg.rail-filter', { role: 'tablist', 'aria-label': 'Show comments' }, tabs.map(([f, label]) => h('button.seg-btn', {
        type: 'button', role: 'tab', 'aria-selected': String(this.filter === f), class: this.filter === f ? 'on' : '',
        onclick: () => { this.filter = f; this.renderHead(); this.render(); },
      }, label))),
      ...(review ? [review] : []),
      ...(this.canComment ? [h('button.btn.ghost.sm.rail-doc-comment', { type: 'button', onclick: () => void this.commentOnDocument() }, icon('plus', 16), 'Comment on document')] : []));
    this.headEl.classList.toggle('has-review', !!review);
  }

  async decideAll(decision: 'accept' | 'reject') {
    const open = this.openSuggestions();
    const ids = (decision === 'accept' ? open.filter((t) => !t.suggestion!.outdated) : open).map((t) => t.id);
    const outdated = open.length - ids.length;
    if (!ids.length) { toast('Every open suggestion is outdated; they can only be rejected.', { kind: 'info' }); return; }
    const ok = await confirmDialog({
      title: decision === 'accept' ? `Accept ${ids.length} suggestion${ids.length === 1 ? '' : 's'}?` : `Reject ${ids.length} suggestion${ids.length === 1 ? '' : 's'}?`,
      message: decision === 'accept'
        ? `Each change will be applied to the document as your edit${outdated ? `. ${outdated} outdated suggestion${outdated === 1 ? '' : 's'} will be left for you to review` : ''}.`
        : 'The text stays as it is; the authors are told.',
      confirmLabel: decision === 'accept' ? 'Accept all' : 'Reject all', danger: decision === 'reject',
    });
    if (!ok) return;
    try {
      const r = await this.deps.provider.request<{ results: { id: string; ok: boolean; error?: string }[] }>({ type: 'suggestion.decideMany', ids, decision }, 30_000);
      const done = r.results.filter((x) => x.ok).length, failed = r.results.length - done;
      toast(`${decision === 'accept' ? 'Accepted' : 'Rejected'} ${done}${failed ? `; ${failed} couldn’t be (they changed meanwhile)` : ''}.`, { kind: failed ? 'info' : 'success' });
    } catch (e) { toast(errorMessage(e), { kind: 'error' }); }
  }

  // ------------------------------------------------------------------ rendering

  private visibleThreads(): Thread[] {
    let list = this.threads;
    if (this.layout === 'margin') list = list.filter((t) => !t.resolved);
    else if (this.filter === 'open') list = list.filter((t) => !t.resolved);
    else if (this.filter === 'resolved') list = list.filter((t) => t.resolved);
    const pos = (t: Thread) => this.anchors.get(t.id)?.from ?? -1;
    return [...list].sort((a, b) => {
      const pa = pos(a), pb = pos(b);
      if (a.resolved !== b.resolved && this.layout === 'drawer') return a.resolved ? 1 : -1;
      if (pa !== pb) return pa - pb;
      return a.comments[0].createdAt - b.comments[0].createdAt;
    });
  }

  /** Role changed: permissions in cards and header. */
  refreshPermissions() {
    for (const c of this.cards.values()) c.sig = '';
    this.renderHead();
    this.render();
  }

  render() {
    const visible = this.synced ? this.visibleThreads() : [];
    const keep = new Set(visible.map((t) => t.id));
    for (const [id, card] of this.cards) if (!keep.has(id)) { card.el.remove(); this.cards.delete(id); }
    const ordered: HTMLElement[] = [];
    if (this.draft) ordered.push(this.draft.card);
    for (const t of visible) {
      let card = this.cards.get(t.id);
      if (!card) { card = this.createCard(t); this.cards.set(t.id, card); }
      this.updateCard(card, t);
      ordered.push(card.el);
    }
    // Keep DOM order = reading order (focus order), without detaching focused nodes needlessly.
    let prev: Element | null = null;
    for (const el of ordered) {
      const expected: Element | null = prev ? prev.nextElementSibling : this.cardsEl.firstElementChild;
      if (expected !== el) {
        if (prev) prev.after(el); else this.cardsEl.prepend(el);
      }
      prev = el;
    }
    this.emptyEl.hidden = !(this.layout === 'drawer' && this.synced && !visible.length && !this.draft);
    if (this.layout === 'drawer' && this.filter !== 'open' && !visible.length) {
      this.emptyEl.querySelector('.empty-title')!.textContent = this.filter === 'resolved' ? 'No resolved comments' : 'No comments yet';
    } else this.emptyEl.querySelector('.empty-title')!.textContent = 'No comments yet';
    this.el.classList.toggle('has-cards', ordered.length > 0);
    this.layoutSoon();
  }

  private createCard(t: Thread): Card {
    const body = h('div.card-comments');
    const el = h('div.thread-card', {
      dataset: { id: t.id }, tabindex: '-1',
      onmousedown: (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest('button, textarea, input, a, .menu')) return;
        if (this.active !== t.id) this.setActive(t.id, { scroll: this.layout === 'drawer' });
      },
    }, body);
    return { el, body, reply: null, replyInput: null, editing: new Map(), revising: null, sig: '' };
  }

  private mentionCtx(t: Thread) {
    const names: { name: string; me?: boolean }[] = [];
    const subs = new Set(t.comments.flatMap((c) => c.mentions));
    for (const s of subs) {
      const p = personBySub(s) ?? t.comments.find((c) => c.author.sub === s)?.author;
      if (p) names.push({ name: p.name, me: s === this.deps.me.sub });
    }
    if (!subs.has(this.deps.me.sub)) names.push({ name: this.deps.me.name, me: true });
    return { names, nameOf: (sub: string) => personBySub(sub)?.name };
  }

  private updateCard(card: Card, t: Thread) {
    const active = this.active === t.id;
    const orphan = this.isOrphan(t);
    const inSession = !!this.deps.session?.()?.ids.has(t.id);
    const sig = JSON.stringify([t, active, orphan, this.layout, [...card.editing.keys()], !!card.revising, inSession, this.deps.role(), Math.floor(Date.now() / 60_000)]);
    card.el.classList.toggle('active', active);
    card.el.classList.toggle('resolved', t.resolved);
    card.el.classList.toggle('orphaned', orphan && !t.suggestion);
    card.el.classList.toggle('unanchored', !t.rel);
    card.el.classList.toggle('suggestion', !!t.suggestion);
    if (sig === card.sig) return;
    card.sig = sig;
    const ctx = this.mentionCtx(t);
    const parts: (HTMLElement | null)[] = [];
    if (t.suggestion) {
      this.suggestionParts(card, t, parts, inSession, ctx);
    } else if (t.resolved) {
      parts.push(h('div.card-banner.resolved', null, icon('checkCircle', 14), `Resolved${t.resolvedBy ? ` by ${t.resolvedBy.name}` : ''}`,
        this.canComment ? h('button.link-btn', { type: 'button', onclick: () => void this.op({ type: 'comment.resolve', comment: t.id, resolved: false }) }, 'Reopen') : null));
    }
    if (t.suggestion) { /* rendered above */ }
    else if (!t.rel) parts.push(h('div.card-banner', null, icon('file', 14), 'On the whole document'));
    else if (orphan) parts.push(h('div.card-quote-wrap', null, h('div.card-banner.warn', null, icon('alert', 14), 'The text this was on was deleted'), t.quote ? h('blockquote.card-quote.struck', null, t.quote) : null));
    else if (this.layout === 'drawer' && t.quote) parts.push(h('blockquote.card-quote', null, t.quote));
    if (t.assignee) {
      const mine = t.assignee.sub === this.deps.me.sub;
      parts.push(h('div.assignee-chip', { class: mine ? 'me' : '' }, icon('userCheck', 14), mine ? 'Assigned to you' : 'Assigned to ', mine ? null : h('strong', null, shownName(t.assignee)), mine ? null : kindBadge(t.assignee.kind)));
    }
    const comments = t.comments;
    const collapse = !active && comments.length > 3;
    comments.forEach((c, i) => {
      if (t.suggestion && i === 0) return; // the suggestion's header and note are rendered above
      if (collapse && i > 0 && i < comments.length - 1) {
        if (i === 1) parts.push(h('button.more-replies', { type: 'button', onclick: () => this.setActive(t.id) }, `${comments.length - 2} more replies`));
        return;
      }
      parts.push(this.renderComment(card, t, c, i === 0, ctx));
    });
    card.body.replaceChildren(...parts.filter(Boolean) as HTMLElement[]);
    // Reply box: persistent element so drafts survive live updates.
    if (active && this.canComment) {
      if (!card.reply) {
        const input = h('textarea.comment-input.reply', { rows: 1, placeholder: t.resolved && !t.suggestion ? 'Reply (reopens the thread)…' : 'Reply or add others with @', 'aria-label': 'Reply' });
        const send = h('button.btn.primary.sm', { type: 'button', disabled: true, onclick: () => void this.sendReply(t.id) }, 'Reply');
        attachMentions(input, { excludeSub: this.deps.me.sub });
        input.addEventListener('input', () => { send.disabled = !input.value.trim(); actions.hidden = !input.value.trim() && document.activeElement !== input; this.layoutSoon(); });
        input.addEventListener('focus', () => { actions.hidden = false; this.layoutSoon(); });
        input.addEventListener('blur', () => setTimeout(() => { actions.hidden = !input.value.trim(); this.layoutSoon(); }, 150));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void this.sendReply(t.id); }
          else if (e.key === 'Escape') { e.preventDefault(); input.value = ''; input.blur(); this.setActive(null); this.deps.view()?.focus(); }
        });
        autosize(input, 200);
        const actions = h('div.card-actions', { hidden: true }, h('span.kbd-hint', null, `${modKey}Enter`), h('button.btn.ghost.sm', { type: 'button', onclick: () => { input.value = ''; input.dispatchEvent(new Event('input')); input.blur(); } }, 'Cancel'), send);
        card.reply = h('div.card-reply', null, avatar(this.deps.me, 24), h('div.card-reply-main', null, input, actions));
        card.replyInput = input;
      }
      card.el.append(card.reply);
    } else if (card.reply && !(card.replyInput?.value.trim())) {
      card.reply.remove();
      card.reply = null;
      card.replyInput = null;
    } else if (card.reply) {
      card.el.append(card.reply);
    }
  }

  /** A suggestion card's top: state, author, the change, actions, and the author's note. */
  private suggestionParts(card: Card, t: Thread, parts: (HTMLElement | null)[], inSession: boolean, ctx: ReturnType<CommentsRail['mentionCtx']>) {
    const sg = t.suggestion!;
    const root = t.comments[0];
    const me = this.deps.me;
    const mine = root.author.sub === me.sub;
    const open = sg.status === 'open';
    if (sg.status === 'accepted') parts.push(h('div.card-banner.accepted', null, icon('checkCircle', 14), `Accepted${t.resolvedBy ? ` by ${t.resolvedBy.name}` : ''}`));
    else if (sg.status === 'rejected') parts.push(h('div.card-banner.rejected', null, icon('x', 14), `Rejected${t.resolvedBy ? ` by ${t.resolvedBy.name}` : ''}`));
    else if (sg.outdated) parts.push(h('div.card-banner.warn', null, icon('alert', 14), 'The text changed since this was suggested', this.canDecide ? ' — it can only be rejected' : ''));
    const actions: HTMLElement[] = [];
    if (open && this.canDecide) {
      actions.push(h('button.icon-btn.sm.accept-btn', { type: 'button', 'aria-label': 'Accept suggestion', 'data-tip': sg.outdated ? 'Outdated: can’t be accepted' : 'Accept', disabled: sg.outdated, onclick: () => void this.op({ type: 'suggestion.decide', id: t.id, decision: 'accept' }) }, icon('check', 18)));
      actions.push(h('button.icon-btn.sm.reject-btn', { type: 'button', 'aria-label': 'Reject suggestion', 'data-tip': 'Reject', onclick: () => void this.op({ type: 'suggestion.decide', id: t.id, decision: 'reject' }) }, icon('x', 18)));
    }
    const menu: MenuItem[] = [];
    if (open && mine && !inSession && !sg.outdated) menu.push({ label: 'Edit suggested text', icon: 'pencil', onSelect: () => this.beginRevise(card, t) });
    if (open && mine) menu.push({ label: 'Withdraw suggestion', icon: 'trash', danger: true, onSelect: () => void this.withdraw(t) });
    else if (!mine && atLeast(this.deps.role(), 'owner')) menu.push({ label: 'Delete suggestion', icon: 'trash', danger: true, onSelect: () => void this.deleteComment(t, root, true) });
    if (menu.length) {
      const btn: HTMLButtonElement = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'More suggestion actions', 'aria-haspopup': 'menu', onclick: () => openMenu(btn, menu, { align: 'end' }) }, icon('more', 18));
      actions.push(btn);
    }
    const badged = root.author.kind === 'agent' || root.author.kind === 'service' || root.author.kind === 'guest';
    parts.push(h('div.comment.root.sugg-root', { dataset: { comment: root.id } },
      h('div.comment-head', null,
        avatar(root.author, 30),
        h('div.comment-meta', null,
          h('div.comment-author', null, h('span.ca-name', { title: root.author.name }, shownName(root.author)), badged ? kindBadge(root.author.kind, { compact: false }) : null),
          h('div.comment-time', { title: fullTime(root.createdAt) }, sg.point ? 'Suggested an addition' : !sg.text ? 'Suggested a deletion' : 'Suggested a change', ' · ', relTime(root.createdAt), root.editedAt ? h('span.edited', { title: `Revised ${fullTime(root.editedAt)}` }, ' · revised') : null)),
        actions.length ? h('div.comment-actions', null, actions) : null)));
    if (card.revising) {
      parts.push(h('div.comment-edit', null, card.revising, h('div.card-actions', null,
        h('button.btn.ghost.sm', { type: 'button', onclick: () => { card.revising = null; card.sig = ''; this.render(); } }, 'Cancel'),
        h('button.btn.primary.sm', { type: 'button', onclick: () => void this.saveRevise(card, t) }, 'Save'))));
    } else {
      parts.push(suggestionDiff(sg.original, sg.text));
    }
    if (inSession) parts.push(h('div.sugg-hint', null, 'You’re editing this in the document.'));
    if (root.body) parts.push(h('div.comment-body.md.sugg-note', null, renderComment(root.body, ctx)));
  }

  private beginRevise(card: Card, t: Thread) {
    const ta = h('textarea.comment-input', { 'aria-label': 'Suggested text' });
    ta.value = t.suggestion!.text;
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void this.saveRevise(card, t); }
      else if (e.key === 'Escape') { e.preventDefault(); card.revising = null; card.sig = ''; this.render(); }
    });
    autosize(ta, 260);
    card.revising = ta;
    card.sig = '';
    this.setActive(t.id);
    this.render();
    requestAnimationFrame(() => ta.focus({ preventScroll: true }));
  }

  private async saveRevise(card: Card, t: Thread) {
    const ta = card.revising;
    if (!ta) return;
    if (!t.suggestion!.point && !t.suggestion!.original && !ta.value) { toast('An addition needs some text. Withdraw it instead.', { kind: 'error' }); return; }
    try {
      await this.deps.provider.request({ type: 'suggestion.revise', id: t.id, text: ta.value });
      card.revising = null;
      card.sig = '';
      this.render();
    } catch (e) { toast(errorMessage(e), { kind: 'error' }); }
  }

  private async withdraw(t: Thread) {
    const ok = await confirmDialog({ title: 'Withdraw this suggestion?', message: 'It will be removed for everyone, along with its replies.', confirmLabel: 'Withdraw', danger: true });
    if (!ok) return;
    await this.op({ type: 'comment.delete', comment: t.id }, 'Suggestion withdrawn');
  }

  private renderComment(card: Card, t: Thread, c: ThreadComment, isRoot: boolean, ctx: ReturnType<CommentsRail['mentionCtx']>): HTMLElement {
    const me = this.deps.me;
    const role = this.deps.role();
    const mine = c.author.sub === me.sub;
    const canDelete = mine || atLeast(role, 'owner');
    const actions: HTMLElement[] = [];
    if (isRoot && this.canComment && !t.resolved) {
      actions.push(h('button.icon-btn.sm.resolve-btn', { type: 'button', 'aria-label': 'Resolve thread', 'data-tip': 'Mark as resolved and hide', onclick: () => void this.op({ type: 'comment.resolve', comment: t.id, resolved: true }, 'Comment resolved') }, icon('check', 18)));
    }
    const menuItems: MenuItem[] = [];
    if (mine && this.canComment) menuItems.push({ label: 'Edit', icon: 'pencil', onSelect: () => { this.beginEdit(card, c); } });
    if (canDelete && this.canComment) menuItems.push({ label: isRoot ? 'Delete thread' : 'Delete', icon: 'trash', danger: true, onSelect: () => void this.deleteComment(t, c, isRoot) });
    // Assigning needs the directory, which guests can't use.
    if (isRoot && this.canComment && !isGuestMe(me)) {
      if (menuItems.length) menuItems.push('separator');
      menuItems.push({ label: t.assignee ? 'Reassign…' : 'Assign to…', icon: 'userCheck', onSelect: () => void this.assign(t) });
      if (t.assignee) menuItems.push({ label: 'Remove assignee', icon: 'x', onSelect: () => void this.op({ type: 'comment.assign', comment: t.id, assignee: null }) });
    }
    if (menuItems.length) {
      const btn: HTMLButtonElement = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'More comment actions', 'aria-haspopup': 'menu', onclick: () => openMenu(btn, menuItems, { align: 'end' }) }, icon('more', 18));
      actions.push(btn);
    }
    const editor = card.editing.get(c.id);
    let bodyEl: HTMLElement;
    if (editor) {
      bodyEl = h('div.comment-edit', null, editor, h('div.card-actions', null,
        h('button.btn.ghost.sm', { type: 'button', onclick: () => { card.editing.delete(c.id); card.sig = ''; this.render(); } }, 'Cancel'),
        h('button.btn.primary.sm', { type: 'button', onclick: () => void this.saveEdit(card, c) }, 'Save')));
    } else {
      bodyEl = h('div.comment-body.md', null, renderComment(c.body, ctx));
    }
    const badged = c.author.kind === 'agent' || c.author.kind === 'service' || c.author.kind === 'guest';
    return h('div.comment', { class: isRoot ? 'root' : 'reply', dataset: { comment: c.id } },
      h('div.comment-head', null,
        avatar(c.author, isRoot ? 30 : 26),
        h('div.comment-meta', null,
          h('div.comment-author', null, h('span.ca-name', { title: c.author.name }, shownName(c.author)), badged ? kindBadge(c.author.kind, { compact: false }) : null),
          h('div.comment-time', { title: fullTime(c.createdAt) }, relTime(c.createdAt), c.editedAt ? h('span.edited', { title: `Edited ${fullTime(c.editedAt)}` }, ' · edited') : null)),
        actions.length ? h('div.comment-actions', null, actions) : null),
      bodyEl);
  }

  private beginEdit(card: Card, c: ThreadComment) {
    const ta = h('textarea.comment-input', { 'aria-label': 'Edit comment' });
    ta.value = c.body;
    attachMentions(ta, { excludeSub: this.deps.me.sub });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void this.saveEdit(card, c); }
      else if (e.key === 'Escape') { e.preventDefault(); card.editing.delete(c.id); card.sig = ''; this.render(); }
    });
    autosize(ta, 240);
    card.editing.set(c.id, ta);
    card.sig = '';
    this.render();
    requestAnimationFrame(() => { ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); });
  }

  private async saveEdit(card: Card, c: ThreadComment) {
    const ta = card.editing.get(c.id);
    if (!ta) return;
    const body = ta.value.trim();
    if (!body) { toast('A comment can’t be empty. Delete it instead.', { kind: 'error' }); return; }
    try {
      const r = await this.deps.provider.request<{ warnings?: string[] }>({ type: 'comment.edit', comment: c.id, body });
      for (const w of r.warnings ?? []) toast(w, { kind: 'info', timeout: 9000 });
      card.editing.delete(c.id);
      card.sig = '';
      this.render();
    } catch (e) { toast(errorMessage(e), { kind: 'error' }); }
  }

  private async deleteComment(t: Thread, c: ThreadComment, isRoot: boolean) {
    const ok = await confirmDialog({
      title: isRoot ? 'Delete this thread?' : 'Delete this reply?',
      message: isRoot ? 'The comment and all its replies will be removed for everyone.' : 'This reply will be removed for everyone.',
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    await this.op({ type: 'comment.delete', comment: isRoot ? t.id : c.id }, isRoot ? 'Thread deleted' : 'Reply deleted');
  }

  private async assign(t: Thread) {
    const p = await pickPersonDialog({ title: 'Assign comment', help: 'They’ll be notified and see it as their action item. They need at least commenter access.', exclude: new Set() });
    if (!p) return;
    await this.op({ type: 'comment.assign', comment: t.id, assignee: p.sub }, `Assigned to ${p.name}`);
  }

  private async sendReply(threadId: string) {
    const card = this.cards.get(threadId);
    const input = card?.replyInput;
    if (!card || !input) return;
    const body = input.value.trim();
    if (!body) return;
    const t = this.threads.find((x) => x.id === threadId);
    input.disabled = true;
    try {
      const r = await this.deps.provider.request<{ warnings?: string[] }>({ type: 'comment.reply', comment: threadId, body });
      if (t?.resolved && !t.suggestion) await this.deps.provider.request({ type: 'comment.resolve', comment: threadId, resolved: false });
      for (const w of r.warnings ?? []) toast(w, { kind: 'info', timeout: 9000 });
      input.value = '';
      input.dispatchEvent(new Event('input'));
    } catch (e) {
      toast(errorMessage(e), { kind: 'error' });
    } finally {
      input.disabled = false;
      input.focus();
    }
  }

  private async op(msg: Record<string, unknown>, success?: string) {
    try {
      const r = await this.deps.provider.request<{ warnings?: string[] } | undefined>(msg);
      for (const w of r?.warnings ?? []) toast(w, { kind: 'info', timeout: 9000 });
      if (success) toast(success, { kind: 'success', timeout: 2500 });
    } catch (e) { toast(errorMessage(e), { kind: 'error' }); }
  }

  // ------------------------------------------------------------------ positioning

  readonly layoutSoon = rafThrottle(() => this.layoutCards());

  layoutCards() {
    const cards = [...this.cardsEl.children] as HTMLElement[];
    if (this.layout !== 'margin') {
      for (const c of cards) { c.style.transform = ''; c.classList.remove('placed'); }
      this.cardsEl.style.height = '';
      return;
    }
    const view = this.deps.view();
    if (!view) return;
    const top0 = view.documentTop - this.cardsEl.getBoundingClientRect().top;
    const GAP = 10;
    type Item = { el: HTMLElement; want: number; h: number; id: string; order: number };
    const items: Item[] = [];
    let unanchored = 0;
    cards.forEach((el, order) => {
      const id = el.dataset.id!;
      let want: number;
      if (id === '__draft' && this.draft) want = top0 + view.lineBlockAt(Math.min(this.draft.range.from, view.state.doc.length)).top;
      else {
        const r = this.anchors.get(id);
        want = r ? top0 + view.lineBlockAt(Math.min(r.from, view.state.doc.length)).top : -10_000 + unanchored++;
      }
      items.push({ el, want, h: el.offsetHeight, id, order });
    });
    items.sort((a, b) => a.want - b.want || a.order - b.order);
    for (const it of items) if (it.want < 0) it.want = 0;
    const y = new Array<number>(items.length);
    const activeId = this.draft ? '__draft' : this.active;
    const ai = items.findIndex((it) => it.id === activeId);
    const forward = (from: number, floor: number) => {
      let bottom = floor;
      for (let i = from; i < items.length; i++) { y[i] = Math.max(items[i].want, bottom); bottom = y[i] + items[i].h + GAP; }
    };
    if (ai < 0) forward(0, 0);
    else {
      y[ai] = items[ai].want;
      forward(ai + 1, y[ai] + items[ai].h + GAP);
      let top = y[ai];
      for (let i = ai - 1; i >= 0; i--) { y[i] = Math.min(items[i].want, top - GAP - items[i].h); top = y[i]; }
      if (ai > 0 && y[0] < 0) forward(0, 0);
    }
    let maxBottom = 0;
    items.forEach((it, i) => {
      it.el.style.transform = `translateY(${Math.round(y[i])}px)`;
      // New cards appear in place; only later moves animate.
      if (!it.el.classList.contains('placed')) { void it.el.offsetHeight; it.el.classList.add('placed'); }
      maxBottom = Math.max(maxBottom, y[i] + it.h);
    });
    this.cardsEl.style.height = `${Math.ceil(maxBottom + 40)}px`;
  }
}

// ------------------------------------------------------------------ small dialogs

export function pickPersonDialog(opts: { title: string; help?: string; exclude: Set<string> }): Promise<Person | null> {
  return new Promise((resolve) => {
    let done = false;
    const picker = peoplePicker({
      placeholder: 'Search people and agents', label: 'Person or agent', exclude: () => opts.exclude,
      onPick: (p) => { done = true; resolve(p); d.close(); },
    });
    const d = openDialog({
      title: opts.title, size: 'sm',
      body: h('div', null, opts.help ? h('p.dialog-help', null, opts.help) : null, picker.el),
      onClose: () => { if (!done) resolve(null); },
    });
    picker.input.focus();
  });
}

export function composeDialog(opts: { title: string; me: Me; confirm: string }): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const ta = h('textarea.comment-input.tall', { rows: 4, placeholder: 'Write a comment… Use @ to mention people or agents', 'aria-label': 'Comment' });
    attachMentions(ta, { excludeSub: opts.me.sub });
    const submit = () => { const v = ta.value.trim(); if (!v) return; done = true; resolve(v); d.close(); };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } });
    const d = openDialog({
      title: opts.title, size: 'md',
      body: ta,
      footer: [h('span.kbd-hint', null, `${modKey}Enter to send`), h('button.btn.ghost', { type: 'button', onclick: () => d.close() }, 'Cancel'), h('button.btn.primary', { type: 'button', onclick: submit }, opts.confirm)],
      onClose: () => { if (!done) resolve(null); },
    });
    ta.focus();
  });
}

// ------------------------------------------------------------------ suggestion diff

const DIFF_MAX = 4000;

/** The change a suggestion makes, word by word: deletions struck through, additions underlined. */
export function suggestionDiff(original: string, text: string): HTMLElement {
  const box = h('div.sugg-diff');
  const add = (cls: string, v: string) => box.append(h(`span.${cls}`, null, v));
  if (!original) { box.append(h('span.sugg-label', null, 'Add ')); add('d-ins', text); }
  else if (!text) { box.append(h('span.sugg-label', null, 'Delete ')); add('d-del', original); }
  else {
    const parts = original.length + text.length > DIFF_MAX * 2 ? undefined : wordDiff(original, text);
    if (!parts) { add('d-del', original); add('d-ins', text); }
    else for (const p of parts) add(p.added ? 'd-ins' : p.removed ? 'd-del' : 'd-same', p.value);
  }
  if (original.length + text.length > 600) {
    box.classList.add('long');
    const more = h('button.link-btn.sugg-more', { type: 'button', onclick: () => { box.classList.toggle('expanded'); more.textContent = box.classList.contains('expanded') ? 'Show less' : 'Show all'; } }, 'Show all');
    return h('div.sugg-diff-wrap', null, box, more);
  }
  return box;
}
