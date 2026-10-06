// Share links and guests: per-document access the service manages itself.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { core } from './helpers.js';
import { startServer, rawHost, until, sleep, browserClient } from './server-harness.js';
import { isGuest } from '../src/principals.js';

// ---------------------------------------------------------------- core rules

test('links grant a role while active; revoking or expiry ends it for everyone who used it', () => {
  const { docs, actor } = core();
  const ann = actor('Ann'), bob = actor('Bob');
  const d = docs.create(ann, 'Plan', 'hello');
  assert.equal(docs.role(d.id, bob), null);
  const l = docs.createLink(d.id, ann, { role: 'commenter', audience: 'members' });
  assert.equal(docs.redeemLink(l.key, bob).role, 'commenter');
  assert.equal(docs.role(d.id, bob), 'commenter');
  assert.ok(docs.list(bob).some((x) => x.id === d.id), 'a held link puts the doc in your list');
  // A better grant wins; the link never lowers anyone.
  docs.share(d.id, ann, bob.sub, 'editor');
  assert.equal(docs.role(d.id, bob), 'editor');
  docs.share(d.id, ann, bob.sub, 'none');
  assert.equal(docs.role(d.id, bob), 'commenter');
  docs.revokeLink(l.id, ann);
  assert.equal(docs.role(d.id, bob), null);
  assert.throws(() => docs.redeemLink(l.key, bob), /no longer works/);

  const short = docs.createLink(d.id, ann, { role: 'viewer', audience: 'members', expiresInDays: 1 });
  docs.redeemLink(short.key, bob);
  assert.equal(docs.role(d.id, bob), 'viewer');
  (docs as any).db.prepare('UPDATE doc_links SET expires_at = ? WHERE id = ?').run(Date.now() - 1, short.id);
  assert.equal(docs.role(d.id, bob), null, 'expired links grant nothing');
});

test('who may make which links, and who sees them', () => {
  const { docs, actor } = core();
  const ann = actor('Ann'), ed = actor('Ed'), cam = actor('Cam');
  const d = docs.create(ann, 'Plan');
  docs.share(d.id, ann, ed.sub, 'editor');
  docs.share(d.id, ann, cam.sub, 'commenter');
  assert.throws(() => docs.createLink(d.id, ed, { role: 'viewer', audience: 'anyone' }), /owner/, 'public links are owner-only');
  const mine = docs.createLink(d.id, ed, { role: 'editor', audience: 'members' });
  assert.throws(() => docs.createLink(d.id, cam, { role: 'viewer', audience: 'members' }), /editor/);
  assert.throws(() => docs.createLink(d.id, ann, { role: 'owner' as any, audience: 'anyone' }), /viewer, commenter or editor/);
  const pub = docs.createLink(d.id, ann, { role: 'viewer', audience: 'anyone', label: 'reading group' });
  assert.deepEqual(docs.links(d.id, ann).map((l) => l.id).sort(), [mine.id, pub.id].sort(), 'owners see every link');
  assert.deepEqual(docs.links(d.id, ed).map((l) => l.id), [mine.id], 'others see their own');
  assert.deepEqual(docs.links(d.id, cam), []);
  assert.throws(() => docs.revokeLink(pub.id, ed), /owner or the person who made/);
  docs.revokeLink(mine.id, ed);
  assert.ok(docs.hasPublicLink(d.id));
});

