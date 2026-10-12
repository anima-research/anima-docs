// One CodeMirror view over the flattened node tree.
//
// Local edits are decomposed into per-node Yjs ops; any node change (local,
// remote, agent, a node arriving) reconciles the view against a fresh
// flatten. Mount boundaries are drawn as bands (block widgets) with
// per-depth guides; a band collapses its node (which then leaves the virtual
// document), opens it as its own page, or names it.

import { Annotation, EditorSelection, EditorState, Facet, Prec, RangeSet, StateEffect, StateField, Transaction, type ChangeSet, type Extension, type TransactionSpec } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, WidgetType, gutterLineClass, keymap, type DecorationSet, type KeyBinding } from '@codemirror/view';
import { decompose, flatten, markerRemoval, placeAt, splitChange, type Layout, type Mount, type UnmountOp } from './layout';
import type { NodeStore } from './store';
import { UndoGroups } from './undo';

/** Transactions the binding dispatched itself (reconciliation), never user input. */
export const nodeSync = Annotation.define<boolean>();
const setLayout = StateEffect.define<Layout>();
const unmountsOf = StateEffect.define<UnmountOp[]>();

export const layoutField = StateField.define<Layout>({
  create: () => ({ root: '', items: [], mounts: [], length: 0, text: '' }),
  update(v, tr) { for (const e of tr.effects) if (e.is(setLayout)) return e.value; return v; },
});

export interface NodeLabel { title: string; section: boolean; type: string; loaded: boolean; chars: number; lines: number; first: string }
/** How the bands learn names and summaries. */
export const nodeInfo = Facet.define<(id: string) => NodeLabel | undefined, (id: string) => NodeLabel | undefined>({ combine: (v) => v[0] ?? (() => undefined) });
/** Pages placed under the root in the current navigation tree but not mounted inline. */
export const subpagesSource = Facet.define<() => { id: string; title: string }[], () => { id: string; title: string }[]>({ combine: (v) => v[0] ?? (() => []) });

export interface BindingOptions {
  store: NodeStore;
  /** Can the viewer edit this node right now? Edits into read-only nodes are dropped with a notice. */
  canEdit: (node: string) => boolean;
  onNotice?: (msg: string) => void;
  /** Backspace at a child's first line: ask to merge it into its parent (the server does it). */
  onMergeRequest?: (m: Mount) => void;
  onOpen?: (id: string) => void;
  onName?: (id: string) => void;
  onLayout?: (l: Layout) => void;
}

export class Binding {
  view!: EditorView;
  readonly undo: UndoGroups;
  /** Collapsed mount keys: view-local, never synced. */
  collapsed = new Set<string>();
  private stop: (() => void) | null = null;
  private pending = false;
  private detached = false;
  /** While suggesting (single-node views only), the suggest session owns the view text. */
  private suspended = false;
  /** Yjs transaction origin for this editor's own edits. */
  readonly origin = { binding: true };

  constructor(readonly opts: BindingOptions) {
    this.undo = new UndoGroups(this.origin);
    for (const id of opts.store.ids()) this.undo.track(id, opts.store.get(id)!.ytext);
  }

  get store() { return this.opts.store; }
  get root() { return this.opts.store.root; }

  layout(): Layout { return flatten(this.root, this.store.source, (k) => this.collapsed.has(k)); }
  get current(): Layout { return this.view ? this.view.state.field(layoutField) : this.layout(); }

