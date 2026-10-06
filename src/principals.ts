// Principal directory: every human and agent the service has verified, keyed by sub.

import { createHash, randomBytes, randomInt } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { DB } from './db.js';
import { Fault, type Identity, type PrincipalKind } from './auth.js';

/** Guests are people who opened an "anyone with the link" share link without signing in. */
export type Kind = PrincipalKind | 'guest';
export const isGuest = (sub: string) => sub.startsWith('guest:');
const GUEST_SUFFIX = ' (guest)';
const ANIMALS = ['Otter', 'Heron', 'Lynx', 'Marten', 'Ibis', 'Fox', 'Hare', 'Wren', 'Badger', 'Kestrel', 'Newt', 'Moth', 'Seal', 'Crane', 'Vole', 'Finch', 'Gecko', 'Owl', 'Stoat', 'Tern'];

export interface Principal {
  sub: string;
  name: string;
  kind: Kind;
  issuer: string;
  role: 'member' | 'admin' | 'blocked';
  color: string;
  firstSeen: number;
  lastSeen: number;
}

/** What the rest of the service acts on: a verified identity plus local standing. */
export interface Actor extends Principal {
  scopes: string[];
  admin: boolean;
  /** Token expiry (seconds). */
  exp: number;
  /** How this actor reached us — for presence and provenance only. */
  via: 'web' | 'mcpl' | 'http';
}

const PALETTE = ['#d93025', '#1a73e8', '#188038', '#e37400', '#9334e6', '#c5221f', '#129eaf', '#b06000', '#3c4043', '#d01884', '#137333', '#5f6368'];

export function colorFor(sub: string): string {
  const h = createHash('sha256').update(sub).digest();
  return PALETTE[h[0] % PALETTE.length];
}

type Row = { sub: string; name: string; kind: Kind; issuer: string; role: Principal['role']; color: string; first_seen: number; last_seen: number };
const fromRow = (r: Row): Principal => ({ sub: r.sub, name: r.name, kind: r.kind, issuer: r.issuer, role: r.role, color: r.color, firstSeen: r.first_seen, lastSeen: r.last_seen });

/** Emits 'role' { sub, role } when an admin changes someone's standing. */
export class Principals extends EventEmitter {
  constructor(private db: DB, private opts: { admins: string[]; homeIssuer: string }) { super(); this.setMaxListeners(50); }

  /**
   * Record a verified identity and return the actor, refusing blocked
   * principals. A sub belongs to the issuer that first presented it: with
   * several trusted issuers, one can't mint another's subs (home-node subs
   * like human:discord:<id> carry no issuer namespace of their own).
   */
  admit(who: Identity, via: Actor['via']): Actor {
    const now = Date.now();
    if (isGuest(who.sub) || !['human', 'agent', 'service'].includes(who.kind)) throw new Fault(403, 'Not an Archipelago identity.');
    const existing = this.get(who.sub);
    if (existing && existing.issuer !== who.issuer) {
      throw new Fault(403, 'This identity belongs to another issuer.', `sub ${who.sub} presented by ${who.issuer}, owned by ${existing.issuer}`);
    }
    this.db.prepare(`
      INSERT INTO principals (sub, name, kind, issuer, color, first_seen, last_seen)
      VALUES (@sub, @name, @kind, @issuer, @color, @now, @now)
      ON CONFLICT(sub) DO UPDATE SET name = excluded.name, kind = excluded.kind, last_seen = excluded.last_seen
    `).run({ sub: who.sub, name: who.name, kind: who.kind, issuer: who.issuer, color: colorFor(who.sub), now });
    const p = this.get(who.sub)!;
    if (p.role === 'blocked') throw new Fault(403, 'This identity is blocked on this service.');
    // Admin by scope is honored from the home issuer only.
    const admin = p.role === 'admin' || this.opts.admins.includes(p.sub) || (who.issuer === this.opts.homeIssuer && who.scopes.includes('docs:admin'));
    return { ...p, scopes: who.scopes, admin, via, exp: who.exp };
  }

  /** Current standing of a principal for an already-admitted connection (null = gone or blocked). */
  standing(sub: string, scopes: string[], issuer: string): { admin: boolean } | null {
    const p = this.get(sub);
    if (!p || p.role === 'blocked') return null;
    return { admin: p.role === 'admin' || this.opts.admins.includes(sub) || (issuer === this.opts.homeIssuer && scopes.includes('docs:admin')) };
  }

  /**
   * A new guest: someone who opened an "anyone with the link" share link
   * without signing in. Their display name always ends in "(guest)" so it
   * can't pass for a member's.
   */
  createGuest(name?: string): Principal {
    const sub = `guest:${randomBytes(9).toString('base64url')}`;
    const now = Date.now();
    const display = `${cleanGuestName(name) || `Anonymous ${ANIMALS[randomInt(ANIMALS.length)]}`}${GUEST_SUFFIX}`;
    this.db.prepare(`INSERT INTO principals (sub, name, kind, issuer, color, first_seen, last_seen) VALUES (?, ?, 'guest', 'guest', ?, ?, ?)`)
      .run(sub, display, colorFor(sub), now, now);
    return this.get(sub)!;
  }

  /** The actor for a guest session (null = unknown or blocked). */
  guestActor(sub: string, expiresAt: number): Actor | null {
    const p = this.get(sub);
    if (!p || p.kind !== 'guest' || p.role === 'blocked') return null;
    this.db.prepare('UPDATE principals SET last_seen = ? WHERE sub = ?').run(Date.now(), sub);
    return { ...p, role: 'member', scopes: [], admin: false, via: 'web', exp: Math.floor(expiresAt / 1000) };
  }

