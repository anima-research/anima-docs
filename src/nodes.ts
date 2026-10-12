// The node model: documents made of sections made of documents.
//
// Every document is a node. A node with an empty title is a SECTION, reachable
// only through the nodes that mount it. A MOUNT is a line in a parent's body
// that is exactly `{{node:<id>}}` (column 0, trailing whitespace allowed);
// anything else is literal text. The `mounts` table is the index of those
// lines, rebuilt from a line scan whenever a body changes.
//
// Access is derived: a principal who can open a parent can open the nodes it
// mounts (capped at editor), see Documents.role().

import { EventEmitter } from 'node:events';
import type { DB } from './db.js';
import { Fault } from './auth.js';
import { atLeast, Documents, type DocChange, type DocMeta, type Role } from './documents.js';
import type { Comments } from './comments.js';
import type { Actor } from './principals.js';

/** `{{node:<id>}}` mounts inline; `{{node:<id>|aside}}` mounts as a sidebar panel (a wiki aside). Still a whole line. */
export const MARKER_RE = /^\{\{node:([A-Za-z0-9]+)(?:\|(aside))?\}\}[ \t]*$/;
export type MountRole = 'inline' | 'aside';
export const marker = (id: string, role: MountRole = 'inline') => (role === 'aside' ? `{{node:${id}|aside}}` : `{{node:${id}}}`);
export const MAX_DEPTH = 12;

export interface Mount { parent: string; child: string; nth: number; line: number }

/** A node as the tree reports it. */
export interface TreeNode { id: string; title: string; section: boolean; type: string; chars: number; depth: number }
export interface ContentTree { root: string; nodes: TreeNode[]; mounts: { parent: string; child: string; nth: number; role: MountRole }[]; cycles: string[] }

/** Mount lines of a body, in order. */
export function scanMounts(text: string): { child: string; line: number; from: number; to: number; role: MountRole }[] {
  const out: { child: string; line: number; from: number; to: number; role: MountRole }[] = [];
  let at = 0, line = 1;
  for (;;) {
    const i = text.indexOf('\n', at);
    const to = i < 0 ? text.length : i;
    if (to - at <= 66 && to - at >= 9) {
      const m = MARKER_RE.exec(text.slice(at, to));
      if (m) out.push({ child: m[1], line, from: at, to, role: m[2] === 'aside' ? 'aside' : 'inline' });
    }
    if (i < 0) break;
    at = i + 1; line++;
  }
  return out;
}

export class Nodes extends EventEmitter {
  private comments: Comments | null = null;

  constructor(private db: DB, private docs: Documents) {
    super();
    this.setMaxListeners(100);
    docs.setParents((id) => this.parentsOf(id));
    docs.on('loaded', (e: { docId: string }) => this.reindex(e.docId));
    docs.on('change', (c: DocChange) => { if (c.inserted.includes('{{') || c.removed > 0 || this.has(c.docId)) this.reindex(c.docId, c.origin.sub); });
    docs.on('meta', (e: { docId: string; kind: string }) => { if (e.kind === 'deleted') this.forget(e.docId); });
    this.backfill();
  }

  /** Comments re-anchor across split and merge (set after construction to avoid a cycle). */
  attachComments(c: Comments) { this.comments = c; }

  // ------------------------------------------------------------------ index

  private has(docId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM mounts WHERE parent_id = ? LIMIT 1').get(docId);
  }

  /** Bodies changed since they were last scanned (a deploy over an older database). Loads each once. */
  private backfill() {
    const stale = this.db.prepare(`SELECT d.id FROM documents d LEFT JOIN mount_scan s ON s.doc_id = d.id
      WHERE d.deleted_at IS NULL AND (s.rev IS NULL OR s.rev < d.rev)`).all() as { id: string }[];
    if (!stale.length) return;
    const t0 = Date.now();
    for (const { id } of stale) {
      try { this.docs.ydoc(id); } catch (e) { console.error(`[nodes] backfill ${id}:`, (e as Error).message); }
    }
    console.log(`[nodes] indexed mounts of ${stale.length} document(s) in ${Date.now() - t0} ms`);
  }

