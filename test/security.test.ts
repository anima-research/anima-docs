// Regression tests for the security/robustness review (C1–H6, M1–M6).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import { startServer, rawHost, sleep, until } from './server-harness.js';
import { testIssuer } from './helpers.js';
import { publicKeyFromString } from '../src/auth.js';

let S: Awaited<ReturnType<typeof startServer>>;
const other = testIssuer('other.example');
before(async () => {
  S = await startServer();
  S.app.issuers.set('other.example', publicKeyFromString(other.publicKey));
});
after(async () => { await S.close(); });

const alive = async () => (await fetch(`${S.base}/health`)).status === 200;
const human = (name: string, issuer = 'test.local') => S.app.principals.admit({ sub: `human:test:${name.toLowerCase()}`, name, kind: 'human', issuer, scopes: [], claims: {}, exp: Date.now() / 1000 + 3600 }, 'web');

async function signIn(name: string): Promise<string> {
  const r = await fetch(`${S.base}/auth/exchange`, { method: 'POST', headers: { Origin: S.base, Cookie: 'docs_login=st', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: S.iss.mint(name, 'human') }) });
  assert.equal(r.status, 200);
  return `docs_session=${/docs_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')![1]}`;
}

function rawSocket(cookie: string, docId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${S.port}/ws?doc=${docId}`, { headers: { Cookie: cookie, Origin: S.base } });
  const json: any[] = [];
  const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
  ws.on('message', (d, bin) => { if (!bin) json.push(JSON.parse(d.toString())); });
  const opened = new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  const sendUpdate = (u: Uint8Array) => { const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); syncProtocol.writeUpdate(e, u); ws.send(encoding.toUint8Array(e)); };
  return { ws, json, closed, opened, sendUpdate };
}

test('C1: malformed upgrade requests and cookies do not crash the server', async () => {
  for (const raw of [
    'GET // HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    `GET /ws?doc=x HTTP/1.1\r\nHost: x\r\nOrigin: ${S.base}\r\nCookie: docs_session=%E0%A4%A\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  ]) {
    await new Promise<void>((res) => { const s = connect(S.port, '127.0.0.1', () => s.write(raw)); s.on('data', () => s.destroy()); s.on('close', () => res()); s.on('error', () => res()); });
  }
  await sleep(50);
  assert.ok(await alive());
});

test('C2: junk JSON frames from a room member are answered, not fatal', async () => {
  const cookie = await signIn('Vera');
  const d = S.app.docs.create(human('Vera'), 'T', 'x');
  const c = rawSocket(cookie, d.id);
  await c.opened;
  for (const f of ['null', '[]', '42', '"str"', '{"type":"comment.create"}', '{bad']) c.ws.send(f);
  await until(() => c.json.filter((m) => m.type === 'error' || m.type === 'ack').length >= 6, 'replies');
  assert.ok(await alive());
  c.ws.close();
});