test('guests: link access only — no general access, no naming, no sharing', () => {
  const { docs, principals, actor } = core();
  const ann = actor('Ann');
  const open = docs.create(ann, 'Open to members');
  docs.setGeneralAccess(open.id, ann, 'editor');
  const d = docs.create(ann, 'Public');
  const g = principals.guestActor(principals.createGuest('Ann').sub, Date.now() + 1e6)!;
  assert.ok(isGuest(g.sub));
  assert.equal(g.name, 'Ann (guest)', 'a guest name can never pass for a member');
  assert.equal(docs.role(open.id, g), null, '"anyone signed in" means Archipelago members, not guests');
  const members = docs.createLink(d.id, ann, { role: 'viewer', audience: 'members' });
  assert.throws(() => docs.redeemLink(members.key, g), /Sign in/);
  const pub = docs.createLink(d.id, ann, { role: 'commenter', audience: 'anyone' });
  assert.equal(docs.redeemLink(pub.key, g).role, 'commenter');
  assert.deepEqual(docs.list(g).map((x) => x.id), [d.id]);
  assert.throws(() => docs.share(d.id, g, ann.sub, 'viewer'), /Sign in/);
  assert.throws(() => docs.share(d.id, ann, g.sub, 'viewer'), /share link/);
  assert.throws(() => docs.createLink(d.id, g, { role: 'viewer', audience: 'members' }), /Sign in/);
  assert.throws(() => principals.resolve('Ann (guest)'), /No one named/);
  assert.deepEqual(principals.findMentions('hi @Ann (guest)').map((p) => p.sub), [ann.sub], 'a mention means the member, never the guest');
  assert.equal(principals.renameGuest(g.sub, 'Root @admin (Guest)').name, 'Root admin (guest)');
  assert.throws(() => principals.setRole(g.sub, 'admin'), /Guests cannot be admins/);
});

// ---------------------------------------------------------------- over HTTP, WebSocket and MCPL

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.close(); });

