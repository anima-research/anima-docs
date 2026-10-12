// Navigation trees: Notion-style placement of documents under one another.
//
// A placement (tree, parent, child, order) is a navigational edge with no
// effect on any body. A tree is a node designated as a root; the nav shows
// placements under it. A node may be placed in several trees. Named nodes
// mounted inside a placed document are placed under it by default (derived
// placements), and follow the mounts: when the child loses its name or its
// mount, the derived placement goes. Removing a placement leaves a sticky
// exclusion so the subpage is not re-derived behind the user's back.
//
// Access through a tree works like access through a mount (Documents.role
// derives it from Nodes.parentsOf, which includes placement parents).

import { EventEmitter } from 'node:events';
import type { DB } from './db.js';
import { Fault } from './auth.js';
import { atLeast, Documents, type Role } from './documents.js';
import type { Nodes } from './nodes.js';
import type { Actor } from './principals.js';

export interface Placement { tree: string; parent: string; child: string; ord: number; derived: boolean }
export interface TreeView {
  root: string;
  title: string;
  role: Role;
  nodes: { id: string; title: string; section: boolean; type: string; role: Role }[];
  placements: Placement[];
}

type PRow = { tree_id: string; parent_id: string; child_id: string; ord: number; derived: number };
const fromRow = (r: PRow): Placement => ({ tree: r.tree_id, parent: r.parent_id, child: r.child_id, ord: r.ord, derived: !!r.derived });

export class Trees extends EventEmitter {
  constructor(private db: DB, private docs: Documents, private nodes: Nodes) {
    super();
    this.setMaxListeners(50);
    nodes.on('mounts', (e: { parent: string; added: string[]; removed: string[] }) => this.onMounts(e.parent));
    docs.on('meta', (e: { docId: string; kind: string }) => {
      if (e.kind === 'renamed') this.onRenamed(e.docId);
      if (e.kind === 'deleted') this.onDeleted(e.docId);
    });
  }

  // ------------------------------------------------------------------ reads

  isRoot(id: string): boolean { return !!this.db.prepare('SELECT 1 FROM trees WHERE root_id = ?').get(id); }

  /** Trees whose root the actor can open. */
  roots(actor: Pick<Actor, 'sub' | 'admin'>): { root: string; title: string; role: Role }[] {
    const rows = this.db.prepare('SELECT t.root_id AS id, d.title FROM trees t JOIN documents d ON d.id = t.root_id WHERE d.deleted_at IS NULL ORDER BY d.title').all() as { id: string; title: string }[];
    const out: { root: string; title: string; role: Role }[] = [];
    for (const r of rows) { const role = this.docs.role(r.id, actor); if (role) out.push({ root: r.id, title: r.title, role }); }
    return out;
  }

  children(tree: string, parent: string): Placement[] {
    return (this.db.prepare('SELECT * FROM placements WHERE tree_id = ? AND parent_id = ? ORDER BY ord, child_id').all(tree, parent) as PRow[]).map(fromRow);
  }

  placementsOf(child: string): Placement[] {
    return (this.db.prepare('SELECT * FROM placements WHERE child_id = ?').all(child) as PRow[]).map(fromRow);
  }

  isPlaced(tree: string, child: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM placements WHERE tree_id = ? AND child_id = ? LIMIT 1').get(tree, child);
  }

  /** Path of node ids from the root to `node` within `tree` (first found), or null. */
  pathTo(tree: string, node: string): string[] | null {
    if (node === tree) return [tree];
    const seen = new Set<string>();
    const walk = (cur: string, path: string[]): string[] | null => {
      if (seen.has(cur) || path.length > 24) return null;
      seen.add(cur);
      for (const p of this.children(tree, cur)) {
        const next = [...path, p.child];
        if (p.child === node) return next;
        const r = walk(p.child, next);
        if (r) return r;
      }
      return null;
    };
    return walk(tree, [tree]);
  }

  /** Every tree the node is in (placed, or as root), with the path there. */
  pathsOf(node: string, actor: Pick<Actor, 'sub' | 'admin'>): { tree: string; title: string; path: { id: string; title: string }[] }[] {
    const trees = new Set<string>();
    for (const p of this.placementsOf(node)) trees.add(p.tree);
    if (this.isRoot(node)) trees.add(node);
    const out: ReturnType<Trees['pathsOf']> = [];
    for (const t of trees) {
      if (!this.docs.role(t, actor)) continue;
      const path = this.pathTo(t, node);
      if (!path) continue;
      out.push({ tree: t, title: this.docs.get(t)?.title ?? t, path: path.map((id) => ({ id, title: this.docs.get(id)?.title ?? '' })) });
    }
    return out;
  }

