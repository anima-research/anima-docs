// Composite undo across nodes.
//
// Each node has a Y.UndoManager with captureTimeout 0 (one stack item per
// transaction) tracking only this editor's origin. The binding records one
// GROUP per user action: which nodes it touched and how many items each got.
// Undo pops the newest group and undoes that many items on each node. Groups
// are always undone newest-first, so the top of every involved node's stack is
// that group's item(s). Remote and agent edits are never undone.

import * as Y from 'yjs';

export interface Group { nodes: Map<string, number>; kind: 'text' | 'structure'; at: number }
const TYPING_MERGE_MS = 500;

export class UndoGroups {
  private managers = new Map<string, Y.UndoManager>();
  private undoStack: Group[] = [];
  private redoStack: Group[] = [];
  private busy = false;
  onChange: () => void = () => {};

  constructor(readonly origin: unknown) {}

  /** Must exist BEFORE a node's first local transaction, or that edit is never captured. */
  track(id: string, text: Y.Text) {
    if (this.managers.has(id)) return;
    this.managers.set(id, new Y.UndoManager(text, { captureTimeout: 0, trackedOrigins: new Set([this.origin]) }));
  }

  forget(id: string) {
    const m = this.managers.get(id);
    if (m) { m.destroy(); this.managers.delete(id); }
    for (const g of [...this.undoStack, ...this.redoStack]) g.nodes.delete(id);
    this.undoStack = this.undoStack.filter((g) => g.nodes.size);
    this.redoStack = this.redoStack.filter((g) => g.nodes.size);
  }

  record(nodes: Iterable<string>, kind: Group['kind']): void {
    if (this.busy) return;
    const map = new Map<string, number>();
    for (const id of nodes) if (this.managers.has(id)) map.set(id, (map.get(id) ?? 0) + 1);
    if (map.size === 0) return;
    const now = Date.now();
    const last = this.undoStack[this.undoStack.length - 1];
    const only = [...map.keys()][0];
    if (kind === 'text' && last && last.kind === 'text' && last.nodes.size === 1 && map.size === 1 && last.nodes.has(only) && now - last.at < TYPING_MERGE_MS) {
      last.nodes.set(only, last.nodes.get(only)! + map.get(only)!);
      last.at = now;
    } else this.undoStack.push({ nodes: map, kind, at: now });
    this.redoStack = [];
    this.onChange();
  }

  undo(): string[] | null {
    const g = this.undoStack.pop();
    if (!g) return null;
    this.busy = true;
    try { for (const [id, count] of g.nodes) { const m = this.managers.get(id); for (let i = 0; m && i < count; i++) m.undo(); } }
    finally { this.busy = false; }
    this.redoStack.push(g);
    this.onChange();
    return [...g.nodes.keys()];
  }

  redo(): string[] | null {
    const g = this.redoStack.pop();
    if (!g) return null;
    this.busy = true;
    try { for (const [id, count] of g.nodes) { const m = this.managers.get(id); for (let i = 0; m && i < count; i++) m.redo(); } }
    finally { this.busy = false; }
    this.undoStack.push(g);
    this.onChange();
    return [...g.nodes.keys()];
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  /** Break typing coalescing (after a structural op or a selection jump). */
  breakGroup() { const last = this.undoStack[this.undoStack.length - 1]; if (last) last.at = 0; }

  destroy() { for (const m of this.managers.values()) m.destroy(); this.managers.clear(); this.undoStack = []; this.redoStack = []; }
}