const H = (extra: Record<string, string> = {}) => ({ Origin: S.base, 'Content-Type': 'application/json', ...extra });
async function signIn(name: string): Promise<string> {
  const r = await fetch(`${S.base}/auth/exchange`, { method: 'POST', headers: H({ Cookie: 'docs_login=x' }), body: JSON.stringify({ token: S.iss.mint(name, 'human') }) });
  assert.equal(r.status, 200);
  return `docs_session=${/docs_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')![1]}`;
}
const api = async (method: string, path: string, cookie: string | null, body?: unknown) => {
  const r = await fetch(`${S.base}${path}`, { method, headers: H(cookie ? { Cookie: cookie } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, cookie: /docs_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1] };
};

test('HTTP: an "anyone" link works signed out — the visitor becomes a guest with document access only', async () => {
  const ann = await signIn('Ann');
  const d = (await api('POST', '/api/docs', ann, { title: 'Field notes', content: '# Notes\n\nfirst line\n' })).json;
  const link = await api('POST', `/api/docs/${d.id}/links`, ann, { role: 'commenter', who: 'anyone', label: 'for readers' });
  assert.equal(link.status, 201);
  assert.match(link.json.url, /\/l\/[A-Za-z0-9_-]{24}$/);
  const key = link.json.url.split('/l/')[1];

  assert.deepEqual((await api('GET', `/api/links/${key}`, null)).json, { active: true, audience: 'anyone', role: 'commenter', title: 'Field notes', signedIn: false, guest: false });
  const red = await api('POST', '/api/links/redeem', null, { key, name: 'Mira' });
  assert.equal(red.status, 200);
  assert.equal(red.json.docId, d.id);
  assert.equal(red.json.you.name, 'Mira (guest)');
  assert.equal(red.json.you.kind, 'guest');
  const guest = `docs_session=${red.cookie}`;

  const me = (await api('GET', '/api/me', guest)).json;
  assert.equal(me.guest, true);
  const view = await api('GET', `/api/docs/${d.id}`, guest);
  assert.equal(view.json.role, 'commenter');
  assert.deepEqual(view.json.acl, [], 'guests do not see who else has access');
  assert.equal((await api('GET', `/api/docs/${d.id}/export.md`, guest)).text, '# Notes\n\nfirst line\n');
  assert.deepEqual((await api('GET', '/api/docs', guest)).json.docs.map((x: any) => x.id), [d.id]);
  for (const [m, p, b] of [['POST', '/api/docs', { title: 'x' }], ['GET', '/api/people', undefined], ['GET', '/api/watches', undefined],
    ['POST', `/api/docs/${d.id}/share`, { who: '@Ann', role: 'viewer' }], ['POST', `/api/docs/${d.id}/links`, { role: 'viewer', who: 'members' }],
    ['POST', '/api/operations/list_documents', {}], ['DELETE', `/api/docs/${d.id}`, undefined]] as const) {
    assert.equal((await api(m, p, guest, b)).status, 403, `${m} ${p} is for members`);
  }
  const upload = await fetch(`${S.base}/api/media?doc=${d.id}`, { method: 'POST', headers: { Cookie: guest, Origin: S.base }, body: Buffer.from('x') });
  assert.equal(upload.status, 403);
  assert.equal((await api('POST', '/api/guest/name', guest, { name: 'Mira K' })).json.you.name, 'Mira K (guest)');
  assert.equal((await api('POST', '/api/guest/name', ann, { name: 'x' })).status, 403, 'members take their name from Archipelago');

  // A returning guest reuses their identity rather than minting another.
  const again = await api('POST', '/api/links/redeem', guest, { key });
  assert.equal(again.cookie, undefined);
  assert.equal(again.json.you.sub, red.json.you.sub);

  // Revoked: the guest's access is gone at once.
  const lid = link.json.id;
  assert.equal((await api('DELETE', `/api/docs/${d.id}/links/${lid}`, ann)).json.active, false);
  assert.equal((await api('GET', `/api/docs/${d.id}`, guest)).status, 404);
  assert.equal((await api('POST', '/api/links/redeem', null, { key })).status, 404);
  assert.deepEqual((await api('GET', `/api/links/${key}`, null)).json.active, false);
});

test('HTTP: a "members" link needs an Archipelago sign-in and does not reveal its title', async () => {
  const ann = await signIn('Ann');
  const d = (await api('POST', '/api/docs', ann, { title: 'Members only' })).json;
  const l = (await api('POST', `/api/docs/${d.id}/links`, ann, { role: 'editor', who: 'members' })).json;
  const key = l.url.split('/l/')[1];
  const peek = (await api('GET', `/api/links/${key}`, null)).json;
  assert.equal(peek.audience, 'members');
  assert.equal(peek.title, undefined);
  assert.equal((await api('POST', '/api/links/redeem', null, { key })).status, 401);
  const bob = await signIn('Bob');
  const r = await api('POST', '/api/links/redeem', bob, { key });
  assert.equal(r.json.role, 'editor');
  assert.equal((await api('GET', `/api/docs/${d.id}`, bob)).json.role, 'editor');
});

test('realtime: a commenter guest can comment but not edit; revoking closes their socket', async () => {
  const ann = await signIn('Ann');
  const d = (await api('POST', '/api/docs', ann, { title: 'Live', content: 'shared text\n' })).json;
  const l = (await api('POST', `/api/docs/${d.id}/links`, ann, { role: 'commenter', who: 'anyone' })).json;
  const red = await api('POST', '/api/links/redeem', null, { key: l.url.split('/l/')[1] });
  const guest = await browserClient(S, `docs_session=${red.cookie}`, d.id);
  try {
    const hello = guest.json.find((m) => m.type === 'hello');
    assert.equal(hello.role, 'commenter');
    assert.equal(hello.you.kind, 'guest');
    guest.doc.getText('body').insert(0, 'vandal ');
    await until(() => guest.json.some((m) => m.type === 'error' && m.resync), 'edit refused');
    assert.equal(S.app.docs.text(d.id), 'shared text\n');
    const c = await guest.ask({ type: 'comment.create', body: 'Lovely. @Ann what do you think?' });
    assert.equal(c.ok, true);
    const a = await guest.ask({ type: 'comment.assign', comment: c.data.id, assignee: '@Ann' });
    assert.equal(a.ok, false, 'guests cannot assign work');
    const closed = new Promise<number>((r) => guest.ws.once('close', (code) => r(code)));
    await api('DELETE', `/api/docs/${d.id}/links/${l.id}`, ann);
    assert.equal(await closed, 4003);
  } finally { guest.close(); }
});

test('realtime: an editor guest edits with attribution', async () => {
  const ann = await signIn('Ann');
  const d = (await api('POST', '/api/docs', ann, { title: 'Open edit', content: 'base\n' })).json;
  const l = (await api('POST', `/api/docs/${d.id}/links`, ann, { role: 'editor', who: 'anyone' })).json;
  const red = await api('POST', '/api/links/redeem', null, { key: l.url.split('/l/')[1], name: 'Tam' });
  const guest = await browserClient(S, `docs_session=${red.cookie}`, d.id);
  try {
    guest.doc.getText('body').insert(4, ' line');
    await until(() => S.app.docs.text(d.id) === 'base line\n', 'guest edit saved');
    const doc = S.app.docs.ydoc(d.id);
    const owners = [...doc.store.clients.keys()].map((c) => S.app.docs.ownerOfClient(d.id, c));
    assert.ok(owners.includes(red.json.you.sub), 'the guest is the attributed author');
  } finally { guest.close(); }
});

test('agents: open a link by URL, use it as a document reference, make and revoke links', async () => {
  const ann = await signIn('Ann');
  const d = (await api('POST', '/api/docs', ann, { title: 'For agents', content: '# Brief\n\nRead me.\n' })).json;
  const l = (await api('POST', `/api/docs/${d.id}/links`, ann, { role: 'editor', who: 'members' })).json;
  const host = await rawHost(`ws://127.0.0.1:${S.port}/mcpl?token=${S.token('Scribe')}`);
  try {
    const opened = await host.tool('open_link', { link: l.url });
    assert.ok(opened.text.startsWith(`Opened “For agents” (${d.id}); you are an editor.`), opened.text);
    const read = await host.tool('read_document', { document: `${S.base}/d/${d.id}` });
    assert.match(read.text, /Read me\./);
    const own = await host.tool('create_document', { title: 'Agent notes' });
    const id = /(d[A-Za-z0-9]{8})/.exec(own.text)![1];
    const made = await host.tool('create_link', { document: id, role: 'viewer', who: 'anyone', label: 'public', expires_in_days: 7 });
    assert.match(made.text, /\/l\/[A-Za-z0-9_-]{24}/);
    const access = await host.tool('list_access', { document: id });
    assert.match(access.text, /anyone with the link \(no sign-in\) can view — “public”/);
    const linkId = /Link (l[A-Za-z0-9]+)/.exec(made.text)![1];
    assert.match((await host.tool('revoke_link', { link: linkId })).text, /Revoked link/);
    // A second agent reaches a doc purely through a link passed as the document reference.
    const l2 = (await api('POST', `/api/docs/${d.id}/links`, ann, { role: 'viewer', who: 'members' })).json;
    const other = await rawHost(`ws://127.0.0.1:${S.port}/mcpl?token=${S.token('Reader')}`);
    try { assert.match((await other.tool('read_document', { document: l2.url })).text, /Read me\./); } finally { other.close(); }
  } finally { host.close(); }
});

test('agents: guest activity is delivered quietly unless the agent opts in with guests: wake', async () => {
  const ann = await signIn('Ann');
  const host = await rawHost(`ws://127.0.0.1:${S.port}/mcpl?token=${S.token('Watcher')}`);
  try {
    const d = (await api('POST', '/api/docs', ann, { title: 'Public draft', content: 'para\n' })).json;
    await api('POST', `/api/docs/${d.id}/share`, ann, { who: '@Watcher', role: 'editor' });
    const l = (await api('POST', `/api/docs/${d.id}/links`, ann, { role: 'commenter', who: 'anyone' })).json;
    const red = await api('POST', '/api/links/redeem', null, { key: l.url.split('/l/')[1] });
    const guest = await browserClient(S, `docs_session=${red.cookie}`, d.id);
    try {
      await guest.ask({ type: 'comment.create', body: '@Watcher can you expand this?' });
      await until(() => host.pushes.some((p) => p.tags.includes('chat:mention')), 'mention delivered');
      const first = host.pushes.find((p) => p.tags.includes('chat:mention'));
      assert.ok(first.tags.includes('docs:quiet') && first.tags.includes('docs:from-guest'), first.tags.join(' '));
      await host.tool('watch', { document: d.id, guests: 'wake' });
      await guest.ask({ type: 'comment.create', body: '@Watcher and this part?' });
      await until(() => host.pushes.filter((p) => p.tags.includes('chat:mention')).length === 2, 'second mention');
      assert.ok(host.pushes.filter((p) => p.tags.includes('chat:mention'))[1].tags.includes('docs:wake'));
      await host.tool('watch', { document: d.id, guests: 'off' });
      const before = host.pushes.length;
      await guest.ask({ type: 'comment.create', body: '@Watcher hello again' });
      await sleep(200);
      assert.equal(host.pushes.length, before, 'guests: off — nothing delivered');
    } finally { guest.close(); }
  } finally { host.close(); }
});

test('schema v2 migration keeps a v1 database intact', async () => {
  const { openDatabase } = await import('../src/db.js');
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const Database = (await import('better-sqlite3')).default;
  const file = join(mkdtempSync(join(tmpdir(), 'adocs-mig-')), 'docs.db');
  // Build a v1 database by hand: run the current opener, then roll the v2 parts back.
  const db0 = openDatabase(file);
  db0.prepare(`INSERT INTO principals (sub, name, kind, issuer, color, first_seen, last_seen) VALUES ('human:x:a', 'A', 'human', 'x', '#000', 1, 1)`).run();
  db0.prepare(`INSERT INTO documents (id, title, owner_sub, created_at, updated_at) VALUES ('dmig', 'T', 'human:x:a', 1, 1)`).run();
  db0.exec(`DROP TABLE link_holders; DROP TABLE doc_links;`);
  db0.pragma('user_version = 1');
  db0.close();
  const db = openDatabase(file);
  assert.equal(db.pragma('user_version', { simple: true }), 2);
  assert.equal((db.prepare('SELECT title FROM documents WHERE id = ?').get('dmig') as any).title, 'T');
  db.prepare(`INSERT INTO principals (sub, name, kind, issuer, color, first_seen, last_seen) VALUES ('guest:q', 'Q (guest)', 'guest', 'guest', '#000', 1, 1)`).run();
  assert.equal((db.pragma('foreign_key_check') as unknown[]).length, 0);
  db.close();
  void Database; void Y;
});

test('guests see people by name, never by Archipelago id', async () => {
  const ann = await signIn('Ann');
  const annSub = 'human:test:ann';
  const d = (await api('POST', '/api/docs', ann, { title: 'Masked', content: 'text here\n' })).json;
  const l = (await api('POST', `/api/docs/${d.id}/links`, ann, { role: 'commenter', who: 'anyone' })).json;
  const red = await api('POST', '/api/links/redeem', null, { key: l.url.split('/l/')[1] });
  const cookie = `docs_session=${red.cookie}`;
  const me = red.json.you.sub;
  const member = await browserClient(S, ann, d.id);
  member.awareness.setLocalStateField('cursor', null);
  await member.ask({ type: 'comment.create', body: `note for @{${annSub}}` });
  const guest = await browserClient(S, cookie, d.id);
  try {
    await guest.ask({ type: 'comment.create', body: 'from the guest' });
    await until(() => guest.json.filter((m) => m.type === 'threads').length >= 2, 'threads');
    const all = JSON.stringify(guest.json) + JSON.stringify([...guest.awareness.getStates().values()]);
    assert.ok(!all.includes(annSub), 'no member id reaches the guest');
    assert.ok(all.includes(me), 'the guest still knows themselves');
    const last = guest.json.filter((m) => m.type === 'threads').at(-1);
    const authors = last.threads.flatMap((t: any) => t.comments.map((c: any) => c.author.sub));
    assert.ok(authors.some((x: string) => x.startsWith('anon:')) && authors.includes(me));
    const http = JSON.stringify((await api('GET', `/api/docs/${d.id}`, cookie)).json) + JSON.stringify((await api('GET', '/api/docs', cookie)).json);
    assert.ok(!http.includes(annSub) && http.includes('anon:'));
    // Members are unaffected.
    assert.ok(JSON.stringify((await api('GET', `/api/docs/${d.id}`, ann)).json).includes(annSub));
  } finally { guest.close(); member.close(); }
});

// Last: it uses up this address's allowance of new guests.
test('guest limiter: a burst of new guests from one address is refused', async () => {
  const ann = await signIn('Ann');
  const d = (await api('POST', '/api/docs', ann, { title: 'Busy' })).json;
  const key = (await api('POST', `/api/docs/${d.id}/links`, ann, { role: 'viewer', who: 'anyone' })).json.url.split('/l/')[1];
  const statuses: number[] = [];
  for (let i = 0; i < 25; i++) statuses.push((await api('POST', '/api/links/redeem', null, { key })).status);
  assert.ok(statuses.includes(429), `expected a 429 in ${statuses.join(',')}`);
});
