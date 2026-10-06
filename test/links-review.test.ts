// Regression tests for the security review of share links and guests.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { core } from './helpers.js';
import { startServer, rawHost, until, sleep, browserClient } from './server-harness.js';
import { clientNetwork } from '../src/http.js';
import { pruneLinksAndGuests } from '../src/app.js';

// ---------------------------------------------------------------- H1: link access never becomes lasting access

test('H1: access through a link cannot be used to share, so revoking the link ends it', () => {
  const { docs, actor } = core();
  const owner = actor('Owner'), mal = actor('Mal'), pal = actor('Pal');
  const d = docs.create(owner, 'Plan');
  const l = docs.createLink(d.id, owner, { role: 'editor', audience: 'members' });
  docs.redeemLink(l.key, mal);
  assert.equal(docs.role(d.id, mal), 'editor');
  assert.throws(() => docs.share(d.id, mal, mal.sub, 'editor'), /through a link does not include sharing/);
  assert.throws(() => docs.share(d.id, mal, pal.sub, 'editor'), /through a link does not include sharing/);
  assert.throws(() => docs.createLink(d.id, mal, { role: 'editor', audience: 'members' }), /through a link does not include sharing/);
  docs.revokeLink(l.id, owner);
  assert.equal(docs.role(d.id, mal), null);
  assert.equal(docs.role(d.id, pal), null);
});

test('H1: a link stops working when its maker loses the access needed to make it', () => {
  const { docs, actor, principals } = core();
  const owner = actor('Owner'), ed = actor('Ed'), gen = actor('Gen'), reader = actor('Reader');
  const d = docs.create(owner, 'Plan');
  docs.share(d.id, owner, ed.sub, 'editor');
  const edLink = docs.createLink(d.id, ed, { role: 'editor', audience: 'members' });
  docs.redeemLink(edLink.key, reader);
  assert.equal(docs.role(d.id, reader), 'editor');
  // An editor can't grant themselves lasting access either.
  assert.throws(() => docs.share(d.id, ed, ed.sub, 'owner'), /your own access/);
  docs.share(d.id, owner, ed.sub, 'none');
  assert.equal(docs.role(d.id, ed), null, 'removed editor keeps nothing through their own link');
  assert.equal(docs.role(d.id, reader), null, "and the link they made stops working");
  assert.equal(docs.peekLink(edLink.key).active, false);
  docs.share(d.id, owner, ed.sub, 'editor');
  assert.equal(docs.role(d.id, reader), 'editor', 'restored with their access');

  // Editor via general access, then general access narrowed.
  docs.setGeneralAccess(d.id, owner, 'editor');
  const genLink = docs.createLink(d.id, gen, { role: 'editor', audience: 'members' });
  docs.redeemLink(genLink.key, gen);
  assert.throws(() => docs.share(d.id, gen, gen.sub, 'editor'), /your own access/);
  docs.setGeneralAccess(d.id, owner, 'restricted');
  assert.equal(docs.role(d.id, gen), null);

  // Ownership transferred: the old owner's public links end with it.
  const pub = docs.createLink(d.id, owner, { role: 'viewer', audience: 'anyone' });
  assert.ok(docs.hasPublicLink(d.id));
  docs.share(d.id, owner, ed.sub, 'owner');
  assert.equal(docs.hasPublicLink(d.id), false);
  assert.equal(docs.peekLink(pub.key).active, false);

  // A blocked maker's links stop too.
  const edPub = docs.createLink(d.id, ed, { role: 'viewer', audience: 'anyone' });
  docs.redeemLink(edPub.key, reader);
  principals.setRole(ed.sub, 'blocked');
  assert.equal(docs.peekLink(edPub.key).active, false);
});

// ---------------------------------------------------------------- server-level

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer({ DOCS_ROLE_SWEEP_MS: '150' }); });
after(async () => { await S.close(); });