  extensions(): Extension {
    return [
      layoutField,
      bandDecorations,
      collapsedGutter,
      subpagesDeco,
      EditorState.transactionFilter.of((tr) => this.filter(tr)),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        const L = u.startState.field(layoutField);
        for (const tr of u.transactions) {
          if (tr.annotation(nodeSync)) continue;
          const unmounts = tr.effects.filter((e) => e.is(unmountsOf)).flatMap((e) => e.value);
          this.applyLocal(L, tr.changes, unmounts);
        }
      }),
      Prec.high(keymap.of(this.keys())),
    ];
  }

  attach(view: EditorView) {
    this.view = view;
    view.dom.addEventListener('node-toggle', (e) => this.toggle((e as CustomEvent<string>).detail));
    view.dom.addEventListener('node-open', (e) => this.opts.onOpen?.((e as CustomEvent<string>).detail));
    view.dom.addEventListener('node-name', (e) => this.opts.onName?.((e as CustomEvent<string>).detail));
    this.stop = this.store.onChange(() => this.scheduleReconcile());
    this.reconcile();
  }

  detach() { this.detached = true; this.stop?.(); this.stop = null; this.undo.destroy(); }
  suspend() { this.suspended = true; }
  resume() { this.suspended = false; this.reconcile(); }

  toggle(key: string) {
    if (this.collapsed.has(key)) this.collapsed.delete(key); else this.collapsed.add(key);
    this.reconcile();
  }

  // ------------------------------------------------------------------ local → nodes

  private filter(tr: Transaction): TransactionSpec | Transaction {
    if (!tr.docChanged || tr.annotation(nodeSync)) return tr;
    const L = tr.startState.field(layoutField);
    const pieces: { from: number; to: number; insert: string }[] = [];
    const unmounts: UnmountOp[] = [];
    let rewritten = false, dropped = false, readOnly = false;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      const text = inserted.toString();
      const d = decompose(L, fromA, toA, text);
      unmounts.push(...d.unmounts);
      if (d.dropped) dropped = true;
      // Edits into nodes the viewer cannot edit are dropped (the rest of the change still applies).
      const blocked = d.ops.some((op) => !this.opts.canEdit(op.node)) || d.unmounts.some((u) => !this.opts.canEdit(u.parent));
      if (blocked) { readOnly = true; rewritten = true; return; }
      const split = splitChange(L, fromA, toA, text);
      if (split) { rewritten = true; pieces.push(...split); }
      else pieces.push({ from: fromA, to: toA, insert: text });
    });
    if (!rewritten) return tr;
    if (readOnly) this.opts.onNotice?.('That section is read-only for you.');
    else if (dropped) this.opts.onNotice?.('That line stands for a collapsed section: expand it to edit.');
    const changes = tr.startState.changes(pieces);
    const sel = EditorSelection.create(tr.startState.selection.ranges.map((r) => EditorSelection.cursor(changes.mapPos(r.head, r.empty ? 1 : -1))));
    const ue = tr.annotation(Transaction.userEvent);
    return { changes, selection: sel, userEvent: ue ?? undefined, scrollIntoView: tr.scrollIntoView, effects: unmounts.length ? unmountsOf.of(unmounts) : [] };
  }

  private applyLocal(L: Layout, changes: ChangeSet, unmounts: UnmountOp[]) {
    const perNode = new Map<string, { from: number; to: number; insert: string }[]>();
    const push = (id: string, op: { from: number; to: number; insert: string }) => (perNode.get(id) ?? perNode.set(id, []).get(id)!).push(op);
    // A detached subtree is left intact: no text op touches the detached node or anything mounted inside it.
    const detached = new Set<string>();
    for (const u of unmounts) {
      const m = L.mounts.find((x) => x.parent === u.parent && x.markerFrom === u.markerFrom);
      if (!m) continue;
      detached.add(m.child);
      for (const x of L.mounts) if (x.depth > m.depth && x.from >= m.from && x.to <= m.to) detached.add(x.child);
    }
    changes.iterChanges((fromA, toA, _fb, _tb, inserted) => {
      for (const op of decompose(L, fromA, toA, inserted.toString()).ops) if (!detached.has(op.node)) push(op.node, op);
    });
    for (const u of unmounts) {
      const p = this.store.get(u.parent);
      if (!p) continue;
      const r = markerRemoval(p.ytext.toString(), u);
      push(u.parent, { ...r, insert: '' });
    }
    const affected = [...perNode.keys()];
    for (const [id, ops] of perNode) {
      const p = this.store.get(id);
      if (!p) continue;
      ops.sort((a, b) => b.from - a.from || b.to - a.to);
      p.doc.transact(() => {
        for (const op of ops) {
          if (op.to > op.from) p.ytext.delete(op.from, op.to - op.from);
          if (op.insert) p.ytext.insert(op.from, op.insert);
        }
      }, this.origin);
    }
    this.undo.record(affected, unmounts.length ? 'structure' : 'text');
    if (unmounts.length) this.opts.onNotice?.(unmounts.length === 1 ? 'Section detached (it still exists; undo to put it back).' : `${unmounts.length} sections detached (undo to put them back).`);
    this.scheduleReconcile();
  }

  runUndo(redo = false): boolean {
    const ids = redo ? this.undo.redo() : this.undo.undo();
    if (!ids) return false;
    this.reconcile();
    return true;
  }

  // ------------------------------------------------------------------ nodes → view

  private scheduleReconcile() {
    if (this.pending || this.detached) return;
    this.pending = true;
    queueMicrotask(() => { this.pending = false; this.reconcile(); });
  }

  reconcile() {
    if (!this.view || this.detached || this.suspended) return;
    for (const id of this.store.ids()) this.undo.track(id, this.store.get(id)!.ytext);
    const L = this.layout();
    // Nodes that left the tree can go.
    const reachable = new Set<string>([this.root]);
    for (const m of L.mounts) reachable.add(m.child);
    for (const id of this.store.ids()) if (!reachable.has(id)) { this.undo.forget(id); }
    this.store.prune(reachable);
    const cur = this.view.state.doc.toString();
    if (cur !== L.text) {
      let a = 0;
      const max = Math.min(cur.length, L.text.length);
      while (a < max && cur[a] === L.text[a]) a++;
      let b = 0;
      while (b < max - a && cur[cur.length - 1 - b] === L.text[L.text.length - 1 - b]) b++;
      this.view.dispatch({
        changes: { from: a, to: cur.length - b, insert: L.text.slice(a, L.text.length - b) },
        effects: setLayout.of(L),
        annotations: [nodeSync.of(true), Transaction.addToHistory.of(false)],
      });
    } else this.view.dispatch({ effects: setLayout.of(L), annotations: nodeSync.of(true) });
    this.opts.onLayout?.(L);
  }

  // ------------------------------------------------------------------ keys

  private keys(): KeyBinding[] {
    return [
      {
        key: 'Backspace',
        run: (view) => {
          const sel = view.state.selection.main;
          if (!sel.empty) return false;
          const L = view.state.field(layoutField);
          const m = L.mounts.filter((mm) => mm.from === sel.head && !mm.collapsed).sort((x, y) => y.depth - x.depth)[0];
          const nlBefore = L.items.some((it) => it.kind === 'nl' && it.from === sel.head - 1);
          if (m && nlBefore && this.opts.onMergeRequest) { this.opts.onMergeRequest(m); return true; }
          if (nlBefore) { this.opts.onNotice?.('That line break is a section boundary.'); return true; }
          return false;
        },
      },
      {
        key: 'Delete',
        run: (view) => {
          const sel = view.state.selection.main;
          if (!sel.empty) return false;
          const L = view.state.field(layoutField);
          if (L.items.some((it) => it.kind === 'nl' && it.from === sel.head)) { this.opts.onNotice?.('That line break is a section boundary.'); return true; }
          return false;
        },
      },
      { key: 'Mod-z', run: () => this.runUndo(false) || true, preventDefault: true },
      { key: 'Mod-Shift-z', run: () => this.runUndo(true) || true, preventDefault: true },
      { key: 'Mod-y', run: () => this.runUndo(true) || true, preventDefault: true },
    ];
  }
}