  /** Rebuild the parent's mount rows from its body; emit what changed. */
  reindex(docId: string, by: string | null = null) {
    const d = this.docs.get(docId);
    if (!d) return;
    let text: string;
    try { text = this.docs.text(docId); } catch { return; }
    const found = scanMounts(text);
    const next = new Map<string, number>(); // child → count
    for (const m of found) next.set(m.child, (next.get(m.child) ?? 0) + 1);
    const prev = new Map<string, number>();
    for (const r of this.db.prepare('SELECT child_id, count(*) AS n FROM mounts WHERE parent_id = ? GROUP BY child_id').all(docId) as { child_id: string; n: number }[]) prev.set(r.child_id, r.n);
    const added = [...next.keys()].filter((c) => !prev.has(c));
    const removed = [...prev.keys()].filter((c) => !next.has(c));
    const changed = added.length || removed.length || [...next].some(([c, n]) => prev.get(c) !== n);
    this.db.transaction(() => {
      if (changed) {
        this.db.prepare('DELETE FROM mounts WHERE parent_id = ?').run(docId);
        const ins = this.db.prepare('INSERT INTO mounts (parent_id, child_id, nth, role) VALUES (?, ?, ?, ?)');
        const nth = new Map<string, number>();
        for (const m of found) { const k = nth.get(m.child) ?? 0; nth.set(m.child, k + 1); ins.run(docId, m.child, k, m.role); }
        const log = this.db.prepare('INSERT INTO mount_log (parent_id, child_id, op, sub, at) VALUES (?, ?, ?, ?, ?)');
        const now = Date.now();
        for (const c of added) log.run(docId, c, 'mount', by, now);
        for (const c of removed) log.run(docId, c, 'unmount', by, now);
      }
      this.db.prepare('INSERT INTO mount_scan (doc_id, rev) VALUES (?, ?) ON CONFLICT(doc_id) DO UPDATE SET rev = excluded.rev').run(docId, d.rev);
    })();
    if (changed) {
      try { this.emit('mounts', { parent: docId, added, removed, by }); } catch (e) { console.error('[nodes] mounts listener failed:', e); }
      // Access through this parent changed for the children involved.
      try { this.docs.emit('share', { docId, sub: null, role: 'mounts', by }); } catch { /* listeners are guarded */ }
    }
  }

  private forget(docId: string) {
    this.db.prepare('DELETE FROM mounts WHERE parent_id = ?').run(docId);
    this.db.prepare('DELETE FROM mount_scan WHERE doc_id = ?').run(docId);
  }