const H = (extra: Record<string, string> = {}) => ({ Origin: S.base, 'Content-Type': 'application/json', ...extra });
async function signIn(name: string, cookie?: string): Promise<string> {
  const r = await fetch(`${S.base}/auth/exchange`, { method: 'POST', headers: H({ Cookie: `docs_login=x${cookie ? `; ${cookie}` : ''}` }), body: JSON.stringify({ token: S.iss.mint(name, 'human') }) });
  assert.equal(r.status, 200);
  return `docs_session=${/docs_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')![1]}`;
}
const api = async (method: string, path: string, cookie: string | null, body?: unknown) => {
  const r = await fetch(`${S.base}${path}`, { method, headers: H(cookie ? { Cookie: cookie } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, cookie: /docs_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1] };
};
async function guestOn(owner: string, docId: string, role: 'viewer' | 'commenter' | 'editor', extra: Record<string, unknown> = {}) {
  const l = (await api('POST', `/api/docs/${docId}/links`, owner, { role, who: 'anyone', ...extra })).json;
  const red = await api('POST', '/api/links/redeem', null, { key: l.url.split('/l/')[1] });
  assert.equal(red.status, 200);
  return { link: l, cookie: `docs_session=${red.cookie}`, sub: red.json.you.sub as string };
}

test('H2: when a link expires, an open socket loses access without having to send anything', async () => {
  const ann = await signIn('Ann');
  const d = (await api('POST', '/api/docs', ann, { title: 'Expiring', content: 'base\n' })).json;
  const g = await guestOn(ann, d.id, 'editor', { expiresInDays: 1 });
  const guest = await browserClient(S, g.cookie, d.id);
  try {
    const closed = new Promise<number>((r) => guest.ws.once('close', (code) => r(code)));
    S.app.db.prepare('UPDATE doc_links SET expires_at = ? WHERE id = ?').run(Date.now() - 1, g.link.id);
    assert.equal(await closed, 4003);
  } finally { guest.close(); }
});

test('H3: every realtime reply to a guest is masked, including an explicit thread request', async () => {
  const ann = await signIn('Ann');
  const d = (await api('POST', '/api/docs', ann, { title: 'Threads', content: 'some text\n' })).json;
  const member = await browserClient(S, ann, d.id);
  await member.ask({ type: 'comment.create', body: 'member note @{human:test:ann}' });
  const g = await guestOn(ann, d.id, 'commenter');
  const guest = await browserClient(S, g.cookie, d.id);
  try {
    const ack = await guest.ask({ type: 'threads', includeResolved: true });
    assert.ok(ack.ok);
    const raw = JSON.stringify(ack);
    assert.ok(!raw.includes('human:test:ann') && raw.includes('anon:'), raw.slice(0, 300));
  } finally { guest.close(); member.close(); }
});

test('M1: pathological document/link references are refused quickly', async () => {
  const host = await rawHost(`ws://127.0.0.1:${S.port}/mcpl?token=${S.token('Fuzz')}`);
  try {
    const evil = `${'/d/a?'.repeat(400)}\nx`;
    const t0 = Date.now();
    const r1 = await host.tool('read_document', { document: evil });
    const r2 = await host.tool('revoke_link', { link: `${'/l/aaaaaaaaaaaaaaaaaaaaaaaa?'.repeat(70)}\nx` });
    const r3 = await host.tool('view_image', { document: 'dnope', image: `${'/media/'.repeat(300)}\nx` });
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
    assert.ok(r1.isError && r2.isError, JSON.stringify([r1.text, r2.text]).slice(0, 400));
    assert.match(r3.text, /hosted elsewhere|No document/);
  } finally { host.close(); }
});

test('M2: a connection can hold only a few presence slots (a guest one)', async () => {
  const ann = await signIn('Ann');
  const d = (await api('POST', '/api/docs', ann, { title: 'Crowd', content: 'x\n' })).json;
  const g = await guestOn(ann, d.id, 'viewer');
  const member = await browserClient(S, ann, d.id);
  const guest = await browserClient(S, g.cookie, d.id);
  try {
    // One frame claiming many slots is dropped whole; slot by slot, only the first sticks.
    const encoding = await import('lib0/encoding');
    const frame = (clients: number[]) => {
      const inner = encoding.createEncoder();
      encoding.writeVarUint(inner, clients.length);
      for (const c of clients) { encoding.writeVarUint(inner, c); encoding.writeVarUint(inner, 1); encoding.writeVarString(inner, JSON.stringify({ cursor: null })); }
      const outer = encoding.createEncoder();
      encoding.writeVarUint(outer, 1);
      encoding.writeVarUint8Array(outer, encoding.toUint8Array(inner));
      return encoding.toUint8Array(outer);
    };
    guest.ws.send(frame(Array.from({ length: 500 }, (_, i) => 1_000_000 + i)));
    for (let i = 0; i < 20; i++) guest.ws.send(frame([2_000_000 + i]));
    await sleep(300);
    const mine = [...member.awareness.getStates().values()].filter((st: any) => st?.user?.sub === g.sub);
    assert.equal(mine.length, 1, `member sees ${mine.length} slots from the guest`);
  } finally { guest.close(); member.close(); }
});

test('M3: guests can only comment slowly, and agents get a bounded number of their mentions', async () => {
  const ann = await signIn('Ann');
  const host = await rawHost(`ws://127.0.0.1:${S.port}/mcpl?token=${S.token('Target')}`);
  try {
    const d = (await api('POST', '/api/docs', ann, { title: 'Spam', content: 'x\n' })).json;
    await api('POST', `/api/docs/${d.id}/share`, ann, { who: '@Target', role: 'editor' });
    const results: boolean[] = [];
    for (let n = 0; n < 3; n++) {
      const g = await guestOn(ann, d.id, 'commenter');
      const guest = await browserClient(S, g.cookie, d.id);
      try { for (let i = 0; i < 6; i++) results.push((await guest.ask({ type: 'comment.create', body: `@Target spam ${n}.${i}` })).ok); } finally { guest.close(); }
    }
    assert.equal(results.filter((x) => !x).length, 3, 'the 6th comment per minute from each guest is refused');
    await sleep(300);
    const mentions = host.pushes.filter((p) => p.tags.includes('chat:mention'));
    assert.equal(mentions.length, 10, 'at most 10 guest-originated deliveries per agent per document per hour');
  } finally { host.close(); }
});

test('M4: the rate-limit key is the trusted proxy hop, and IPv6 is bucketed by /64', () => {
  const req = (xff: string | undefined, remote: string) => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } }) as unknown as IncomingMessage;
  assert.equal(clientNetwork(req('6.6.6.6, 1.2.3.4', '10.0.0.1'), 1), '1.2.3.4', 'behind one proxy: the hop it added');
  assert.equal(clientNetwork(req('6.6.6.6', '10.0.0.1'), 0), '10.0.0.1', 'no proxy: X-Forwarded-For is ignored');
  assert.equal(clientNetwork(req(undefined, '::ffff:9.9.9.9'), 0), '9.9.9.9');
  assert.equal(clientNetwork(req('2001:db8:1:2:aaaa::1', 'x'), 1), clientNetwork(req('2001:db8:1:2:bbbb::9', 'x'), 1));
  assert.notEqual(clientNetwork(req('2001:db8:1:2::1', 'x'), 1), clientNetwork(req('2001:db8:1:3::1', 'x'), 1));
});