// ------------------------------------------------------------------ decorations

class Band extends WidgetType {
  constructor(readonly m: Mount, readonly label: NodeLabel | undefined, readonly crumbs: string) { super(); }
  eq(o: Band) {
    return o.m.key === this.m.key && o.m.from === this.m.from && o.m.collapsed === this.m.collapsed && o.m.loaded === this.m.loaded && o.crumbs === this.crumbs
      && o.label?.title === this.label?.title && o.label?.section === this.label?.section && o.label?.first === this.label?.first && o.label?.lines === this.label?.lines;
  }
  toDOM() {
    const el = document.createElement('div');
    const d = Math.min(this.m.depth, 6);
    el.className = `node-band depth-${d}${this.m.collapsed ? ' collapsed' : ''}${this.label?.section ? ' is-section' : ''}`;
    el.style.setProperty('--d', String(this.m.depth));
    el.dataset.node = this.m.child;
    el.dataset.key = this.m.key;
    el.setAttribute('contenteditable', 'false');
    const fire = (name: string, detail: string) => el.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
    const tri = document.createElement('button');
    tri.type = 'button';
    tri.className = 'band-tri';
    tri.title = this.m.collapsed ? 'Expand section' : 'Collapse section';
    tri.setAttribute('aria-label', tri.title);
    tri.textContent = this.m.collapsed ? '▸' : '▾';
    tri.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); fire('node-toggle', this.m.key); });
    const crumbs = document.createElement('span');
    crumbs.className = 'band-crumbs';
    crumbs.textContent = this.crumbs ? `${this.crumbs} › ` : '';
    const name = document.createElement('button');
    name.type = 'button';
    name.className = `band-name${this.label?.section ? ' nameless' : ''}`;
    name.textContent = !this.m.loaded ? 'Loading…' : this.label?.section ? 'section' : (this.label?.title || 'Untitled');
    name.title = this.label?.section ? 'Open this section on its own page' : 'Open as its own page';
    name.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    name.addEventListener('click', (e) => { e.stopPropagation(); fire('node-open', this.m.child); });
    const meta = document.createElement('span');
    meta.className = 'band-meta';
    meta.textContent = this.label && this.label.type !== 'markdown' ? this.label.type : '';
    el.append(tri, crumbs, name, meta);
    if (this.label?.section) {
      const nm = document.createElement('button');
      nm.type = 'button'; nm.className = 'band-act'; nm.textContent = 'Name…'; nm.title = 'Give this section a name: it becomes a document of its own';
      nm.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
      nm.addEventListener('click', (e) => { e.stopPropagation(); fire('node-name', this.m.child); });
      el.append(nm);
    }
    if (this.m.collapsed && this.label) {
      const sum = document.createElement('span');
      sum.className = 'band-summary';
      sum.textContent = this.m.loaded ? `⋯ ${this.label.lines} line${this.label.lines === 1 ? '' : 's'}${this.label.first ? ` · “${this.label.first}”` : ''}` : '';
      el.append(sum);
    }
    el.addEventListener('mousedown', (e) => { if (e.target === el) { e.preventDefault(); fire('node-toggle', this.m.key); } });
    return el;
  }
  ignoreEvent() { return true; }
}

