// Groups: named sets of people and agents to share with and to mention.
//
// A group is a principal of kind 'group' (sub `group:<id>`), so everything
// that names principals — document ACLs, mentions, labels, pickers — works
// on it unchanged. Membership is resolved at read time: adding someone to a
// group is immediately effective wherever the group is used. No nesting.

import { randomBytes } from 'node:crypto';
import type { DB } from './db.js';
import { Fault } from './auth.js';
import { isGuest, type Actor, type Principal, type Principals } from './principals.js';

export interface GroupInfo { sub: string; name: string; ownerSub: string; createdAt: number; members: number; /** The actor's standing: owner, member, or (admin) none. */ you: 'owner' | 'member' | null }

export const isGroup = (sub: string) => sub.startsWith('group:');
const NAME_MAX = 60;

export class Groups {
  constructor(private db: DB, private principals: Principals) {}

  private row(sub: string): { sub: string; owner_sub: string; created_at: number } | undefined {
    return this.db.prepare('SELECT * FROM groups WHERE sub = ?').get(sub) as any;
  }
  private info(r: { sub: string; owner_sub: string; created_at: number }, actor?: Pick<Actor, 'sub'>): GroupInfo {
    const p = this.principals.get(r.sub);
    const members = (this.db.prepare('SELECT count(*) AS n FROM group_members WHERE group_sub = ?').get(r.sub) as { n: number }).n;
    return { sub: r.sub, name: p?.name ?? '', ownerSub: r.owner_sub, createdAt: r.created_at, members, you: !actor ? null : r.owner_sub === actor.sub ? 'owner' : this.isMember(r.sub, actor.sub) ? 'member' : null };
  }

  get(sub: string, actor?: Pick<Actor, 'sub'>): GroupInfo | null {
    const r = this.row(sub);
    return r ? this.info(r, actor) : null;
  }

  /** Groups the actor owns or belongs to. (Admins administer people, not groups: no override.) */
  listFor(actor: Pick<Actor, 'sub' | 'admin'>): GroupInfo[] {
    const rows = this.db.prepare('SELECT g.* FROM groups g WHERE g.owner_sub = ? OR EXISTS (SELECT 1 FROM group_members m WHERE m.group_sub = g.sub AND m.sub = ?) ORDER BY g.created_at').all(actor.sub, actor.sub) as any[];
    return rows.map((r) => this.info(r, actor));
  }

  /** Who may see a group at all: its owner and its members. */
  canSee(sub: string, actor: Pick<Actor, 'sub' | 'admin'>): boolean {
    const r = this.row(sub);
    return !!r && (r.owner_sub === actor.sub || this.isMember(sub, actor.sub));
  }
  private requireManage(sub: string, actor: Pick<Actor, 'sub' | 'admin'>): { sub: string; owner_sub: string; created_at: number } {
    const r = this.row(sub);
    if (!r || !this.canSee(sub, actor)) throw new Fault(404, 'No such group.');
    if (r.owner_sub !== actor.sub) throw new Fault(403, 'Only the group’s owner can change it.');
    return r;
  }

  create(actor: Actor, name: string): GroupInfo {
    if (isGuest(actor.sub)) throw new Fault(403, 'Sign in with Archipelago to make groups.');
    const clean = cleanName(name);
    const sub = `group:${randomBytes(6).toString('base64url').replace(/[-_]/g, 'x')}`;
    const now = Date.now();
    this.db.transaction(() => {
      this.principals.createGroup(sub, clean);
      this.db.prepare('INSERT INTO groups (sub, owner_sub, created_at) VALUES (?, ?, ?)').run(sub, actor.sub, now);
      this.db.prepare('INSERT INTO group_members (group_sub, sub, added_by, added_at) VALUES (?, ?, ?, ?)').run(sub, actor.sub, actor.sub, now);
    })();
    return this.get(sub, actor)!;
  }

  rename(actor: Pick<Actor, 'sub' | 'admin'>, sub: string, name: string): GroupInfo {
    this.requireManage(sub, actor);
    this.principals.rename(sub, cleanName(name));
    return this.get(sub, actor)!;
  }

  /** Delete a group: its memberships and every share made to it go with it. */
  remove(actor: Pick<Actor, 'sub' | 'admin'>, sub: string): void {
    this.requireManage(sub, actor);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM group_members WHERE group_sub = ?').run(sub);
      this.db.prepare('DELETE FROM doc_acl WHERE sub = ?').run(sub);
      this.db.prepare('DELETE FROM watches WHERE sub = ?').run(sub);
      this.db.prepare('DELETE FROM groups WHERE sub = ?').run(sub);
      this.principals.remove(sub);
    })();
  }

  members(sub: string): Principal[] {
    const rows = this.db.prepare('SELECT sub FROM group_members WHERE group_sub = ? ORDER BY added_at').all(sub) as { sub: string }[];
    return rows.map((r) => this.principals.get(r.sub)).filter((p): p is Principal => !!p);
  }
  memberSubs(sub: string): string[] {
    return (this.db.prepare('SELECT sub FROM group_members WHERE group_sub = ?').all(sub) as { sub: string }[]).map((r) => r.sub);
  }
  isMember(sub: string, who: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM group_members WHERE group_sub = ? AND sub = ?').get(sub, who);
  }
  /** The groups a principal belongs to. */
  groupsOf(who: string): string[] {
    return (this.db.prepare('SELECT group_sub FROM group_members WHERE sub = ?').all(who) as { group_sub: string }[]).map((r) => r.group_sub);
  }

  addMember(actor: Pick<Actor, 'sub' | 'admin'>, sub: string, who: string): GroupInfo {
    this.requireManage(sub, actor);
    const p = this.principals.get(who);
    if (!p || isGuest(who)) throw new Fault(404, 'Unknown person or agent (guests cannot be in groups).');
    if (isGroup(who)) throw new Fault(400, 'Groups cannot contain groups.');
    if (p.role === 'blocked') throw new Fault(400, `${p.name} is blocked on this service.`);
    this.db.prepare('INSERT OR IGNORE INTO group_members (group_sub, sub, added_by, added_at) VALUES (?, ?, ?, ?)').run(sub, who, actor.sub, Date.now());
    return this.get(sub, actor)!;
  }

  removeMember(actor: Pick<Actor, 'sub' | 'admin'>, sub: string, who: string): GroupInfo {
    const r = this.requireManage(sub, actor);
    if (who === r.owner_sub) throw new Fault(400, 'The owner stays in the group; transfer or delete it instead.');
    this.db.prepare('DELETE FROM group_members WHERE group_sub = ? AND sub = ?').run(sub, who);
    return this.get(sub, actor)!;
  }
}

function cleanName(name: string): string {
  const n = String(name ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  if (!n) throw new Fault(400, 'A group needs a name.');
  if (/^(human|agent|service|group|guest):/i.test(n)) throw new Fault(400, 'That looks like an id, not a name.');
  return n;
}
