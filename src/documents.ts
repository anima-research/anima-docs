// Documents: metadata + access control in SQLite, live content in Yjs.
//
// Content is one Y.Text ("body") holding markdown. Docs run with gc disabled so
// any earlier state can be rendered from a snapshot — that is what lets each
// agent be shown "what changed since you last looked", with attribution.

import { EventEmitter } from 'node:events';
import { randomBytes, randomInt } from 'node:crypto';
import * as Y from 'yjs';
import { diffChars, diffLines } from 'diff';
import type { DB } from './db.js';
import { Fault } from './auth.js';
import { isGuest, type Actor, type Principals } from './principals.js';

export type Role = 'viewer' | 'commenter' | 'editor' | 'owner';
export type GeneralAccess = 'restricted' | 'viewer' | 'commenter' | 'editor';
const RANK: Record<Role, number> = { viewer: 1, commenter: 2, editor: 3, owner: 4 };
export const atLeast = (role: Role | null, min: Role) => !!role && RANK[role] >= RANK[min];

export interface DocMeta {
  id: string;
  title: string;
  ownerSub: string;
  generalAccess: GeneralAccess;
  createdAt: number;
  updatedAt: number;
  rev: number;
}

export type LinkAudience = 'anyone' | 'members';
export interface ShareLink {
  id: string; docId: string; key: string; role: Role; audience: LinkAudience; label: string | null;
  createdBy: string; createdAt: number; expiresAt: number | null; revokedAt: number | null;
  /** How many people (or agents) have opened it. */
  holders: number; active: boolean;
}
type LinkRow = { id: string; doc_id: string; key: string; role: Role; audience: LinkAudience; label: string | null; created_by: string; created_at: number; expires_at: number | null; revoked_at: number | null };

/** Transaction origin carried on every change so listeners know who did it. */
export interface ChangeOrigin {
  sub: string;
  via: 'web' | 'mcpl' | 'http' | 'system';
  /** Browser connection id, so the room doesn't echo an update to its sender. */
  conn?: string;
}

export interface DocChange {
  docId: string;
  origin: ChangeOrigin;
  added: number;
  removed: number;
  /** Ranges [from, to) in the post-change text that were inserted or touched. */
  ranges: [number, number][];
  /** Inserted text (for gate pattern matching), truncated. */
  inserted: string;
}

type DocRow = { id: string; title: string; owner_sub: string; general_access: GeneralAccess; created_at: number; updated_at: number; rev: number; deleted_at: number | null };
const meta = (r: DocRow): DocMeta => ({ id: r.id, title: r.title, ownerSub: r.owner_sub, generalAccess: r.general_access, createdAt: r.created_at, updatedAt: r.updated_at, rev: r.rev });

const COMPACT_EVERY = 400;
export const MAX_DOC_CHARS = 2_000_000;
const MAX_UPDATE_BYTES = 4 * 1024 * 1024;

type Part = { value: string; added?: boolean; removed?: boolean };

/** Character diff, bounded in time; falls back to keeping the common prefix and suffix. */
export function minimalParts(prev: string, next: string): Part[] {
  const parts = (prev.length + next.length > 40_000 ? diffLines(prev, next, { timeout: 250 }) : diffChars(prev, next, { timeout: 250 })) as Part[] | undefined;
  if (parts) return parts;
  let p = 0;
  while (p < prev.length && p < next.length && prev[p] === next[p]) p++;
  let q = 0;
  while (q < prev.length - p && q < next.length - p && prev[prev.length - 1 - q] === next[next.length - 1 - q]) q++;
  const out: Part[] = [];
  if (p) out.push({ value: prev.slice(0, p) });
  if (prev.length - p - q > 0) out.push({ value: prev.slice(p, prev.length - q), removed: true });
  if (next.length - p - q > 0) out.push({ value: next.slice(p, next.length - q), added: true });
  if (q) out.push({ value: prev.slice(prev.length - q) });
  return out;
}

function applyParts(text: Y.Text, from: number, parts: Part[]) {
  let pos = from;
  for (const p of parts) {
    if (p.added) { text.insert(pos, p.value); pos += p.value.length; }
    else if (p.removed) text.delete(pos, p.value.length);
    else pos += p.value.length;
  }
}

/** Yjs's DeleteSet (not exported as a type). */
export type DeleteSet = ReturnType<typeof Y.createDeleteSet>;

export class Documents extends EventEmitter {
  private live = new Map<string, Y.Doc>();
  private lastUsed = new Map<string, number>();
  private pins = new Map<string, number>();
  private failed = new Set<string>();
  /** `${docId}\0${client}` → sub cache (authoritative copy in yclients). */
  private clientOwner = new Map<string, string>();

  constructor(private db: DB, private principals: Principals, private opts: { defaultAccess: GeneralAccess }) {
    super();
    this.setMaxListeners(100);
  }

  // ------------------------------------------------------------------ metadata

  get(id: string): DocMeta | null {
    const r = this.db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL').get(id) as DocRow | undefined;
    return r ? meta(r) : null;
  }