class BandEnd extends WidgetType {
  constructor(readonly m: Mount, readonly title: string) { super(); }
  eq(o: BandEnd) { return o.m.key === this.m.key && o.m.to === this.m.to && o.title === this.title; }
  toDOM() {
    const el = document.createElement('div');
    el.className = `node-band-end depth-${Math.min(this.m.depth, 6)}`;
    el.style.setProperty('--d', String(this.m.depth));
    el.setAttribute('contenteditable', 'false');
    el.textContent = `end of ${this.title}`;
    return el;
  }
  ignoreEvent() { return true; }
}

const bandDecorations = EditorView.decorations.compute([layoutField, 'doc', nodeInfo], (state): DecorationSet => {
  const L = state.field(layoutField);
  const info = state.facet(nodeInfo);
  const label = (id: string) => { const l = info(id); return !l ? '…' : l.section ? 'section' : (l.title || 'Untitled'); };
  const marks: { from: number; deco: Decoration; side: number }[] = [];
  const crumbsOf = (m: Mount) => L.mounts.filter((o) => o !== m && o.depth < m.depth && o.from <= m.from && m.to <= o.to).sort((a, b) => a.depth - b.depth).map((o) => label(o.child)).join(' › ');
  for (const m of L.mounts) {
    marks.push({ from: m.from, side: -10 + m.depth, deco: Decoration.widget({ widget: new Band(m, info(m.child), crumbsOf(m)), block: true, side: -10 + m.depth }) });
    if (!m.collapsed) marks.push({ from: m.to, side: 10 - m.depth, deco: Decoration.widget({ widget: new BandEnd(m, label(m.child)), block: true, side: 10 - m.depth }) });
  }
  const doc = state.doc;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const at = placeAt(L, line.from);
    const col = at ? null : L.mounts.find((m) => m.collapsed && m.from === line.from);
    const depth = at ? at.depth : col ? col.depth : 0;
    if (depth > 0) marks.push({ from: line.from, side: 0, deco: Decoration.line({ class: `node-line depth-${Math.min(depth, 6)}${col ? ' collapsed-line' : ''}`, attributes: { 'data-node': at ? at.node : col!.child, style: `--d:${depth}` } }) });
  }
  marks.sort((a, b) => a.from - b.from || a.side - b.side);
  return Decoration.set(marks.map((m) => m.deco.range(m.from)), true);
});

const hiddenNumber = new (class extends GutterMarker { elementClass = 'collapsed-gutter'; })();
const collapsedGutter = gutterLineClass.compute([layoutField, 'doc'], (state) => {
  const L = state.field(layoutField);
  const ranges = L.mounts.filter((m) => m.collapsed).map((m) => hiddenNumber.range(state.doc.lineAt(m.from).from));
  ranges.sort((a, b) => a.from - b.from);
  return RangeSet.of(ranges, true);
});

class Subpages extends WidgetType {
  constructor(readonly items: { id: string; title: string }[]) { super(); }
  eq(o: Subpages) { return o.items.length === this.items.length && o.items.every((x, i) => x.id === this.items[i].id && x.title === this.items[i].title); }
  toDOM() {
    const el = document.createElement('div');
    el.className = 'subpages';
    el.setAttribute('contenteditable', 'false');
    const label = document.createElement('span'); label.className = 'subpages-label'; label.textContent = 'Subpages';
    el.append(label);
    for (const it of this.items) {
      const a = document.createElement('a'); a.href = `/d/${it.id}`; a.textContent = it.title || 'Untitled'; a.dataset.open = it.id;
      a.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); el.dispatchEvent(new CustomEvent('node-open', { detail: it.id, bubbles: true })); });
      el.append(a);
    }
    return el;
  }
  ignoreEvent() { return true; }
}
const subpagesDeco = EditorView.decorations.compute([layoutField, 'doc', subpagesSource], (state): DecorationSet => {
  const items = state.facet(subpagesSource)();
  if (!items.length) return Decoration.none;
  return Decoration.set([Decoration.widget({ widget: new Subpages(items), block: true, side: 100 }).range(state.doc.length)]);
});
