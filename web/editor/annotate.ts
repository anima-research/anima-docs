// The annotation layer over a rendered document inside the app: the markdown preview.
// The same behaviour as /page-annotate.js gives a framed HTML page — select text →
// Comment; open threads highlighted by their quote; double-click a run of text to
// edit it — but on an element of the app's own DOM, so it talks to the page directly
// instead of over postMessage. It never changes the document by itself: it proposes
// a quote to comment on, a replacement to apply, a thread to open.

import { h } from '../lib/dom';

export interface AnnotationProposal { quote: string; prefix: string; suffix: string }
export interface AnnotationSink {
  comment(p: AnnotationProposal): void;
  edit(p: AnnotationProposal & { text: string }): void;
  openThread(id: string): void;
}
export interface AnnotationLayer {
  setConfig(c: { canComment: boolean; canEdit: boolean }): void;
  setHighlights(threads: { id: string; quote: string; prefix?: string | null; suffix?: string | null; resolved?: boolean }[]): void;
  /** The root was re-rendered: put the highlights back. */
  refresh(): void;
  destroy(): void;
}

const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ');
interface Idx { text: string; map: { node: Text; offset: number }[] }

export function annotationLayer(root: HTMLElement, sink: AnnotationSink): AnnotationLayer {
  let config = { canComment: false, canEdit: false };
  let highlights: Parameters<AnnotationLayer['setHighlights']>[0] = [];

  function textNodes(): Text[] {
    const out: Text[] = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => {
      const p = (n as Text).parentElement;
      return !p || p.closest('script,style,noscript,textarea,[data-anima-ui],.katex-mathml') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    } });
    let n: Node | null; while ((n = w.nextNode())) out.push(n as Text);
    return out;
  }
  /** Whitespace-collapsed text of the root with, for each character, the text node and offset it came from. */
  function index(): Idx {
    const nodes = textNodes(); let s = ''; const map: Idx['map'] = []; let space = true;
    for (const node of nodes) {
      const t = node.data;
      for (let i = 0; i < t.length; i++) {
        const ch = t[i];
        if (/\s/.test(ch)) { if (space) continue; s += ' '; map.push({ node, offset: i }); space = true; }
        else { s += ch; map.push({ node, offset: i }); space = false; }
      }
    }
    return { text: s, map };
  }
  /** Where a DOM point falls in the indexed text (first indexed character at or after it). */
  function posOf(idx: Idx, node: Node, offset: number): number {
    if (node.nodeType !== 3) {
      const r = document.createRange(); r.setStart(node, offset); r.collapse(true);
      for (let i = 0; i < idx.map.length; i++) { const m = idx.map[i]; const p = document.createRange(); p.setStart(m.node, m.offset); p.collapse(true); if (r.compareBoundaryPoints(Range.START_TO_START, p) <= 0) return i; }
      return idx.text.length;
    }
    for (let j = 0; j < idx.map.length; j++) if (idx.map[j].node === node && idx.map[j].offset >= offset) return j;
    let seen = false;
    for (let z = 0; z < idx.map.length; z++) { if (idx.map[z].node === node) seen = true; else if (seen) return z; }
    return idx.text.length;
  }
  function find(idx: Idx, quote: string, prefix?: string | null, suffix?: string | null, near?: number): { start: number; end: number } | null {
    const q = norm(quote).trim();
    if (!q) return null;
    let best: number | null = null, bestScore = -1, at = -1;
    while ((at = idx.text.indexOf(q, at + 1)) >= 0) {
      let score = 0;
      if (prefix) { const p = norm(prefix); const before = idx.text.slice(Math.max(0, at - p.length), at); if (before === p) score += 4; else if (before.trim().slice(-12) === p.trim().slice(-12)) score += 2; }
      if (suffix) { const sf = norm(suffix); const after = idx.text.slice(at + q.length, at + q.length + sf.length); if (after === sf) score += 4; else if (after.trim().slice(0, 12) === sf.trim().slice(0, 12)) score += 2; }
      if (typeof near === 'number') score += 1 / (1 + Math.abs(at - near) / 50);
      if (score > bestScore) { bestScore = score; best = at; }
    }
    return best === null ? null : { start: best, end: best + q.length };
  }
  const context = (idx: Idx, start: number, end: number) => ({ prefix: idx.text.slice(Math.max(0, start - 32), start), suffix: idx.text.slice(end, end + 32) });

  // ------------------------------------------------------------ highlights
  function unmark() {
    for (const m of Array.from(root.querySelectorAll('mark.anima-mark'))) { const p = m.parentNode!; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m); p.normalize(); }
  }
  function markRange(idx: Idx, start: number, end: number, threadId: string, resolved: boolean) {
    const segs: { node: Text; from: number; to: number }[] = []; let cur: typeof segs[number] | null = null;
    for (let i = start; i < end; i++) {
      const m = idx.map[i]; if (!m) break;
      if (cur && cur.node === m.node && m.offset === cur.to) cur.to = m.offset + 1;
      else { cur = { node: m.node, from: m.offset, to: m.offset + 1 }; segs.push(cur); }
    }
    for (const s of segs) {
      if (!s.node.parentNode) continue;
      s.node.splitText(s.to); const mid = s.node.splitText(s.from);
      const mark = h('mark.anima-mark', { 'data-thread': threadId, title: 'Open this comment' }) as HTMLElement;
      if (resolved) mark.classList.add('resolved');
      mid.parentNode!.insertBefore(mark, mid); mark.appendChild(mid);
    }
  }
  function applyHighlights() {
    unmark();
    for (const t of highlights) {
      if (!t.quote) continue;
      const idx = index(); // rebuilt per thread: marking splits text nodes
      const r = find(idx, t.quote, t.prefix, t.suffix);
      if (r) markRange(idx, r.start, r.end, t.id, !!t.resolved);
    }
  }
  const onClick = (e: MouseEvent) => {
    const m = (e.target as HTMLElement | null)?.closest?.('mark.anima-mark');
    if (m && root.contains(m)) { e.preventDefault(); sink.openThread(m.getAttribute('data-thread') ?? ''); }
  };

  // ------------------------------------------------------------ selection → comment
  const commentBtn = h('button', { type: 'button', 'data-anima-ui': '', onmousedown: (e: MouseEvent) => e.preventDefault(), onclick: () => { if (pending) { sink.comment(pending); hideBar(); window.getSelection()?.removeAllRanges(); } } }, 'Comment');
  const hint = h('span.anima-hint', { 'data-anima-ui': '' }, 'double-click text to edit');
  const bar = h('div.anima-bar', { 'data-anima-ui': '', hidden: true }, commentBtn, hint);
  let pending: AnnotationProposal | null = null;
  function hideBar() { bar.hidden = true; pending = null; }
  function showBar() {
    const sel = window.getSelection();
    if (!config.canComment || !sel || sel.isCollapsed || !sel.rangeCount || !norm(sel.toString()).trim() || root.hidden || !root.isConnected) { hideBar(); return; }
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer) || bar.contains(range.commonAncestorContainer)) { hideBar(); return; }
    const idx = index();
    const q = norm(sel.toString()).trim();
    const near = posOf(idx, range.startContainer, range.startOffset);
    const r = find(idx, q, null, null, near);
    if (!r) { hideBar(); return; }
    const c = context(idx, r.start, r.end);
    pending = { quote: q, prefix: c.prefix, suffix: c.suffix };
    const rect = range.getBoundingClientRect();
    bar.hidden = false;
    hint.hidden = !config.canEdit;
    let top = rect.top - bar.offsetHeight - 8; if (top < 4) top = rect.bottom + 8;
    const left = Math.max(4, Math.min(window.innerWidth - bar.offsetWidth - 4, rect.left + rect.width / 2 - bar.offsetWidth / 2));
    bar.style.top = `${top}px`; bar.style.left = `${left}px`;
  }
  const onMouseUp = () => setTimeout(showBar, 0);
  const onKeyUp = (e: KeyboardEvent) => { if (e.shiftKey || e.key === 'Shift') setTimeout(showBar, 0); };
  const onMouseDown = (e: MouseEvent) => { if (!bar.contains(e.target as Node)) hideBar(); };
  const onScroll = () => hideBar();

  // ------------------------------------------------------------ double-click → edit a text run
  let editing: { span: HTMLElement; textNode: Text; original: string; quote: string; prefix: string; suffix: string } | null = null;
  function startEdit(textNode: Text) {
    if (!config.canEdit || editing || !textNode.data.trim()) return;
    const idx = index();
    let start = -1, end = -1;
    for (let i = 0; i < idx.map.length; i++) { if (idx.map[i].node === textNode) { if (start < 0) start = i; end = i + 1; } }
    if (start < 0) return;
    const c = context(idx, start, end);
    const original = textNode.data;
    const span = h('span.anima-edit', { 'data-anima-ui': '' }) as HTMLElement;
    span.contentEditable = 'plaintext-only';
    if (span.contentEditable !== 'plaintext-only') span.contentEditable = 'true';
    span.textContent = original;
    textNode.parentNode!.replaceChild(span, textNode);
    editing = { span, textNode, original, quote: norm(original).trim(), prefix: c.prefix, suffix: c.suffix };
    span.focus();
    const r = document.createRange(); r.selectNodeContents(span); const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r);
    hideBar();
  }
  function endEdit(commit: boolean) {
    const e = editing; if (!e) return; editing = null;
    const text = e.span.textContent ?? '';
    e.textNode.data = commit && text !== e.original ? text : e.original;
    e.span.parentNode?.replaceChild(e.textNode, e.span);
    if (commit && text !== e.original) sink.edit({ quote: e.quote, prefix: e.prefix, suffix: e.suffix, text });
  }
  const onDblClick = (e: MouseEvent) => {
    if (!config.canEdit || editing || !root.contains(e.target as Node)) return;
    const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node } | null };
    const pos = doc.caretPositionFromPoint ? doc.caretPositionFromPoint(e.clientX, e.clientY) : null;
    const node = pos ? pos.offsetNode : document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY)?.startContainer ?? null : null;
    if (node && node.nodeType === 3 && root.contains(node) && !(node.parentElement?.closest('[data-anima-ui],a,button,input,select,textarea,code,pre,.katex'))) { e.preventDefault(); startEdit(node as Text); }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!editing) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); endEdit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endEdit(false); }
  };
  const onFocusOut = (e: FocusEvent) => { const t = e.target; if (editing && t === editing.span) setTimeout(() => { if (editing && editing.span === t) endEdit(true); }, 0); };

  document.addEventListener('click', onClick, true);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('scroll', onScroll, true);
  document.addEventListener('dblclick', onDblClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('focusout', onFocusOut, true);
  document.body.append(bar);

  return {
    setConfig(c) { config = { ...c }; root.classList.toggle('anima-annotatable', config.canComment); if (!config.canComment) hideBar(); },
    setHighlights(threads) { highlights = threads; applyHighlights(); },
    refresh() { applyHighlights(); },
    destroy() {
      if (editing) endEdit(false);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('dblclick', onDblClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusout', onFocusOut, true);
      bar.remove();
    },
  };
}
