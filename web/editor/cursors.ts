// Remote cursors and selections from awareness, with name flags that mark agents.
// (Adapted from y-codemirror.next's yRemoteSelections, which can't mark agents.)

import * as Y from 'yjs';
import { Annotation, RangeSet, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { Awareness } from 'y-protocols/awareness';

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

export function remoteCursors(ytext: Y.Text, awareness: Awareness) {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet = RangeSet.empty;
    /** client → time its cursor last moved, to show the flag briefly after movement. */
    moved = new Map<number, { at: number; key: string }>();
    timer = 0;
    listener = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const changed = [...added, ...updated, ...removed];
      if (changed.some((c) => c !== awareness.clientID)) {
        // Defer: awareness may change inside another editor update.
        queueMicrotask(() => { if (!this.destroyed) this.view.dispatch({ annotations: remoteChange.of(null) }); });
      }
    };
    destroyed = false;

    constructor(readonly view: EditorView) {
      awareness.on('change', this.listener);
    }

    destroy() {
      this.destroyed = true;
      clearTimeout(this.timer);
      awareness.off('change', this.listener);
    }

    update(update: ViewUpdate) {
      const doc = ytext.doc!;
      const local = awareness.getLocalState();
      if (local) {
        const focused = update.view.hasFocus && update.view.dom.ownerDocument.hasFocus();
        const sel = focused ? update.state.selection.main : null;
        if (sel) {
          const anchor = Y.createRelativePositionFromTypeIndex(ytext, sel.anchor);
          const head = Y.createRelativePositionFromTypeIndex(ytext, sel.head);
          const cur = local.cursor;
          if (!cur || !Y.compareRelativePositions(Y.createRelativePositionFromJSON(cur.anchor), anchor) || !Y.compareRelativePositions(Y.createRelativePositionFromJSON(cur.head), head)) {
            awareness.setLocalStateField('cursor', { anchor: Y.relativePositionToJSON(anchor), head: Y.relativePositionToJSON(head) });
          }
        }
      }

      const decos: Range<Decoration>[] = [];
      const now = Date.now();
      let nextExpiry = Infinity;
      const docLen = update.state.doc.length;
      awareness.getStates().forEach((state: any, client: number) => {
        if (client === awareness.clientID || !state?.cursor?.anchor || !state.cursor.head) return;
        let a: Y.AbsolutePosition | null, hd: Y.AbsolutePosition | null;
        try {
          a = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(state.cursor.anchor), doc);
          hd = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(state.cursor.head), doc);
        } catch { return; }
        if (!a || !hd || a.type !== ytext || hd.type !== ytext) return;
        const user: RemoteUser = { name: state.user?.name ?? 'Someone', color: state.user?.color ?? '#1a73e8', sub: state.user?.sub, kind: state.user?.kind, via: state.user?.via };
        const anchor = Math.min(a.index, docLen), head = Math.min(hd.index, docLen);
        const key = `${anchor}:${head}`;
        const prev = this.moved.get(client);
        if (!prev || prev.key !== key) this.moved.set(client, { at: now, key });
        const movedAt = this.moved.get(client)!.at;
        const fresh = now - movedAt < 2500;
        if (fresh) nextExpiry = Math.min(nextExpiry, movedAt + 2500);
        const light = `color-mix(in srgb, ${user.color} 22%, transparent)`;
        const from = Math.min(anchor, head), to = Math.max(anchor, head);
        if (from < to) {
          const startLine = update.state.doc.lineAt(from), endLine = update.state.doc.lineAt(to);
          const mark = Decoration.mark({ attributes: { style: `background-color: ${light}` }, class: 'cm-remote-selection' });
          if (startLine.number === endLine.number) decos.push(mark.range(from, to));
          else {
            decos.push(mark.range(from, startLine.to));
            for (let i = startLine.number + 1; i < endLine.number; i++) {
              const l = update.state.doc.line(i);
              decos.push(Decoration.line({ attributes: { style: `background-color: ${light}` }, class: 'cm-remote-line-selection' }).range(l.from));
            }
            decos.push(mark.range(endLine.from, to));
          }
        }
        decos.push(Decoration.widget({ side: head - anchor > 0 ? -1 : 1, widget: new CaretWidget(user, fresh) }).range(head));
      });
      for (const c of this.moved.keys()) if (!awareness.getStates().has(c)) this.moved.delete(c);
      this.decorations = Decoration.set(decos, true);
      clearTimeout(this.timer);
      if (nextExpiry < Infinity) {
        this.timer = window.setTimeout(() => { if (!this.destroyed) this.view.dispatch({ annotations: remoteChange.of(null) }); }, Math.max(50, nextExpiry - now + 30));
      }
    }
  }, { decorations: (v) => v.decorations });
}