  renameGuest(sub: string, name: string): Principal {
    const p = this.get(sub);
    if (!p || p.kind !== 'guest') throw new Fault(403, 'Only guests choose their name here; members get theirs from Archipelago.');
    const clean = cleanGuestName(name);
    if (!clean) throw new Fault(400, 'Name cannot be empty.');
    this.db.prepare('UPDATE principals SET name = ? WHERE sub = ?').run(`${clean}${GUEST_SUFFIX}`, sub);
    this.emit('renamed', { sub });
    return this.get(sub)!;
  }

  get(sub: string): Principal | null {
    const r = this.db.prepare('SELECT * FROM principals WHERE sub = ?').get(sub) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  /** Display label: name, plus the issuer domain when it isn't the home issuer (✓domain). */
  label(sub: string): string {
    const p = this.get(sub);
    if (!p) return sub;
    return p.issuer === this.opts.homeIssuer || p.kind === 'guest' ? p.name : `${p.name} ✓${p.issuer}`;
  }

  /** The directory. Guests are left out unless asked for (admins moderating). */
  list(opts: { query?: string; kind?: Kind; limit?: number; includeGuests?: boolean } = {}): Principal[] {
    const q = opts.query ? `%${opts.query.replace(/[%_]/g, '')}%` : '%';
    const rows = this.db.prepare(`
      SELECT * FROM principals
      WHERE (name LIKE @q OR sub LIKE @q) AND (@kind IS NULL OR kind = @kind) AND (@guests = 1 OR kind != 'guest')
      ORDER BY last_seen DESC LIMIT @limit
    `).all({ q, kind: opts.kind ?? null, guests: opts.includeGuests ? 1 : 0, limit: Math.min(opts.limit ?? 50, 500) }) as Row[];
    return rows.map(fromRow);
  }

  setRole(sub: string, role: Principal['role']): Principal {
    if (!['member', 'admin', 'blocked'].includes(role)) throw new Fault(400, 'role must be member, admin or blocked');
    if (role === 'admin' && isGuest(sub)) throw new Fault(400, 'Guests cannot be admins.');
    const r = this.db.prepare('UPDATE principals SET role = ? WHERE sub = ?').run(role, sub);
    if (!r.changes) throw new Fault(404, 'Unknown principal.');
    if (role === 'blocked') this.db.prepare('DELETE FROM sessions WHERE sub = ?').run(sub);
    this.emit('role', { sub, role });
    return this.get(sub)!;
  }

  /**
   * Resolve a reference typed by a human or an agent: a full sub, `@name`, or
   * `name`. Names are matched case-insensitively; an ambiguous name is an error
   * rather than a guess, because the result decides who gets woken.
   */
  resolve(ref: string): Principal {
    const s = ref.trim().replace(/^@/, '');
    if (/^(human|agent|service):/.test(s)) {
      const p = this.get(s);
      if (!p) throw new Fault(404, `Unknown principal ${s}. They must sign in (or connect) once before they can be named.`);
      return p;
    }
    // Guests can't be named: they aren't anyone in particular.
    const rows = this.db.prepare(`SELECT * FROM principals WHERE name = ? COLLATE NOCASE AND kind != 'guest' ORDER BY last_seen DESC`).all(s) as Row[];
    if (rows.length === 1) return fromRow(rows[0]);
    if (rows.length > 1) throw new Fault(409, `"${s}" is ambiguous: ${rows.map((r) => r.sub).join(', ')}. Use the full id.`);
    throw new Fault(404, `No one named "${s}" has used this service yet.`);
  }

  /**
   * Find @mentions in comment text. Supports `@name` (longest known name wins,
   * so "@Claude Opus" beats "@Claude"), `@{sub}`, and `@[name](sub)`.
   */
  findMentions(text: string): Principal[] {
    const found = new Map<string, Principal>();
    for (const m of text.matchAll(/@\[[^\]]*\]\(((?:human|agent|service):[^)\s]+)\)|@\{((?:human|agent|service):[^}\s]+)\}/g)) {
      const p = this.get(m[1] ?? m[2]);
      if (p) found.set(p.sub, p);
    }
    const names = this.db.prepare(`SELECT * FROM principals WHERE role != 'blocked' AND kind != 'guest' ORDER BY length(name) DESC`).all() as Row[];
    const lower = text.toLowerCase();
    for (const r of names) {
      const needle = `@${r.name.toLowerCase()}`;
      let at = lower.indexOf(needle);
      while (at >= 0) {
        const before = at === 0 ? ' ' : lower[at - 1];
        const after = lower[at + needle.length] ?? ' ';
        if (!/[\w@]/.test(before) && !/[\w-]/.test(after)) {
          // Same display name under two issuers: only an explicit sub disambiguates.
          const twins = names.filter((x) => x.name.toLowerCase() === r.name.toLowerCase());
          if (twins.length === 1) found.set(r.sub, fromRow(r));
          break;
        }
        at = lower.indexOf(needle, at + 1);
      }
    }
    return [...found.values()];
  }
}

function cleanGuestName(name: string | undefined): string {
  // Plain text only, and no "@" or "(guest)" games.
  return String(name ?? '').normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}@<>]/gu, '').replace(/\(\s*guest\s*\)/gi, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}