  /**
   * Role from ownership, a grant, or general access (members only) — never
   * from a link. Sharing power (granting access, making links) comes only
   * from this, so access that arrived through a link can't be turned into
   * access that outlives it.
   */
  baseRole(docId: string, actor: Pick<Actor, 'sub' | 'admin'>): Role | null {
    const d = this.get(docId);
    if (!d || isGuest(actor.sub)) return null;
    if (actor.admin || d.ownerSub === actor.sub) return 'owner';
    let best: Role | null = null;
    const acl = (this.db.prepare('SELECT role FROM doc_acl WHERE doc_id = ? AND sub = ?').get(docId, actor.sub) as { role: Role } | undefined)?.role ?? null;
    if (acl) best = acl;
    if (d.generalAccess !== 'restricted' && (!best || RANK[d.generalAccess as Role] > RANK[best])) best = d.generalAccess as Role;
    return best;
  }

  /**
   * The actor's role on a document, or null: the best of their base role and
   * any active share link they have opened. Admins are owners everywhere.
   */
  role(docId: string, actor: Pick<Actor, 'sub' | 'admin'>): Role | null {
    const base = this.baseRole(docId, actor);
    if (base === 'owner') return base;
    let best: Role | null = base;
    const held = this.db.prepare(`SELECT l.* FROM link_holders h JOIN doc_links l ON l.id = h.link_id
        WHERE h.sub = ? AND h.doc_id = ? AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > ?)`).all(actor.sub, docId, Date.now()) as LinkRow[];
    for (const l of held) if ((!best || RANK[l.role] > RANK[best]) && this.linkBacked(l)) best = l.role;
    return best;
  }

  /**
   * A link works only while whoever made it could still make it: an owner for
   * "anyone" links, an editor for "members" links (by base role, and not
   * blocked). Removing someone's access therefore also ends their links.
   */
  private linkBacked(l: Pick<LinkRow, 'doc_id' | 'created_by' | 'audience'>): boolean {
    const p = this.principals.get(l.created_by);
    const standing = p ? this.principals.standing(p.sub, [], p.issuer) : null;
    if (!standing) return false;
    return atLeast(this.baseRole(l.doc_id, { sub: p!.sub, admin: standing.admin }), l.audience === 'anyone' ? 'owner' : 'editor');
  }

  /** Throws 404 for no access (absent and inaccessible look the same), 403 for too little. */
  require(docId: string, actor: Pick<Actor, 'sub' | 'admin'>, min: Role): { doc: DocMeta; role: Role } {
    const doc = this.get(docId);
    const role = doc ? this.role(docId, actor) : null;
    if (!doc || !role) throw new Fault(404, `No document ${docId} (or you have no access to it).`);
    if (!atLeast(role, min)) throw new Fault(403, `You are a ${role} on “${doc.title}”; this needs ${min} access.`);
    return { doc, role };
  }