test('L1: guests get no access warnings that would reveal who exists', async () => {
  const ann = await signIn('Ann');
  await signIn('Zed');
  const d = (await api('POST', '/api/docs', ann, { title: 'Oracle', content: 'x\n' })).json;
  const g = await guestOn(ann, d.id, 'commenter');
  const guest = await browserClient(S, g.cookie, d.id);
  try {
    const r = await guest.ask({ type: 'comment.create', body: 'hi @Zed' });
    assert.deepEqual(r.data.warnings, []);
  } finally { guest.close(); }
});

test('L3: guest names lose control and direction-override characters', () => {
  const { principals } = core();
  const g = principals.createGuest('Mallory‮​\u0085');
  assert.equal(g.name, 'Mallory (guest)');
});

test('L5: signing in ends the guest session it replaces; idle traceless guests are pruned', async () => {
  const ann = await signIn('Ann');
  const d = (await api('POST', '/api/docs', ann, { title: 'Swap', content: 'x\n' })).json;
  const g = await guestOn(ann, d.id, 'viewer');
  const guest = await browserClient(S, g.cookie, d.id);
  const closed = new Promise<number>((r) => guest.ws.once('close', (code) => r(code)));
  await signIn('Gail', g.cookie);
  assert.equal(await closed, 4001);
  guest.close();
  assert.equal((await api('GET', '/api/me', g.cookie)).json.you, null, 'the guest session is gone');
  S.app.db.prepare('UPDATE principals SET last_seen = 0 WHERE sub = ?').run(g.sub);
  pruneLinksAndGuests(S.app.db);
  assert.equal(S.app.principals.get(g.sub), null);
  assert.equal(S.app.db.prepare('SELECT count(*) AS n FROM link_holders WHERE sub = ?').get(g.sub) && (S.app.db.prepare('SELECT count(*) AS n FROM link_holders WHERE sub = ?').get(g.sub) as any).n, 0);
});

test('L6: guests: off also holds for the catch-up on reconnect', async () => {
  const ann = await signIn('Ann');
  let host = await rawHost(`ws://127.0.0.1:${S.port}/mcpl?token=${S.token('Quietly')}`);
  const d = (await api('POST', '/api/docs', ann, { title: 'Catch-up', content: 'x\n' })).json;
  await api('POST', `/api/docs/${d.id}/share`, ann, { who: '@Quietly', role: 'editor' });
  await host.tool('watch', { document: d.id, edits: 'wake', comments: 'wake', guests: 'off' });
  host.close();
  await sleep(100);
  const g = await guestOn(ann, d.id, 'editor');
  const guest = await browserClient(S, g.cookie, d.id);
  try {
    guest.doc.getText('body').insert(0, 'guest edit ');
    await guest.ask({ type: 'comment.create', body: 'guest comment' });
    await until(() => S.app.docs.text(d.id).startsWith('guest edit'), 'edit saved');
  } finally { guest.close(); }
  host = await rawHost(`ws://127.0.0.1:${S.port}/mcpl?token=${S.token('Quietly')}`);
  try {
    await sleep(400);
    assert.deepEqual(host.pushes.filter((p) => p.origin?.documentId === d.id).map((p) => p.tags), []);
  } finally { host.close(); }
});