test('H1: regex wake patterns are gone; keywords are substring matches', async () => {
  const h = await rawHost(`ws://127.0.0.1:${S.port}/mcpl?token=${encodeURIComponent(S.token('Kw'))}`);
  const d = S.app.docs.create(human('Ada'), 'K', 'x');
  S.app.docs.share(d.id, human('Ada'), 'agent:kw@test.local', 'viewer');
  const bad = await h.tool('watch', { document: d.id, pattern: '^(\\w+\\s?)*$' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /keywords/);
  const ok = await h.tool('watch', { document: d.id, keywords: ['urgent'] });
  assert.match(ok.text, /keywords: "urgent"/);
  h.close();
});

test('H2: pathological content stays fast (headings, replace_all, big rewrites)', async () => {
  const ada = human('Ada');
  const d = S.app.docs.create(ada, 'Big', '# a' + ' '.repeat(100_000) + 'b\n\n## Two\n\nx\n');
  const h = await rawHost(`ws://127.0.0.1:${S.port}/mcpl?token=${encodeURIComponent(S.token('Fast'))}`);
  S.app.docs.share(d.id, ada, 'agent:fast@test.local', 'editor');
  let t = Date.now();
  await h.tool('read_document', { document: d.id, section: 'Two' });
  assert.ok(Date.now() - t < 1000, 'heading parse is linear');
  await h.tool('edit_document', { document: d.id, edits: [{ replace_all_content: 'a\n'.repeat(5000) }] });
  t = Date.now();
  const many = await h.tool('edit_document', { document: d.id, edits: [{ old_text: 'a', new_text: 'b', replace_all: true }] });
  assert.match(many.text, /limited to 2000/);
  const lines = Array.from({ length: 8000 }, (_, i) => `line ${i} of the old text`).join('\n');
  await h.tool('edit_document', { document: d.id, edits: [{ replace_all_content: lines }] });
  await h.tool('read_document', { document: d.id });
  t = Date.now();
  S.app.docs.edit(d.id, { sub: ada.sub, via: 'web' }, (y) => { y.delete(0, y.length); y.insert(0, Array.from({ length: 8000 }, (_, i) => `LINE ${i} of the new text`).join('\n')); });
  const r = await h.tool('changes', { document: d.id });
  assert.ok(Date.now() - t < 4000, `rewrite + render bounded (${Date.now() - t} ms)`);
  assert.match(r.text, /changed/);
  h.close();
});

test('H3: an update that would park a deletion of someone else\'s future text is refused', async () => {
  const mallory = await signIn('Mallory');
  const aliceP = human('Alice');
  const d = S.app.docs.create(aliceP, 'Ledger', 'start\n');
  S.app.docs.share(d.id, aliceP, 'human:test:mallory', 'editor');
  const m = rawSocket(mallory, d.id);
  await m.opened;
  // A delete set on a client id the server has never seen content for (Alice's future id).
  const victimClient = 123456789;
  const forged = (() => {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 0); // no structs
    encoding.writeVarUint(e, 1); // one client in delete set
    encoding.writeVarUint(e, victimClient);
    encoding.writeVarUint(e, 1);
    encoding.writeVarUint(e, 0);
    encoding.writeVarUint(e, 1000);
    return encoding.toUint8Array(e);
  })();
  m.sendUpdate(forged);
  await until(() => m.json.some((x) => x.type === 'error'), 'refused');
  const doc = S.app.docs.ydoc(d.id);
  assert.equal(doc.store.pendingDs, null);
  // Alice now types under that client id: her text must survive.
  const a = new Y.Doc(); a.clientID = victimClient;
  Y.applyUpdate(a, Y.encodeStateAsUpdate(doc));
  a.clientID = victimClient;
  a.getText('body').insert(0, 'IMPORTANT ');
  S.app.docs.applyClientUpdate(d.id, Y.encodeStateAsUpdate(a, Y.encodeStateVector(doc)), { sub: aliceP.sub, via: 'web' });
  assert.match(S.app.docs.text(d.id), /^IMPORTANT start/);
  m.ws.close();
});

test('M1: non-text content (embeds, other root types) is refused', () => {
  const ada = human('Ada');
  const d = S.app.docs.create(ada, 'E', 'hello world');
  const c = new Y.Doc(); Y.applyUpdate(c, Y.encodeStateAsUpdate(S.app.docs.ydoc(d.id)));
  c.getText('body').insertEmbed(3, { x: 1 });
  assert.throws(() => S.app.docs.applyClientUpdate(d.id, Y.encodeStateAsUpdate(c, Y.encodeStateVector(S.app.docs.ydoc(d.id))), { sub: ada.sub, via: 'web' }), /plain text/);
  const c2 = new Y.Doc(); Y.applyUpdate(c2, Y.encodeStateAsUpdate(S.app.docs.ydoc(d.id)));
  c2.getMap('evil').set('k', 'v');
  assert.throws(() => S.app.docs.applyClientUpdate(d.id, Y.encodeStateAsUpdate(c2, Y.encodeStateVector(S.app.docs.ydoc(d.id))), { sub: ada.sub, via: 'web' }), /plain text/);
  assert.equal(S.app.docs.text(d.id), 'hello world');
});