  create(actor: Actor, title: string, content = ''): DocMeta {
    if (isGuest(actor.sub)) throw new Fault(403, 'Sign in with Archipelago to create documents.');
    const id = `d${randomBytes(6).toString('base64url').replace(/[-_]/g, 'x')}`;
    const now = Date.now();
    const clean = title.trim().slice(0, 300) || 'Untitled document';
    this.db.prepare(`INSERT INTO documents (id, title, owner_sub, general_access, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, clean, actor.sub, this.opts.defaultAccess, now, now);
    if (content) this.edit(id, actor, (text) => text.insert(0, content));
    this.emit('meta', { docId: id, kind: 'created', by: actor.sub });
    return this.get(id)!;
  }

  rename(docId: string, actor: Actor, title: string): DocMeta {
    this.require(docId, actor, 'editor');
    const clean = title.trim().slice(0, 300);
    if (!clean) throw new Fault(400, 'Title cannot be empty.');
    this.db.prepare('UPDATE documents SET title = ?, updated_at = ? WHERE id = ?').run(clean, Date.now(), docId);
    this.emit('meta', { docId, kind: 'renamed', by: actor.sub });
    return this.get(docId)!;
  }

  remove(docId: string, actor: Actor): void {
    this.require(docId, actor, 'owner');
    this.db.prepare('UPDATE documents SET deleted_at = ? WHERE id = ?').run(Date.now(), docId);
    this.emit('meta', { docId, kind: 'deleted', by: actor.sub });
    const doc = this.live.get(docId);
    if (doc) { doc.destroy(); this.live.delete(docId); }
  }

  list(actor: Actor, opts: { query?: string; filter?: 'all' | 'owned' | 'shared'; limit?: number } = {}): (DocMeta & { role: Role })[] {
    const q = opts.query ? `%${opts.query.replace(/[%_]/g, '')}%` : '%';
    const rows = this.db.prepare(`
      SELECT d.* FROM documents d
      WHERE d.deleted_at IS NULL AND d.title LIKE @q
        AND (@admin = 1 OR d.owner_sub = @sub OR (@guest = 0 AND d.general_access != 'restricted')
             OR EXISTS (SELECT 1 FROM doc_acl a WHERE a.doc_id = d.id AND a.sub = @sub)
             OR EXISTS (SELECT 1 FROM link_holders h JOIN doc_links l ON l.id = h.link_id
                        WHERE h.doc_id = d.id AND h.sub = @sub AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > @now)))
      ORDER BY d.updated_at DESC LIMIT @limit
    `).all({ q, sub: actor.sub, admin: actor.admin && !isGuest(actor.sub) ? 1 : 0, guest: isGuest(actor.sub) ? 1 : 0, now: Date.now(), limit: Math.min(opts.limit ?? 100, 500) }) as DocRow[];
    return rows.map(meta)
      .map((d) => ({ ...d, role: this.role(d.id, actor)! }))
      .filter((d) => d.role && (opts.filter === 'owned' ? d.ownerSub === actor.sub : opts.filter === 'shared' ? d.ownerSub !== actor.sub : true));
  }

  /** Full-text search over live content of accessible documents. */
  search(actor: Actor, query: string, limit = 20): { doc: DocMeta; line: number; snippet: string }[] {
    const needle = query.toLowerCase();
    if (!needle.trim()) return [];
    const out: { doc: DocMeta; line: number; snippet: string }[] = [];
    for (const d of this.list(actor, { limit: 500 })) {
      const text = this.text(d.id);
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && out.length < limit; i++) {
        if (lines[i].toLowerCase().includes(needle)) out.push({ doc: d, line: i + 1, snippet: lines[i].trim().slice(0, 240) });
      }
      if (d.title.toLowerCase().includes(needle) && !out.some((o) => o.doc.id === d.id)) out.push({ doc: d, line: 0, snippet: `(title) ${d.title}` });
      if (out.length >= limit) break;
    }
    return out;
  }

  // ------------------------------------------------------------------ sharing

  acl(docId: string): { sub: string; role: Role; grantedBy: string; grantedAt: number }[] {
    return (this.db.prepare('SELECT sub, role, granted_by, granted_at FROM doc_acl WHERE doc_id = ? ORDER BY granted_at').all(docId) as any[])
      .map((r) => ({ sub: r.sub, role: r.role, grantedBy: r.granted_by, grantedAt: r.granted_at }));
  }

  share(docId: string, actor: Actor, granteeSub: string, role: Role | 'none'): void {
    if (isGuest(actor.sub)) throw new Fault(403, 'Sign in with Archipelago to share documents.');
    if (isGuest(granteeSub)) throw new Fault(400, 'Guests can only be given access through a share link.');
    const { doc, role: current } = this.require(docId, actor, 'viewer');
    const mine = this.baseRole(docId, actor);
    if (!atLeast(mine, 'editor')) {
      throw new Fault(403, atLeast(current, 'editor') ? 'Sharing needs editor access given to you directly; access through a link does not include sharing.' : `You are a ${current} on “${doc.title}”; sharing needs editor access.`);
    }
    if (granteeSub === actor.sub && mine !== 'owner') throw new Fault(403, 'You cannot change your own access. Ask an owner.');
    if (granteeSub === doc.ownerSub) throw new Fault(400, 'The owner always has owner access.');
    if (role !== 'none' && !['viewer', 'commenter', 'editor', 'owner'].includes(role)) throw new Fault(400, 'role must be viewer, commenter, editor, owner or none');
    // Editors may share up to editor; only owners grant ownership or remove people.
    if (mine !== 'owner' && (role === 'owner' || role === 'none')) throw new Fault(403, 'Only an owner can grant ownership or remove access.');
    if (role === 'owner') {
      // Transfer: the new owner becomes owner_sub; the previous owner keeps editor access.
      this.db.transaction(() => {
        this.db.prepare('UPDATE documents SET owner_sub = ? WHERE id = ?').run(granteeSub, docId);
        this.db.prepare('DELETE FROM doc_acl WHERE doc_id = ? AND sub = ?').run(docId, granteeSub);
        this.db.prepare(`INSERT OR REPLACE INTO doc_acl (doc_id, sub, role, granted_by, granted_at) VALUES (?, ?, 'editor', ?, ?)`).run(docId, doc.ownerSub, actor.sub, Date.now());
      })();
    } else if (role === 'none') {
      this.db.prepare('DELETE FROM doc_acl WHERE doc_id = ? AND sub = ?').run(docId, granteeSub);
    } else {
      this.db.prepare(`INSERT INTO doc_acl (doc_id, sub, role, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(doc_id, sub) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, granted_at = excluded.granted_at`)
        .run(docId, granteeSub, role, actor.sub, Date.now());
    }
    this.emit('share', { docId, sub: granteeSub, role, by: actor.sub });
  }

  setGeneralAccess(docId: string, actor: Actor, access: GeneralAccess): void {
    this.require(docId, actor, 'owner');
    if (!['restricted', 'viewer', 'commenter', 'editor'].includes(access)) throw new Fault(400, 'access must be restricted, viewer, commenter or editor');
    this.db.prepare('UPDATE documents SET general_access = ? WHERE id = ?').run(access, docId);
    this.emit('share', { docId, sub: null, role: access, by: actor.sub });
  }

  // ------------------------------------------------------------------ share links

  /**
   * Create a share link. "anyone" links work without signing in (visitors
   * become guests) and only owners make them; "members" links need an
   * Archipelago sign-in and editors may make them, as they may share.
   */
  createLink(docId: string, actor: Actor, opts: { role: Role; audience: LinkAudience; label?: string | null; expiresInDays?: number | null }): ShareLink {
    if (isGuest(actor.sub)) throw new Fault(403, 'Sign in with Archipelago to make share links.');
    if (!['viewer', 'commenter', 'editor'].includes(opts.role)) throw new Fault(400, 'A link can grant viewer, commenter or editor.');
    if (opts.audience !== 'anyone' && opts.audience !== 'members') throw new Fault(400, 'who must be anyone or members.');
    const { doc, role } = this.require(docId, actor, 'viewer');
    const need: Role = opts.audience === 'anyone' ? 'owner' : 'editor';
    if (!atLeast(this.baseRole(docId, actor), need)) {
      throw new Fault(403, need === 'owner' ? 'Only an owner can make links that work without signing in.'
        : atLeast(role, 'editor') ? 'Making links needs editor access given to you directly; access through a link does not include sharing.'
        : `You are a ${role} on “${doc.title}”; making links needs editor access.`);
    }
    const days = opts.expiresInDays ?? null;
    if (days !== null && (!Number.isFinite(days) || days < 1 / 24 || days > 365)) throw new Fault(400, 'Expiry must be between 1 hour and 365 days, or never.');
    const active = (this.db.prepare(`SELECT count(*) AS n FROM doc_links WHERE doc_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`).get(docId, Date.now()) as { n: number }).n;
    if (active >= 50) throw new Fault(409, 'This document already has 50 active links. Revoke some first.');
    const id = `l${randomBytes(6).toString('base64url').replace(/[-_]/g, 'x')}`;
    const key = randomBytes(18).toString('base64url');
    const now = Date.now();
    const label = (opts.label ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || null;
    this.db.prepare(`INSERT INTO doc_links (id, doc_id, key, role, audience, label, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, doc.id, key, opts.role, opts.audience, label, actor.sub, now, days === null ? null : now + Math.round(days * 86400_000));
    this.emit('share', { docId, sub: null, role: `link:${opts.role}`, by: actor.sub });
    return this.linkById(id)!;
  }

  /** Links the actor may see: all of them for owners, their own for others. Revoked and expired ones are left out. */
  links(docId: string, actor: Actor): ShareLink[] {
    const { role } = this.require(docId, actor, 'viewer');
    if (isGuest(actor.sub)) return [];
    const rows = this.db.prepare(`SELECT * FROM doc_links WHERE doc_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at`).all(docId, Date.now()) as LinkRow[];
    return rows.filter((r) => role === 'owner' || r.created_by === actor.sub).map((r) => this.linkView(r));
  }

  /** Whether the document has an active "anyone with the link" link (for the share button). */
  hasPublicLink(docId: string): boolean {
    const rows = this.db.prepare(`SELECT * FROM doc_links WHERE doc_id = ? AND audience = 'anyone' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`).all(docId, Date.now()) as LinkRow[];
    return rows.some((r) => this.linkBacked(r));
  }

  /** Links that expired in (since, now]: their holders' access just ended. */
  expiredBetween(since: number, now = Date.now()): string[] {
    return (this.db.prepare('SELECT DISTINCT doc_id FROM doc_links WHERE revoked_at IS NULL AND expires_at > ? AND expires_at <= ?').all(since, now) as { doc_id: string }[]).map((r) => r.doc_id);
  }

  /** Revoke a link (owners, or whoever made it). Everyone who came in through it loses that access at once. */
  revokeLink(ref: string, actor: Actor): ShareLink {
    const r = this.linkRow(ref);
    if (!r || r.revoked_at) throw new Fault(404, 'No such link (or it was already revoked).');
    const { role } = this.require(r.doc_id, actor, 'viewer');
    if (role !== 'owner' && r.created_by !== actor.sub) throw new Fault(403, 'Only an owner or the person who made a link can revoke it.');
    this.db.prepare('UPDATE doc_links SET revoked_at = ?, revoked_by = ? WHERE id = ?').run(Date.now(), actor.sub, r.id);
    this.emit('share', { docId: r.doc_id, sub: null, role: 'link-revoked', by: actor.sub });
    return this.linkView({ ...r, revoked_at: Date.now() });
  }

  /** What a link leads to, for a visitor who hasn't opened it yet. Titles are shown for "anyone" links only. */
  peekLink(key: string): { active: boolean; audience?: LinkAudience; role?: Role; title?: string } {
    const r = this.db.prepare('SELECT * FROM doc_links WHERE key = ?').get(String(key)) as LinkRow | undefined;
    if (!r || !this.linkActive(r) || !this.get(r.doc_id)) return { active: false };
    return { active: true, audience: r.audience, role: r.role, ...(r.audience === 'anyone' ? { title: this.get(r.doc_id)!.title } : {}) };
  }

  /**
   * Open a link: the actor holds it from now on, so the document stays
   * reachable at its normal address for as long as the link is active.
   */
  redeemLink(key: string, actor: Pick<Actor, 'sub' | 'admin'>): { doc: DocMeta; role: Role; link: ShareLink } {
    const r = this.db.prepare('SELECT * FROM doc_links WHERE key = ?').get(String(key)) as LinkRow | undefined;
    const doc = r ? this.get(r.doc_id) : null;
    if (!r || !doc || !this.linkActive(r)) throw new Fault(404, 'This link no longer works. It may have expired or been turned off; ask whoever sent it for a new one.');
    if (r.audience === 'members' && isGuest(actor.sub)) throw new Fault(401, 'Sign in with Archipelago to open this link.');
    const now = Date.now();
    this.db.prepare(`INSERT INTO link_holders (link_id, sub, doc_id, first_at, last_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(link_id, sub) DO UPDATE SET last_at = excluded.last_at`).run(r.id, actor.sub, r.doc_id, now, now);
    return { doc, role: this.role(r.doc_id, actor)!, link: this.linkView(r) };
  }

  /** A link by id, key, or full URL. */
  linkById(ref: string): ShareLink | null {
    const r = this.linkRow(ref);
    return r ? this.linkView(r) : null;
  }

  private linkRow(ref: string): LinkRow | null {
    const s = String(ref ?? '').trim();
    if (!s || s.length > 2048) return null;
    let key: string | null = null;
    if (s.includes('/l/')) {
      try { key = /^\/l\/([A-Za-z0-9_-]{20,40})\/?$/.exec(new URL(s, 'http://x').pathname)?.[1] ?? null; } catch { key = null; }
    }
    return (key ? this.db.prepare('SELECT * FROM doc_links WHERE key = ?').get(key)
      : this.db.prepare('SELECT * FROM doc_links WHERE id = ? OR key = ?').get(s, s)) as LinkRow | undefined ?? null;
  }

  private linkActive(r: LinkRow) { return !r.revoked_at && (!r.expires_at || r.expires_at > Date.now()) && this.linkBacked(r); }

  private linkView(r: LinkRow): ShareLink {
    const holders = (this.db.prepare('SELECT count(*) AS n FROM link_holders WHERE link_id = ?').get(r.id) as { n: number }).n;
    return { id: r.id, docId: r.doc_id, key: r.key, role: r.role, audience: r.audience, label: r.label, createdBy: r.created_by, createdAt: r.created_at,
      expiresAt: r.expires_at, revokedAt: r.revoked_at, holders, active: this.linkActive(r) };
  }

  // ------------------------------------------------------------------ content

  /** The live Y.Doc for a document, loaded on first use. */
  ydoc(docId: string): Y.Doc {
    let doc = this.live.get(docId);
    this.lastUsed.set(docId, Date.now());
    if (doc) return doc;
    if (!this.get(docId)) throw new Fault(404, `No document ${docId}.`);
    doc = new Y.Doc({ gc: false });
    const state = this.db.prepare('SELECT data, upto_id FROM doc_state WHERE doc_id = ?').get(docId) as { data: Buffer; upto_id: number } | undefined;
    if (state) Y.applyUpdate(doc, state.data, 'load');
    const updates = this.db.prepare('SELECT data FROM doc_updates WHERE doc_id = ? AND id > ? ORDER BY id').all(docId, state?.upto_id ?? 0) as { data: Buffer }[];
    for (const u of updates) Y.applyUpdate(doc, u.data, 'load');
    this.wire(docId, doc);
    this.live.set(docId, doc);
    return doc;
  }

  text(docId: string): string {
    return this.ydoc(docId).getText('body').toString();
  }

  /** Keep a document loaded while something (a browser room) holds it. */
  pin(docId: string) { this.pins.set(docId, (this.pins.get(docId) ?? 0) + 1); }
  unpin(docId: string) { const n = (this.pins.get(docId) ?? 1) - 1; if (n > 0) this.pins.set(docId, n); else this.pins.delete(docId); }

  /** Unload documents nobody has touched for `idleMs` (gc is off, so loaded docs carry full history). */
  sweep(idleMs = 10 * 60_000) {
    const now = Date.now();
    for (const docId of [...this.live.keys()]) {
      if (this.pins.has(docId) || now - (this.lastUsed.get(docId) ?? 0) < idleMs) continue;
      this.unload(docId);
    }
  }

  private wire(docId: string, doc: Y.Doc) {
    const insertUpdate = this.db.prepare('INSERT INTO doc_updates (doc_id, data, sub, created_at) VALUES (?, ?, ?, ?)');
    const bump = this.db.prepare('UPDATE documents SET rev = rev + 1, updated_at = ? WHERE id = ?');
    const insertDeletion = this.db.prepare('INSERT INTO doc_deletions (doc_id, client, clock, len, sub, at) VALUES (?, ?, ?, ?, ?, ?)');
    const activity = this.db.prepare(`INSERT INTO doc_activity (doc_id, sub, minute, added, removed) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(doc_id, sub, minute) DO UPDATE SET added = added + excluded.added, removed = removed + excluded.removed`);
    let sinceCompact = 0;
    // Nothing may throw out of a Yjs listener: a throw leaves Yjs's cleanup
    // queue wedged and every later update silently unpersisted. A persistence
    // failure instead marks the document failed; it is unloaded after the
    // transaction so the next load (and every client's resync) starts from disk.
    const guard = (what: string, fn: () => void) => {
      try { fn(); } catch (e) {
        console.error(`[documents] ${docId}: ${what} failed:`, (e as Error).message);
        this.failed.add(docId);
      }
    };

    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'load' || this.failed.has(docId)) return;
      const o = origin as ChangeOrigin | undefined;
      guard('persist', () => {
        const now = Date.now();
        insertUpdate.run(docId, Buffer.from(update), o?.sub ?? null, now);
        bump.run(now, docId);
        if (++sinceCompact >= COMPACT_EVERY) { sinceCompact = 0; this.compact(docId, doc); }
      });
      if (this.failed.has(docId)) return;
      guard('broadcast', () => this.emit('update', { docId, update, origin: o }));
      this.failed.delete(docId); // a listener's failure is not a persistence failure
    });

    // Yjs records who inserted an item (client id) but not who deleted it.
    // The transaction's delete set holds only items newly deleted by it.
    doc.on('afterTransaction', (txn: Y.Transaction) => {
      const o = txn.origin as ChangeOrigin | undefined;
      if (!o || typeof o !== 'object' || !o.sub || txn.deleteSet.clients.size === 0) return;
      guard('deletion log', () => {
        const now = Date.now();
        for (const [client, items] of txn.deleteSet.clients) for (const it of items) insertDeletion.run(docId, client, it.clock, it.len, o.sub, now);
      });
    });

    doc.getText('body').observe((event, txn) => {
      const o = txn.origin as ChangeOrigin | undefined;
      if (!o || typeof o !== 'object' || !o.sub) return;
      let pos = 0, added = 0, removed = 0, inserted = '';
      const ranges: [number, number][] = [];
      for (const op of event.delta) {
        if (op.retain) pos += op.retain;
        else if (typeof op.insert === 'string') {
          ranges.push([pos, pos + op.insert.length]);
          added += op.insert.length;
          if (inserted.length < 4000) inserted += op.insert.slice(0, 4000 - inserted.length);
          pos += op.insert.length;
        } else if (op.delete) { ranges.push([pos, pos]); removed += op.delete; }
      }
      guard('activity', () => activity.run(docId, o.sub, Math.floor(Date.now() / 60_000), added, removed));
      const change: DocChange = { docId, origin: o, added, removed, ranges, inserted };
      try { this.emit('change', change); } catch (e) { console.error(`[documents] ${docId}: change listener failed:`, e); }
    });
  }

  /** After a transaction: if persistence failed, drop the in-memory copy and tell rooms to resync. */
  private settle(docId: string) {
    if (!this.failed.has(docId)) return;
    this.failed.delete(docId);
    this.unload(docId);
    this.emit('failed', { docId });
    throw new Fault(503, 'The change could not be saved; please retry.');
  }

  private compact(docId: string, doc: Y.Doc) {
    const upto = (this.db.prepare('SELECT max(id) AS m FROM doc_updates WHERE doc_id = ?').get(docId) as { m: number | null }).m;
    if (!upto) return;
    const state = Buffer.from(Y.encodeStateAsUpdate(doc));
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO doc_state (doc_id, data, upto_id) VALUES (?, ?, ?)
        ON CONFLICT(doc_id) DO UPDATE SET data = excluded.data, upto_id = excluded.upto_id`).run(docId, state, upto);
      this.db.prepare('DELETE FROM doc_updates WHERE doc_id = ? AND id <= ?').run(docId, upto);
    })();
  }

  // ------------------------------------------------------------------ attribution

  /** Owner of a Yjs client id within one document. */
  ownerOfClient(docId: string, client: number): string | null {
    const k = `${docId}\0${client}`;
    const cached = this.clientOwner.get(k);
    if (cached) return cached;
    const r = this.db.prepare('SELECT sub FROM yclients WHERE doc_id = ? AND client = ?').get(docId, client) as { sub: string } | undefined;
    if (r) this.clientOwner.set(k, r.sub);
    return r?.sub ?? null;
  }

  private claimClient(docId: string, client: number, sub: string, serverSide = false) {
    this.db.prepare('INSERT OR IGNORE INTO yclients (doc_id, client, sub, server_side, first_seen) VALUES (?, ?, ?, ?, ?)').run(docId, client, sub, serverSide ? 1 : 0, Date.now());
    this.clientOwner.delete(`${docId}\0${client}`);
  }

  /** The Yjs client id this service uses when editing `docId` on `sub`'s behalf. */
  serverClientFor(docId: string, sub: string): number {
    const r = this.db.prepare('SELECT client FROM yclients WHERE doc_id = ? AND sub = ? AND server_side = 1').get(docId, sub) as { client: number } | undefined;
    if (r) return r.client;
    const known = this.live.has(docId) ? Y.decodeStateVector(Y.encodeStateVector(this.ydoc(docId))) : new Map<number, number>();
    for (;;) {
      const client = randomInt(1, 2 ** 31);
      if (!this.ownerOfClient(docId, client) && !known.has(client)) { this.claimClient(docId, client, sub, true); return client; }
    }
  }

  /** Who deleted the item with this id (null if unknown). */
  deleterOf(docId: string, client: number, clock: number): string | null {
    const r = this.db.prepare(`SELECT sub FROM doc_deletions WHERE doc_id = ? AND client = ? AND clock <= ? AND clock + len > ? ORDER BY at LIMIT 1`)
      .get(docId, client, clock, clock) as { sub: string } | undefined;
    return r?.sub ?? null;
  }

  /**
   * Apply an update from a browser, after checking it completely:
   *
   * - every new struct comes from a client id owned by the sender in this
   *   document (claimed on first use) — content under someone else's id would
   *   forge authorship;
   * - only plain text under the root "body" (no embeds, formats, nested or
   *   other root types): agents and anchors index the text by characters;
   * - nothing would be left pending: no gaps, no references to unknown items,
   *   no deletions of items that don't exist yet. A parked deletion would fire
   *   later inside someone else's transaction and be attributed to them.
   */
  applyClientUpdate(docId: string, update: Uint8Array, origin: ChangeOrigin): void {
    if (update.byteLength > MAX_UPDATE_BYTES) throw new Fault(413, 'Update too large.');
    const doc = this.ydoc(docId);
    const decoded = Y.decodeUpdate(update);
    const known = Y.decodeStateVector(Y.encodeStateVector(doc));
    const reach = new Map(known); // state after this update, per client
    const claims: number[] = [];
    let adds = 0;
    for (const s of decoded.structs) {
      const { client, clock } = s.id;
      if (s instanceof Y.Skip) throw new Fault(400, 'Update has gaps.');
      const have = reach.get(client) ?? 0;
      if (clock > have) throw new Fault(400, 'Update depends on content this server does not have.');
      reach.set(client, Math.max(have, clock + s.length));
      if (clock + s.length <= (known.get(client) ?? 0)) continue; // already known: a no-op re-send
      const owner = this.ownerOfClient(docId, client);
      if (owner === null) claims.push(client);
      else if (owner !== origin.sub) throw new Fault(403, 'Update carries content attributed to another principal.');
      if (s instanceof Y.Item) {
        const content = s.content;
        if (!(content instanceof Y.ContentString) && !(content instanceof Y.ContentDeleted)) throw new Fault(400, 'Only plain text is accepted.');
        if (content instanceof Y.ContentString) adds += content.str.length;
        // Decoded items name their root type by string; anything else is a nested type.
        const parent = s.parent as unknown;
        if (s.parentSub !== null || (parent !== null && parent !== 'body')) throw new Fault(400, 'Only plain text is accepted.');
      }
    }
    // References: every origin must exist after this update.
    const exists = (id: Y.ID | null) => !id || id.clock < (reach.get(id.client) ?? 0);
    for (const s of decoded.structs) {
      if (s instanceof Y.Item && (!exists(s.origin) || !exists(s.rightOrigin))) throw new Fault(400, 'Update references unknown content.');
    }
    for (const [client, items] of decoded.ds.clients) {
      for (const it of items) if (it.clock + it.len > (reach.get(client) ?? 0)) throw new Fault(400, 'Update deletes content that does not exist.');
    }
    if (adds && doc.getText('body').length + adds > MAX_DOC_CHARS) throw new Fault(413, `Documents are limited to ${MAX_DOC_CHARS.toLocaleString('en')} characters.`);
    for (const c of claims) this.claimClient(docId, c, origin.sub);
    Y.applyUpdate(doc, update, origin);
    // Backstop: nothing may be left pending (it would fire inside a later transaction).
    if (doc.store.pendingStructs || doc.store.pendingDs) {
      doc.store.pendingStructs = null;
      doc.store.pendingDs = null;
      this.failed.add(docId);
    }
    this.settle(docId);
  }

  /**
   * True if applying `update` would change nothing: every struct is already
   * known and every deletion already applied. A read-only client's sync step 2
   * normally looks like this (it echoes the delete set it was given).
   */
  isNoopUpdate(docId: string, update: Uint8Array): boolean {
    const doc = this.ydoc(docId);
    const d = Y.decodeUpdate(update);
    const known = Y.decodeStateVector(Y.encodeStateVector(doc));
    for (const s of d.structs) if (s.id.clock + s.length > (known.get(s.id.client) ?? 0)) return false;
    const mine = Y.createDeleteSetFromStructStore(doc.store);
    for (const [client, items] of d.ds.clients) {
      const have = mine.clients.get(client) ?? [];
      for (const it of items) {
        let covered = 0;
        for (const h of have) {
          const lo = Math.max(h.clock, it.clock), hi = Math.min(h.clock + h.len, it.clock + it.len);
          if (hi > lo) covered += hi - lo;
        }
        if (covered < it.len) return false;
      }
    }
    return true;
  }

  /**
   * Edit on an actor's behalf with the actor's own Yjs client id, so authorship
   * is the actor's (not the server's) everywhere: cursors, history, agent diffs.
   * Returns the transaction's delete set and the client id used.
   */
  edit(docId: string, actor: Pick<Actor, 'sub'> & { via?: ChangeOrigin['via'] }, fn: (text: Y.Text) => void): { client: number; deleteSet: DeleteSet } {
    const doc = this.ydoc(docId);
    const client = this.serverClientFor(docId, actor.sub);
    const saved = doc.clientID;
    let ds: DeleteSet = Y.createDeleteSet();
    doc.clientID = client;
    try {
      doc.transact((txn) => {
        fn(doc.getText('body'));
        ds = txn.deleteSet;
      }, { sub: actor.sub, via: actor.via ?? 'mcpl' } satisfies ChangeOrigin);
    } finally {
      doc.clientID = saved;
    }
    this.settle(docId);
    return { client, deleteSet: ds };
  }

  /**
   * Replace [from, to) with `next` using a minimal character diff, so text that
   * didn't change keeps its identity (comment anchors, others' cursors, and
   * attribution all survive a large replacement). The diff is time-bounded;
   * past the bound only the common prefix and suffix are kept.
   */
  static replaceMinimal(text: Y.Text, from: number, to: number, next: string, current?: string) {
    const prev = (current ?? text.toString()).slice(from, to);
    if (prev === next) return;
    applyParts(text, from, minimalParts(prev, next));
  }

  /** Apply the same replacement at many positions (descending), computing the diff once. */
  static replaceEach(text: Y.Text, positions: number[], oldText: string, next: string) {
    const parts = minimalParts(oldText, next);
    for (const at of [...positions].sort((a, b) => b - a)) applyParts(text, at, parts);
  }

  // ------------------------------------------------------------------ snapshots

  snapshot(docId: string): Y.Snapshot {
    return Y.snapshot(this.ydoc(docId));
  }

  textAt(docId: string, snap: Y.Snapshot): string {
    const delta = this.ydoc(docId).getText('body').toDelta(snap) as { insert: unknown }[];
    return delta.map((d) => (typeof d.insert === 'string' ? d.insert : '')).join('');
  }

  /**
   * Fold an actor's own transaction into a baseline snapshot: the result shows
   * the baseline plus exactly what the actor just did. Diffing it against now
   * shows everyone else's changes and none of the actor's own.
   */
  static foldOwnEdit(base: Y.Snapshot, doc: Y.Doc, client: number, deleteSet: DeleteSet): Y.Snapshot {
    const sv = new Map(base.sv);
    sv.set(client, Y.getState(doc.store, client));
    return Y.createSnapshot(Y.mergeDeleteSets([base.ds, deleteSet]), sv);
  }

  /** Named versions (Google-Docs "name current version"). */
  saveVersion(docId: string, actor: Actor, name: string): { id: string; rev: number } {
    const { doc } = this.require(docId, actor, 'editor');
    const id = `v${randomBytes(5).toString('hex')}`;
    this.db.prepare('INSERT INTO versions (id, doc_id, name, snapshot, rev, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, docId, name.trim().slice(0, 200) || `Version at rev ${doc.rev}`, Buffer.from(Y.encodeSnapshot(this.snapshot(docId))), doc.rev, actor.sub, Date.now());
    return { id, rev: doc.rev };
  }

  versions(docId: string): { id: string; name: string; rev: number; createdBy: string; createdAt: number }[] {
    return (this.db.prepare('SELECT id, name, rev, created_by, created_at FROM versions WHERE doc_id = ? ORDER BY created_at DESC').all(docId) as any[])
      .map((r) => ({ id: r.id, name: r.name, rev: r.rev, createdBy: r.created_by, createdAt: r.created_at }));
  }

  versionSnapshot(docId: string, versionId: string): Y.Snapshot {
    const r = this.db.prepare('SELECT snapshot FROM versions WHERE doc_id = ? AND id = ?').get(docId, versionId) as { snapshot: Buffer } | undefined;
    if (!r) throw new Fault(404, 'No such version.');
    return Y.decodeSnapshot(r.snapshot);
  }

  /** Restore a version by editing the live text toward it (history is kept). */
  restoreVersion(docId: string, actor: Actor, versionId: string) {
    this.require(docId, actor, 'editor');
    const target = this.textAt(docId, this.versionSnapshot(docId, versionId));
    this.edit(docId, { sub: actor.sub, via: actor.via }, (t) => Documents.replaceMinimal(t, 0, t.length, target));
  }

  activity(docId: string, sinceMs = 0): { sub: string; minute: number; added: number; removed: number }[] {
    return this.db.prepare('SELECT sub, minute, added, removed FROM doc_activity WHERE doc_id = ? AND minute >= ? ORDER BY minute DESC LIMIT 500')
      .all(docId, Math.floor(sinceMs / 60_000)) as any[];
  }

  unload(docId: string) {
    const doc = this.live.get(docId);
    if (doc) { doc.destroy(); this.live.delete(docId); }
    this.lastUsed.delete(docId);
  }
}