  /** The whole tree, limited to nodes the actor can open. */
  view(root: string, actor: Pick<Actor, 'sub' | 'admin'>): TreeView {
    const { doc, role } = this.docs.require(root, actor, 'viewer');
    if (!this.isRoot(root)) throw new Fault(404, `“${doc.title}” is not a tree root.`);
    const nodes: TreeView['nodes'] = [];
    const placements: Placement[] = [];
    const seen = new Set<string>();
    const add = (id: string, r: Role) => { const d = this.docs.get(id); if (d && !seen.has(id)) { seen.add(id); nodes.push({ id, title: d.title, section: d.title === '', type: d.type, role: r }); } };
    add(root, role);
    const walk = (parent: string, depth: number) => {
      if (depth > 24) return;
      for (const p of this.children(root, parent)) {
        const r = this.docs.role(p.child, actor);
        if (!r || !this.docs.get(p.child)) continue;
        placements.push(p);
        const fresh = !seen.has(p.child);
        add(p.child, r);
        if (fresh) walk(p.child, depth + 1);
      }
    };
    walk(root, 0);
    return { root, title: doc.title, role, nodes, placements };
  }

  /** Placed children of `node` in `tree` that are not mounted inline in its body (shown as a Subpages footer). */
  subpagesNotInline(tree: string, node: string): string[] {
    const inline = new Set(this.nodes.namedMountedChildren(node));
    return this.children(tree, node).map((p) => p.child).filter((c) => !inline.has(c));
  }

  /** Named nodes the actor owns that are in no tree and have no parent. */
  unfiled(actor: Actor): string[] {
    const rows = this.db.prepare(`SELECT d.id FROM documents d WHERE d.deleted_at IS NULL AND d.title != '' AND d.owner_sub = ?
      AND NOT EXISTS (SELECT 1 FROM placements p WHERE p.child_id = d.id) AND NOT EXISTS (SELECT 1 FROM trees t WHERE t.root_id = d.id)
      AND NOT EXISTS (SELECT 1 FROM mounts m JOIN documents pd ON pd.id = m.parent_id WHERE m.child_id = d.id AND pd.deleted_at IS NULL)`).all(actor.sub) as { id: string }[];
    return rows.map((r) => r.id);
  }

  // ------------------------------------------------------------------ mutations

  /** Make a document a tree root (editors of it). Its named mounted descendants become its first subpages. */
  create(root: string, actor: Actor): TreeView {
    const { doc } = this.docs.require(root, actor, 'editor');
    if (doc.title === '') throw new Fault(400, 'A section cannot be a tree root; give it a name first.');
    if (!this.isRoot(root)) {
      this.db.prepare('INSERT INTO trees (root_id, created_by, created_at) VALUES (?, ?, ?)').run(root, actor.sub, Date.now());
      this.derive(root, root);
      this.changed(root);
    }
    return this.view(root, actor);
  }