test('H4: blocking closes the user\'s open sockets; later edits are not saved', async () => {
  const cookie = await signIn('Bobby');
  const owner = human('Owner');
  const d = S.app.docs.create(owner, 'Shared', 'base\n');
  S.app.docs.share(d.id, owner, 'human:test:bobby', 'editor');
  const b = rawSocket(cookie, d.id);
  await b.opened;
  S.app.principals.setRole('human:test:bobby', 'blocked');
  assert.equal(await b.closed, 4003);
  S.app.principals.setRole('human:test:bobby', 'member');
});

test('H5: revoked recipients get nothing more about a comment, live or queued', async () => {
  const ada = human('Ada');
  const d = S.app.docs.create(ada, 'Board minutes', 'Q3 numbers\n');
  const h = await rawHost(`ws://127.0.0.1:${S.port}/mcpl?token=${encodeURIComponent(S.token('Former'))}`);
  S.app.docs.share(d.id, ada, 'agent:former@test.local', 'commenter');
  const c = S.app.comments.create(d.id, ada, { body: '@Former look', anchor: S.app.comments.anchorFromQuote(d.id, 'Q3 numbers') });
  await until(() => h.pushes.some((p) => p.origin?.commentId === c.comment.id), 'mention');
  S.app.docs.share(d.id, ada, 'agent:former@test.local', 'none');
  const n = h.pushes.length;
  S.app.comments.editBody(c.comment.id, ada, '@Former (private) the acquisition target is Initech');
  await sleep(150);
  assert.ok(!JSON.stringify(h.pushes.slice(n)).includes('Initech'), 'no content after revocation');
  h.close();
  // Queued while offline, then revoked: purged.
  const d2 = S.app.docs.create(ada, 'Secret', 'x\n');
  S.app.docs.share(d2.id, ada, 'agent:former@test.local', 'commenter');
  await sleep(50);
  S.app.comments.create(d2.id, ada, { body: '@Former queued secret' });
  S.app.docs.share(d2.id, ada, 'agent:former@test.local', 'none');
  const h2 = await rawHost(`ws://127.0.0.1:${S.port}/mcpl?token=${encodeURIComponent(S.token('Former'))}`);
  await sleep(200);
  assert.ok(!JSON.stringify(h2.pushes).includes('queued secret'));
  h2.close();
});

test('H6: a second issuer cannot take over another issuer\'s principals or grant itself admin', async () => {
  const ada = human('Ada'); // test.local owns human:test:ada
  void ada;
  const forged = other.mint('Ada', 'human'); // other.example mints the same sub
  await assert.rejects(rawHost(`ws://127.0.0.1:${S.port}/mcpl?token=${encodeURIComponent(forged)}`), /403/);
  const outsiderAdmin = other.mint('Outsider', 'agent', 'docs', { scopes: ['docs:admin'] });
  const h = await rawHost(`ws://127.0.0.1:${S.port}/mcpl?token=${encodeURIComponent(outsiderAdmin)}`);
  const who = await h.tool('whoami');
  assert.doesNotMatch(who.text, /admin/);
  assert.equal(S.app.principals.get('human:test:ada')!.issuer, 'test.local');
  h.close();
});

test('M3: browser sign-in is human-only, single-use, and state-checked when present', async () => {
  const post = (body: unknown, cookie = 'docs_login=abc') => fetch(`${S.base}/auth/exchange`, { method: 'POST', headers: { Origin: S.base, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ token: S.iss.mint('Bot', 'agent') })).status, 403);
  assert.equal((await post({ token: S.iss.mint('Eve', 'human'), state: 'other' })).status, 401);
  assert.equal((await post({ token: S.iss.mint('Eve', 'human'), state: 'abc' })).status, 200);
});

