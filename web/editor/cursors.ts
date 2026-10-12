// Remote cursors and selections from awareness, with name flags that mark agents.
// (Adapted from y-codemirror.next's yRemoteSelections, which can't mark agents.)
//
// Node-aware: your cursor is announced in the node it is in; everyone else's
// cursors, in whichever node, are mapped into the view through the layout.

import * as Y from 'yjs';
import { Annotation, RangeSet, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { Awareness } from 'y-protocols/awareness';
import { nodePos, virtualPos, type Layout } from './nodes/layout';
import type { NodeStore } from './nodes/store';
import { sharedCoords, type Coords } from './suggest';

const remoteChange = Annotation.define<null>();

export interface RemoteUser { name: string; color: string; sub?: string; kind?: string; via?: string }

class CaretWidget extends WidgetType {
  constructor(readonly user: RemoteUser, readonly fresh: boolean) { super(); }
  toDOM() {
    const isAgent = this.user.kind === 'agent' || this.user.kind === 'service';
    const caret = document.createElement('span');
    caret.className = `cm-remote-caret${isAgent ? ' is-agent' : ''}${this.fresh ? ' fresh' : ''}`;
    caret.style.setProperty('--c', this.user.color);
    caret.setAttribute('aria-hidden', 'true');
    caret.append('⁠');
    const flag = document.createElement('span');
    flag.className = 'cm-remote-flag';
    if (isAgent) {
      const star = document.createElement('span');
      star.className = 'cm-remote-flag-agent';
      star.textContent = '✦';
      flag.append(star);
    }
    flag.append(this.user.name);
    caret.append(flag, '⁠');
    return caret;
  }
  eq(other: CaretWidget) { return other.user.color === this.user.color && other.user.name === this.user.name && other.fresh === this.fresh; }
  get estimatedHeight() { return -1; }
  ignoreEvent() { return true; }
}

export function remoteCursors(nodes: NodeStore, layout: () => Layout, coords: () => Coords = () => sharedCoords) {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet = RangeSet.empty;
    /** client key → time its cursor last moved, to show the flag briefly after movement. */
    moved = new Map<string, { at: number; key: string }>();
    timer = 0;
    listening = new Map<Awareness, () => void>();
    destroyed = false;
    unsub: () => void;

    constructor(readonly view: EditorView) {
      this.hook();
      this.unsub = nodes.onChange(() => this.hook());
    }

    /** Listen to every open node's awareness (the set changes as mounts load). */
    hook() {
      const want = new Set(nodes.awarenesses().map((a) => a.provider.awareness));
      for (const [aw, off] of this.listening) if (!want.has(aw)) { off(); this.listening.delete(aw); }
      for (const aw of want) {
        if (this.listening.has(aw)) continue;
        const listener = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
          const changed = [...added, ...updated, ...removed];
          if (changed.some((c) => c !== aw.clientID)) queueMicrotask(() => { if (!this.destroyed) this.view.dispatch({ annotations: remoteChange.of(null) }); });
        };
        aw.on('change', listener);
        this.listening.set(aw, () => aw.off('change', listener));
      }
    }

    destroy() {
      this.destroyed = true;
      clearTimeout(this.timer);
      for (const off of this.listening.values()) off();
      this.listening.clear();
      this.unsub();
    }

    update(update: ViewUpdate) {
      const L = layout();
      const c = coords();
      const single = L.mounts.length === 0;
      const root = nodes.get(nodes.root);
      // ---- announce your own cursor in the node it is in
      const focused = update.view.hasFocus && update.view.dom.ownerDocument.hasFocus();
      const sel = focused ? update.state.selection.main : null;
      let announced: string | null = null;
      if (sel && root && root.awareness.getLocalState()) {
        let at: { node: string; offset: number } | null = null, anchorAt: { node: string; offset: number } | null = null;
        if (single || c.suggesting) {
          at = { node: nodes.root, offset: Math.min(c.toShared(sel.head), root.ytext.length) };
          anchorAt = { node: nodes.root, offset: Math.min(c.toShared(sel.anchor), root.ytext.length) };
        } else {
          at = nodePos(L, sel.head);
          anchorAt = nodePos(L, sel.anchor);
        }
        if (at) {
          const p = nodes.get(at.node);
          if (p) {
            announced = at.node;
            const yt = p.ytext;
            const headI = Math.min(at.offset, yt.length);
            const anchorI = anchorAt && anchorAt.node === at.node ? Math.min(anchorAt.offset, yt.length) : (anchorAt && sel.anchor < sel.head ? 0 : yt.length);
            const anchor = Y.createRelativePositionFromTypeIndex(yt, anchorI);
            const head = Y.createRelativePositionFromTypeIndex(yt, headI);
            const cur = p.awareness.getLocalState()?.cursor;
            if (!cur || !Y.compareRelativePositions(Y.createRelativePositionFromJSON(cur.anchor), anchor) || !Y.compareRelativePositions(Y.createRelativePositionFromJSON(cur.head), head)) {
              p.awareness.setLocalStateField('cursor', { anchor: Y.relativePositionToJSON(anchor), head: Y.relativePositionToJSON(head) });
            }
          }
        }
      }
      if (sel) for (const { id, provider } of nodes.awarenesses()) if (id !== announced && provider.awareness.getLocalState()?.cursor) provider.awareness.setLocalStateField('cursor', null);

      // ---- everyone else's
      const decos: Range<Decoration>[] = [];
      const now = Date.now();
      let nextExpiry = Infinity;
      const docLen = update.state.doc.length;
      const seen = new Set<string>();
      for (const { id, provider } of nodes.awarenesses()) {
        const aw = provider.awareness;
        const doc = provider.doc;
        const yt = provider.ytext;
        aw.getStates().forEach((state: any, client: number) => {
          if (client === aw.clientID || !state?.cursor?.anchor || !state.cursor.head) return;
          let a: Y.AbsolutePosition | null, hd: Y.AbsolutePosition | null;
          try {
            a = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(state.cursor.anchor), doc);
            hd = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(state.cursor.head), doc);
          } catch { return; }
          if (!a || !hd || a.type !== yt || hd.type !== yt) return;
          const user: RemoteUser = { name: state.user?.name ?? 'Someone', color: state.user?.color ?? '#1a73e8', sub: state.user?.sub, kind: state.user?.kind, via: state.user?.via };
          let anchor: number | null, head: number | null;
          if (single || c.suggesting) { anchor = id === nodes.root ? c.toView(a.index) : null; head = id === nodes.root ? c.toView(hd.index) : null; }
          else { anchor = virtualPos(L, id, a.index, 'start'); head = virtualPos(L, id, hd.index, 'end'); }
          if (anchor === null || head === null) return;
          anchor = Math.min(anchor, docLen); head = Math.min(head, docLen);
          const ck = `${id}:${client}`;
          seen.add(ck);
          const key = `${anchor}:${head}`;
          const prev = this.moved.get(ck);
          if (!prev || prev.key !== key) this.moved.set(ck, { at: now, key });
          const movedAt = this.moved.get(ck)!.at;
          const fresh = now - movedAt < 2500;
          if (fresh) nextExpiry = Math.min(nextExpiry, movedAt + 2500);
          const light = `color-mix(in srgb, ${user.color} 22%, transparent)`;
          const from = Math.min(anchor, head), to = Math.max(anchor, head);
          if (from < to) {
            const startLine = update.state.doc.lineAt(from), endLine = update.state.doc.lineAt(to);
            const mark = Decoration.mark({ attributes: { style: `background-color: ${light}` }, class: 'cm-remote-selection' });
            if (startLine.number === endLine.number) decos.push(mark.range(from, to));
            else {
              if (startLine.to > from) decos.push(mark.range(from, startLine.to));
              for (let i = startLine.number + 1; i < endLine.number; i++) {
                const l = update.state.doc.line(i);
                decos.push(Decoration.line({ attributes: { style: `background-color: ${light}` }, class: 'cm-remote-line-selection' }).range(l.from));
              }
              if (to > endLine.from) decos.push(mark.range(endLine.from, to));
            }
          }
          decos.push(Decoration.widget({ side: head - anchor > 0 ? -1 : 1, widget: new CaretWidget(user, fresh) }).range(head));
        });
      }
      for (const k of this.moved.keys()) if (!seen.has(k)) this.moved.delete(k);
      this.decorations = Decoration.set(decos, true);
      clearTimeout(this.timer);
      if (nextExpiry < Infinity) {
        this.timer = window.setTimeout(() => { if (!this.destroyed) this.view.dispatch({ annotations: remoteChange.of(null) }); }, Math.max(50, nextExpiry - now + 30));
      }
    }
  }, { decorations: (v) => v.decorations });
}