  /** Stop treating a document as a tree root: its placements go, the pages stay. */
  drop(root: string, actor: Actor): void {
    this.docs.require(root, actor, 'owner');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM trees WHERE root_id = ?').run(root);
      this.db.prepare('DELETE FROM placements WHERE tree_id = ?').run(root);
      this.db.prepare('DELETE FROM placement_exclusions WHERE tree_id = ?').run(root);
    })();
    this.changed(root);
  }

  private wouldCycle(tree: string, parent: string, child: string): boolean {
    if (parent === child || child === tree) return true;
    const path = this.pathTo(tree, parent);
    return !path || path.includes(child);
  }

  /**
   * Place `child` under `parent` in `tree`. Explicit placements need editor
   * access on the parent page and the right to share the child (editor
   * access given directly, since a placement extends the tree's readers to
   * it). Derived placements are the system's and skip those checks.
   */
  place(tree: string, parent: string, child: string, actor: Actor | null, opts: { derived?: boolean } = {}): boolean {
    if (!this.isRoot(tree)) throw new Fault(404, 'No such tree.');
    const c = this.docs.get(child), p = this.docs.get(parent);
    if (!c || !p) throw new Fault(404, 'No such page.');
    if (!opts.derived) {
      if (!actor) throw new Fault(403, 'Sign in to arrange pages.');
      this.docs.require(parent, actor, 'editor');
      if (!atLeast(this.docs.baseRole(child, actor), 'editor')) throw new Fault(403, `Placing “${c.title || c.id}” in a tree shares it with everyone who can open the tree; that needs editor access to it given to you directly.`);
      if (c.title === '') throw new Fault(400, 'Sections are not pages: name it first to place it in a tree.');
    }
    if (this.wouldCycle(tree, parent, child)) return false;
    const k = [tree, parent, child] as const;
    if (this.db.prepare('SELECT 1 FROM placements WHERE tree_id = ? AND parent_id = ? AND child_id = ?').get(...k)) return true;
    if (opts.derived && this.db.prepare('SELECT 1 FROM placement_exclusions WHERE tree_id = ? AND parent_id = ? AND child_id = ?').get(...k)) return false;
    const max = (this.db.prepare('SELECT max(ord) AS m FROM placements WHERE tree_id = ? AND parent_id = ?').get(tree, parent) as { m: number | null }).m ?? 0;
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO placements (tree_id, parent_id, child_id, ord, derived, placed_by, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(tree, parent, child, max + 1, opts.derived ? 1 : 0, actor?.sub ?? null, Date.now());
      if (!opts.derived) this.db.prepare('DELETE FROM placement_exclusions WHERE tree_id = ? AND parent_id = ? AND child_id = ?').run(...k);
    })();
    this.derive(tree, child);
    this.changed(tree);
    if (!opts.derived) this.docs.emit('share', { docId: child, sub: null, role: 'placed', by: actor?.sub ?? null });
    return true;
  }

  /** Remove a placement (editors of the parent page). The page stays; the subpage is not re-derived. */
  unplace(tree: string, parent: string, child: string, actor: Actor): void {
    if (!this.isRoot(tree)) throw new Fault(404, 'No such tree.');
    this.docs.require(parent, actor, 'editor');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM placements WHERE tree_id = ? AND parent_id = ? AND child_id = ?').run(tree, parent, child);
      this.db.prepare('INSERT OR REPLACE INTO placement_exclusions (tree_id, parent_id, child_id, by, at) VALUES (?, ?, ?, ?, ?)').run(tree, parent, child, actor.sub, Date.now());
    })();
    this.changed(tree);
    this.docs.emit('share', { docId: child, sub: null, role: 'unplaced', by: actor.sub });
  }

  move(tree: string, parent: string, child: string, actor: Actor, dir: -1 | 1): void {
    if (!this.isRoot(tree)) throw new Fault(404, 'No such tree.');
    this.docs.require(parent, actor, 'editor');
    const sib = this.children(tree, parent);
    const i = sib.findIndex((p) => p.child === child);
    const j = i + dir;
    if (i < 0) throw new Fault(404, 'That page is not placed there.');
    if (j < 0 || j >= sib.length) return;
    const a = sib[i], b = sib[j];
    this.db.transaction(() => {
      const set = this.db.prepare('UPDATE placements SET ord = ? WHERE tree_id = ? AND parent_id = ? AND child_id = ?');
      set.run(b.ord, tree, parent, a.child);
      set.run(a.ord, tree, parent, b.child);
    })();
    this.changed(tree);
  }

  // ------------------------------------------------------------------ derivation

  /** Subpages by default: named nodes mounted in `node` are placed under it, unless excluded. */
  derive(tree: string, node: string, seen = new Set<string>()): void {
    if (seen.has(node) || seen.size > 2000) return;
    seen.add(node);
    for (const c of this.nodes.namedMountedChildren(node)) {
      if (this.isPlaced(tree, c)) { this.derive(tree, c, seen); continue; }
      if (this.place(tree, node, c, null, { derived: true })) this.derive(tree, c, seen);
    }
  }

  /** Derived placements follow the mounts: drop those whose child lost its name or its mount under that parent. */
  private pruneDerived(tree: string, parent: string): boolean {
    const rows = this.db.prepare('SELECT child_id FROM placements WHERE tree_id = ? AND parent_id = ? AND derived = 1').all(tree, parent) as { child_id: string }[];
    if (!rows.length) return false;
    const live = new Set(this.nodes.namedMountedChildren(parent));
    let dropped = false;
    for (const r of rows) {
      const d = this.docs.get(r.child_id);
      if (!d || d.title === '' || !live.has(r.child_id)) {
        this.db.prepare('DELETE FROM placements WHERE tree_id = ? AND parent_id = ? AND child_id = ? AND derived = 1').run(tree, parent, r.child_id);
        dropped = true;
      }
    }
    return dropped;
  }

  /** Trees in which `node` is placed or is the root. */
  private treesHolding(node: string): string[] {
    const set = new Set<string>();
    for (const p of this.placementsOf(node)) set.add(p.tree);
    if (this.isRoot(node)) set.add(node);
    return [...set];
  }

  private onMounts(parent: string) {
    for (const t of this.treesHolding(parent)) {
      const dropped = this.pruneDerived(t, parent);
      this.derive(t, parent);
      if (dropped) this.changed(t);
    }
  }

  private onRenamed(id: string) {
    // Named now → may be a subpage of its parents; nameless now → derived placements of it go.
    for (const parent of this.nodes.parentsOf(id)) this.onMounts(parent);
    const d = this.docs.get(id);
    if (d && d.title === '') {
      const rows = this.db.prepare('SELECT tree_id FROM placements WHERE child_id = ? AND derived = 1').all(id) as { tree_id: string }[];
      this.db.prepare('DELETE FROM placements WHERE child_id = ? AND derived = 1').run(id);
      for (const r of rows) this.changed(r.tree_id);
    }
  }

  private onDeleted(id: string) {
    const trees = this.treesHolding(id);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM placements WHERE child_id = ? OR parent_id = ?').run(id, id);
      this.db.prepare('DELETE FROM trees WHERE root_id = ?').run(id);
      this.db.prepare('DELETE FROM placements WHERE tree_id = ?').run(id);
    })();
    for (const t of trees) this.changed(t);
  }

  private changed(tree: string) {
    try { this.emit('changed', { tree }); } catch (e) { console.error('[trees] changed listener failed:', e); }
  }

  /** Every node in the tree (for realtime fan-out). */
  members(tree: string): string[] {
    const set = new Set<string>([tree]);
    for (const r of this.db.prepare('SELECT child_id FROM placements WHERE tree_id = ?').all(tree) as { child_id: string }[]) set.add(r.child_id);
    return [...set];
  }
}