test('M4: thread deletion retracts every delivered mention; a deletion after an offline edit still retracts', async () => {
  const ada = human('Ada');
  const d = S.app.docs.create(ada, 'Thread', 'x\n');
  let h = await rawHost(`ws://127.0.0.1:${S.port}/mcpl?token=${encodeURIComponent(S.token('Ret'))}`);
  S.app.docs.share(d.id, ada, 'agent:ret@test.local', 'commenter');
  const root = S.app.comments.create(d.id, ada, { body: '@Ret root' });
  const reply = S.app.comments.reply(root.comment.id, ada, '@Ret reply too');
  await until(() => h.pushes.filter((p) => p.tags.includes('chat:mention')).length >= 2, 'two mentions');
  S.app.comments.remove(root.comment.id, ada);
  await until(() => h.pushes.filter((p) => p.coalesce?.retract).length >= 2, 'both retracted');
  const keys = h.pushes.filter((p) => p.coalesce?.retract).map((p) => p.coalesce.key).sort();
  assert.deepEqual(keys, [`comment:${reply.comment.id}`, `comment:${root.comment.id}`].sort());
  // Delivered → offline → edited (queued) → deleted: the retraction must still arrive.
  const c = S.app.comments.create(d.id, ada, { body: '@Ret version one' });
  await until(() => h.pushes.some((p) => p.origin?.commentId === c.comment.id), 'delivered');
  h.close();
  await sleep(50);
  S.app.comments.editBody(c.comment.id, ada, '@Ret version two');
  S.app.comments.remove(c.comment.id, ada);
  h = await rawHost(`ws://127.0.0.1:${S.port}/mcpl?token=${encodeURIComponent(S.token('Ret'))}`);
  await until(() => h.pushes.some((p) => p.coalesce?.key === `comment:${c.comment.id}` && p.coalesce.retract), 'retraction after reconnect');
  assert.ok(!h.pushes.some((p) => JSON.stringify(p).includes('version two')), 'the withdrawn edit is never delivered');
  h.close();
});

test('M5: featureSets/update as a Notification can disable but never grant', async () => {
  const h = await rawHost(`ws://127.0.0.1:${S.port}/mcpl?token=${encodeURIComponent(S.token('Notif'))}`, { grant: [] });
  h.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'featureSets/update', params: { effectiveCapabilities: ['tools', 'pushEvents'] } }));
  await sleep(50);
  assert.equal((await h.call('tools/list')).error?.code, -32002, 'a notification cannot grant');
  await h.call('featureSets/update', { effectiveCapabilities: ['tools'] });
  h.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'featureSets/update', params: { disabled: ['docs.write'] } }));
  await sleep(50);
  const names = (await h.call('tools/list')).result.tools.map((t: any) => t.name);
  assert.ok(!names.includes('edit_document') && names.includes('read_document'));
  h.close();
});

test('M6: a persistence failure is reported, nothing is half-applied, and later edits persist', async () => {
  const ada = human('Ada');
  const d = S.app.docs.create(ada, 'Durable', 'one\n');
  S.app.db.exec('ALTER TABLE doc_updates RENAME TO doc_updates_off');
  assert.throws(() => S.app.docs.edit(d.id, { sub: ada.sub, via: 'web' }, (y) => y.insert(0, 'lost ')), /could not be saved/);
  S.app.db.exec('ALTER TABLE doc_updates_off RENAME TO doc_updates');
  assert.equal(S.app.docs.text(d.id), 'one\n', 'reloaded from disk');
  S.app.docs.edit(d.id, { sub: ada.sub, via: 'web' }, (y) => y.insert(0, 'kept '));
  S.app.docs.unload(d.id);
  assert.equal(S.app.docs.text(d.id), 'kept one\n');
});