  /** Parents that mount `id` (live documents only). Tree placements count too (see trees.ts). */
  parentsOf(id: string): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT m.parent_id AS p FROM mounts m JOIN documents d ON d.id = m.parent_id WHERE m.child_id = ? AND d.deleted_at IS NULL
      UNION SELECT DISTINCT pl.parent_id AS p FROM placements pl JOIN documents d ON d.id = pl.parent_id WHERE pl.child_id = ? AND d.deleted_at IS NULL`).all(id, id) as { p: string }[];
    return rows.map((r) => r.p);
  }

  /** Mounted children of `id`, in body order (an id appears once per mount line). */
  childrenOf(id: string): { child: string; nth: number; role: MountRole }[] {
    return (this.db.prepare('SELECT child_id, nth, role FROM mounts WHERE parent_id = ? ORDER BY rowid').all(id) as { child_id: string; nth: number; role: MountRole }[]).map((r) => ({ child: r.child_id, nth: r.nth, role: r.role ?? 'inline' }));
  }

  /** How many live mount lines there are for `id` anywhere. */
  mountCount(id: string): number {
    return (this.db.prepare('SELECT count(*) AS n FROM mounts m JOIN documents d ON d.id = m.parent_id WHERE m.child_id = ? AND d.deleted_at IS NULL').get(id) as { n: number }).n;
  }

  /** Would mounting `child` in `parent` make a cycle? (parent reachable from child, or the same node) */
  wouldCycle(parent: string, child: string): boolean {
    if (parent === child) return true;
    const seen = new Set<string>();
    const stack = [child];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === parent) return true;
      if (seen.has(cur) || seen.size > 5000) continue;
      seen.add(cur);
      for (const c of this.childrenOf(cur)) stack.push(c.child);
    }
    return false;
  }

  /** Named nodes mounted inline in `id`'s body, looking through nameless sections. Asides are panels, not pages: left out. */
  namedMountedChildren(id: string, seen = new Set<string>()): string[] {
    if (seen.has(id)) return [];
    seen.add(id);
    const out: string[] = [];
    for (const { child, role } of this.childrenOf(id)) {
      if (role === 'aside') continue;
      const d = this.docs.get(child);
      if (!d) continue;
      if (d.title !== '') { if (!out.includes(child)) out.push(child); }
      else for (const x of this.namedMountedChildren(child, seen)) if (!out.includes(x)) out.push(x);
    }
    return out;
  }

  // ------------------------------------------------------------------ the tree

  /** The content tree under `root`: every node reachable through mounts, with what the actor may know of it. */
  tree(root: string, actor: Pick<Actor, 'sub' | 'admin'>): ContentTree {
    const nodes: TreeNode[] = [];
    const mounts: ContentTree['mounts'] = [];
    const cycles: string[] = [];
    const seen = new Set<string>();
    const walk = (id: string, depth: number, path: Set<string>) => {
      const d = this.docs.get(id);
      if (!d) return;
      if (!seen.has(id)) {
        seen.add(id);
        let chars = 0;
        try { chars = this.docs.text(id).length; } catch { /* unreadable: reported as 0 */ }
        nodes.push({ id, title: d.title, section: d.title === '', type: d.type, chars, depth });
      }
      if (depth >= MAX_DEPTH) return;
      for (const m of this.childrenOf(id)) {
        if (path.has(m.child) || m.child === id) { cycles.push(m.child); continue; }
        if (!this.docs.get(m.child) || !this.docs.role(m.child, actor)) continue; // deleted, or not yours to see
        mounts.push({ parent: id, child: m.child, nth: m.nth, role: m.role });
        const next = new Set(path); next.add(id);
        walk(m.child, depth + 1, next);
      }
    };
    walk(root, 0, new Set());
    return { root, nodes, mounts, cycles };
  }

  /** The virtual document: `root` with every mount line replaced by the child's text (recursively, cycle-safe). */
  flatten(root: string, actor: Pick<Actor, 'sub' | 'admin'>, opts: { delimit?: boolean } = {}): string {
    const walk = (id: string, path: Set<string>, depth: number): string => {
      const text = this.docs.text(id);
      if (depth >= MAX_DEPTH) return text;
      const found = scanMounts(text);
      if (!found.length) return text;
      let out = '', at = 0;
      for (const m of found) {
        const d = this.docs.get(m.child);
        if (!d || path.has(m.child) || m.child === id || !this.docs.role(m.child, actor)) continue; // literal
        const next = new Set(path); next.add(id);
        const body = walk(m.child, next, depth + 1);
        out += text.slice(at, m.from);
        const kind = m.role === 'aside' ? 'aside' : 'section';
        out += opts.delimit ? `[${kind} ${m.child}${d.title ? ` “${d.title}”` : ''}${d.type !== 'markdown' ? ` ${d.type}` : ''} begins]\n${body}\n[${kind} ${m.child} ends]` : body;
        at = m.to;
      }
      return out + text.slice(at);
    };
    return walk(root, new Set(), 0);
  }

  // ------------------------------------------------------------------ operations

  /** A new section: a node with no name, owned by the parent's owner, mounted at the end of the parent (or just created). */
  createSection(parent: string, actor: Actor, opts: { content?: string; type?: string; mount?: boolean; title?: string } = {}): DocMeta {
    const { doc } = this.docs.require(parent, actor, 'editor');
    const child = this.docs.createNode(actor, { title: opts.title ?? '', content: opts.content ?? '', type: opts.type ?? doc.type, owner: doc.ownerSub });
    if (opts.mount !== false) this.mount(parent, child.id, actor, { fresh: true });
    return this.docs.get(child.id)!;
  }

  /** Append a mount line to the parent (an editor of the parent who can read the child). */
  mount(parent: string, child: string, actor: Actor, opts: { at?: number; role?: MountRole; /** just created by this actor: no access check on it */ fresh?: boolean } = {}): void {
    this.docs.require(parent, actor, 'editor');
    if (!opts.fresh) this.docs.require(child, actor, 'viewer');
    else if (!this.docs.get(child)) throw new Fault(404, `No document ${child}.`);
    if (this.wouldCycle(parent, child)) throw new Fault(409, 'That would mount a node inside itself.');
    this.docs.edit(parent, { sub: actor.sub, via: actor.via ?? 'mcpl', label: 'Mounted a section' }, (t) => {
      const text = t.toString();
      if (opts.at !== undefined) {
        // At a line start: the marker gets its own line.
        const at = Math.max(0, Math.min(opts.at, text.length));
        const lineStart = at === 0 || text[at - 1] === '\n';
        const lineEnd = at === text.length || text[at] === '\n';
        t.insert(at, `${lineStart ? '' : '\n'}${marker(child, opts.role)}${lineEnd ? '' : '\n'}`);
      } else {
        t.insert(text.length, `${text.length === 0 || text.endsWith('\n') ? '' : '\n'}${text.length === 0 || text.endsWith('\n\n') ? '' : '\n'}${marker(child, opts.role)}\n`);
      }
    });
    this.reindex(parent, actor.sub);
  }

  /** Remove every mount line of `child` from `parent`; the child is left as it is (an orphan, or mounted elsewhere). */
  unmount(parent: string, child: string, actor: Actor): number {
    this.docs.require(parent, actor, 'editor');
    let n = 0;
    this.docs.edit(parent, { sub: actor.sub, via: actor.via ?? 'mcpl', label: 'Unmounted a section' }, (t) => {
      const text = t.toString();
      const lines = scanMounts(text).filter((m) => m.child === child).reverse();
      for (const m of lines) {
        let from = m.from, to = m.to;
        if (to < text.length && text[to] === '\n') to += 1; else if (from > 0 && text[from - 1] === '\n') from -= 1;
        t.delete(from, to - from);
        n++;
      }
    });
    this.reindex(parent, actor.sub);
    return n;
  }

  /**
   * Split `parent` at `offset`: the rest of its body becomes a new section,
   * mounted at the cut. Comments on the moved text follow it; a comment
   * spanning the cut keeps its start and ends in the new section.
   */
  split(parent: string, actor: Actor, offset: number, opts: { title?: string } = {}): DocMeta {
    const { doc } = this.docs.require(parent, actor, 'editor');
    const text = this.docs.text(parent);
    if (!(Number.isInteger(offset) && offset >= 0 && offset <= text.length)) throw new Fault(400, `Split position ${offset} is outside the document (length ${text.length}).`);
    const inMarker = scanMounts(text).find((m) => offset > m.from && offset < m.to);
    if (inMarker) throw new Fault(400, 'Cannot split inside a mount line.');
    let rest = text.slice(offset);
    const strippedNl = rest.startsWith('\n') ? 1 : 0;
    rest = rest.slice(strippedNl);
    const head = text.slice(0, offset);
    const child = this.docs.createNode(actor, { title: opts.title ?? '', content: rest, type: doc.type, owner: doc.ownerSub });
    const plan = this.comments?.planMove(parent) ?? [];
    const sep = head.length === 0 || head.endsWith('\n') ? '' : '\n';
    this.docs.edit(parent, { sub: actor.sub, via: actor.via ?? 'mcpl', label: 'Split a section off' }, (t) => {
      t.delete(offset, text.length - offset);
      t.insert(offset, `${sep}${marker(child.id)}\n`); // a line of the parent's own after the section, so text can follow it
    });
    this.comments?.applyMove(plan, (node, off, side) => {
      if (node !== parent) return null;
      if (off > offset || (off === offset && side === 'start')) return { node: child.id, offset: Math.max(0, off - offset - strippedNl) };
      return null;
    });
    this.reindex(parent, actor.sub);
    return this.docs.get(child.id)!;
  }

  /**
   * Merge `child` back into `parent` at its mount line: the body replaces the
   * marker. A child mounted elsewhere too is COPIED and keeps its comments;
   * otherwise its comments move into the parent and it is left as an orphan.
   */
  merge(parent: string, child: string, actor: Actor): { copied: boolean } {
    this.docs.require(parent, actor, 'editor');
    this.docs.require(child, actor, 'viewer');
    const text = this.docs.text(parent);
    const m = scanMounts(text).find((x) => x.child === child);
    if (!m) throw new Fault(404, `${child} is not mounted in ${parent}.`);
    const body = this.docs.text(child);
    const copied = this.mountCount(child) > 1;
    const plan = copied ? [] : (this.comments?.planMove(child) ?? []);
    this.docs.edit(parent, { sub: actor.sub, via: actor.via ?? 'mcpl', label: copied ? 'Copied a section in' : 'Merged a section in' }, (t) => {
      t.delete(m.from, m.to - m.from);
      t.insert(m.from, body);
    });
    if (!copied) this.comments?.applyMove(plan, (node, off) => (node === child ? { node: parent, offset: m.from + off } : null));
    this.reindex(parent, actor.sub);
    return { copied };
  }

  /** Access an actor derives for `child` through its parents (for messages). */
  explainAccess(child: string, actor: Pick<Actor, 'sub' | 'admin'>): string | null {
    for (const p of this.parentsOf(child)) {
      const r = this.docs.role(p, actor);
      if (r) { const d = this.docs.get(p); return `through “${d?.title || d?.id}”`; }
    }
    return null;
  }
}

export const roleCap = (r: Role | null): Role | null => (r && atLeast(r, 'editor') ? 'editor' : r);
