import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, rawHost, sleep, until } from './server-harness.js';

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.close(); });

const url = (token: string) => `ws://127.0.0.1:${S.port}/mcpl?token=${encodeURIComponent(token)}`;
const human = (name: string) => S.app.principals.admit({ sub: `human:test:${name.toLowerCase()}`, name, kind: 'human', issuer: 'test.local', scopes: [], claims: {}, exp: Date.now() / 1000 + 3600 }, 'web');
const edit = (docId: string, sub: string, fn: (t: any) => void) => S.app.docs.edit(docId, { sub, via: 'web' }, fn);

test('refuses missing, forged, wrong-audience and expired tokens; blocked principals get 403', async () => {
  await assert.rejects(rawHost(`ws://127.0.0.1:${S.port}/mcpl`), /401/);
  await assert.rejects(rawHost(url('aid1.e30.AAAA')), /401/);
  await assert.rejects(rawHost(url(S.iss.mint('Eve', 'agent', 'board'))), /401/);
  await assert.rejects(rawHost(url(S.iss.mint('Eve', 'agent', 'docs', { ttl: -10 }))), /401/);
  const h = await rawHost(url(S.token('Mallet')));
  h.close();
  S.app.principals.setRole('agent:mallet@test.local', 'blocked');
  await assert.rejects(rawHost(url(S.token('Mallet'))), /403/);
});

test('plain MCP clients get tools without MCPL negotiation and no pushes', async () => {
  const h = await rawHost(url(S.token('Plain')), { mcpl: null });
  assert.equal(h.init.result.capabilities.experimental, undefined);
  const list = await h.call('tools/list');
  assert.ok(list.result.tools.some((t: any) => t.name === 'read_document'));
  const r = await h.tool('whoami');
  assert.match(r.text, /You are Plain \(agent:plain@test\.local\), a agent|You are Plain/);
  h.close();
});

test('MCPL: no tools before a grant; feature-set narrowing hides and refuses tools', async () => {
  const h = await rawHost(url(S.token('Narrow')), { grant: [], enabled: ['docs.read'] });
  const denied = await h.call('tools/list');
  assert.equal(denied.error?.code, -32002);
  const p = await h.call('featureSets/update', { effectiveCapabilities: ['tools'], enabled: ['docs.read'] });
  assert.equal(p.result.accepted, true);
  const names = (await h.call('tools/list')).result.tools.map((t: any) => t.name);
  assert.ok(names.includes('read_document'));
  assert.ok(!names.includes('edit_document'));
  const r = await h.call('tools/call', { name: 'edit_document', arguments: {} });
  assert.equal(r.error?.code, -32001);
  // Tools carry RFC-008 classes as arrays.
  const t = (await h.call('tools/list')).result.tools[0];
  assert.ok(Array.isArray(t._meta['mcpl/class']));
  h.close();
});

test('deferred host: edits by others become one notice per settle; push/render returns the attributed diff once', async () => {
  const ada = human('Ada');
  const h = await rawHost(url(S.token('Watcher')));
  const d = S.app.docs.create(ada, 'Plan', '# Plan\n\nAlpha.\n');
  S.app.docs.share(d.id, ada, 'agent:watcher@test.local', 'editor');
  await h.tool('read_document', { document: d.id });
  await h.tool('watch', { document: d.id, settle_seconds: 0.05 });
  h.pushes.length = 0;
  edit(d.id, ada.sub, (t) => t.insert(t.length, 'Beta.\n'));
  edit(d.id, ada.sub, (t) => t.insert(t.length, 'Gamma.\n'));
  await until(() => h.pushes.some((p) => p.coalesce?.key === `doc:${d.id}:edits`), 'edit notice');
  await sleep(100);
  const notices = h.pushes.filter((p) => p.coalesce?.key === `doc:${d.id}:edits`);
  assert.equal(notices.length, 1, 'two quick edits settle into one notice');
  const n = notices[0];
  assert.equal(n.coalesce.deferred, true);
  assert.deepEqual(n.tags.filter((t: string) => t.startsWith('docs:')).sort(), ['docs:edit', 'docs:quiet']);
  assert.match(n.payload.content[0].text, /was edited by Ada/);
  const diff = await h.render(`doc:${d.id}:edits`);
  assert.match(diff, /\+Beta\./);
  assert.match(diff, /\+Gamma\./);
  assert.match(diff, /Ada/);
  assert.equal(await h.render(`doc:${d.id}:edits`), '', 'nothing new after a render');
  h.close();
});

test('own edits are folded into the baseline and never reported back', async () => {
  const ada = human('Ada');
  const h = await rawHost(url(S.token('Self')));
  const d = S.app.docs.create(ada, 'Mine', 'one\ntwo\nthree\n');
  S.app.docs.share(d.id, ada, 'agent:self@test.local', 'editor');
  await h.tool('read_document', { document: d.id });
  await h.tool('edit_document', { document: d.id, edits: [{ old_text: 'two', new_text: 'TWO (agent)' }] });
  edit(d.id, ada.sub, (t) => t.insert(0, 'zero\n'));
  const r = await h.tool('changes', { document: d.id });
  assert.match(r.text, /\+zero/);
  assert.doesNotMatch(r.text, /\+TWO \(agent\)/);
  h.close();
});

test('wake gates: from, min_chars, keywords, sections, cooldown, quiet_until decide docs:wake vs docs:quiet', async () => {
  const ada = human('Ada');
  const other = S.app.principals.admit({ sub: 'agent:other@test.local', name: 'Other', kind: 'agent', issuer: 'test.local', scopes: [], claims: {}, exp: Date.now() / 1000 + 3600 }, 'mcpl');
  const h = await rawHost(url(S.token('Gated')));
  const d = S.app.docs.create(ada, 'Gates', '# Top\n\n## Budget\n\nx\n\n## Misc\n\ny\n');
  S.app.docs.share(d.id, ada, 'agent:gated@test.local', 'editor');
  S.app.docs.share(d.id, ada, other.sub, 'editor');
  await h.tool('read_document', { document: d.id });
  const next = async (fn: () => void) => {
    const n = h.pushes.length;
    fn();
    await until(() => h.pushes.slice(n).some((p) => p.coalesce?.key === `doc:${d.id}:edits`), 'notice');
    const p = h.pushes.slice(n).find((x) => x.coalesce?.key === `doc:${d.id}:edits`);
    await h.render(`doc:${d.id}:edits`);
    return p.tags.includes('docs:wake') ? 'wake' : 'quiet';
  };
  await h.tool('watch', { document: d.id, edits: 'wake', from: 'humans', settle_seconds: 0.03 });
  assert.equal(await next(() => edit(d.id, ada.sub, (t) => t.insert(0, 'a'))), 'wake');
  assert.equal(await next(() => edit(d.id, other.sub, (t) => t.insert(0, 'b'))), 'quiet', 'agents\' edits don\'t wake a humans-only gate');
  await h.tool('watch', { document: d.id, min_chars: 20 });
  assert.equal(await next(() => edit(d.id, ada.sub, (t) => t.insert(0, 'c'))), 'quiet', 'below min_chars');
  assert.equal(await next(() => edit(d.id, ada.sub, (t) => t.insert(0, 'this is a much longer insertion\n'))), 'wake');
  await h.tool('watch', { document: d.id, min_chars: 0, keywords: ['urgent', 'blocker'] });
  assert.equal(await next(() => edit(d.id, ada.sub, (t) => t.insert(0, 'calm '))), 'quiet');
  assert.equal(await next(() => edit(d.id, ada.sub, (t) => t.insert(0, 'URGENT '))), 'wake');
  await h.tool('watch', { document: d.id, keywords: [], sections: ['Budget'] });
  assert.equal(await next(() => edit(d.id, ada.sub, (t) => { const s = t.toString(); t.insert(s.indexOf('y\n'), 'misc '); })), 'quiet');
  assert.equal(await next(() => edit(d.id, ada.sub, (t) => { const s = t.toString(); t.insert(s.indexOf('x\n'), 'money '); })), 'wake');
  await h.tool('watch', { document: d.id, sections: [], cooldown_seconds: 0.4 });
  assert.equal(await next(() => edit(d.id, ada.sub, (t) => t.insert(0, 'd'))), 'quiet', 'the previous wake is within the cooldown');
  await sleep(450);
  assert.equal(await next(() => edit(d.id, ada.sub, (t) => t.insert(0, 'd'))), 'wake', 'cooldown elapsed');
  assert.equal(await next(() => edit(d.id, ada.sub, (t) => t.insert(0, 'e'))), 'quiet', 'within cooldown');
  await h.tool('watch', { document: d.id, cooldown_seconds: 0, quiet_until: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(await next(() => edit(d.id, ada.sub, (t) => t.insert(0, 'f'))), 'quiet', 'quiet_until');
  await h.tool('watch', { document: d.id, edits: 'off', quiet_until: null });
  const n = h.pushes.length;
  edit(d.id, ada.sub, (t) => t.insert(0, 'g'));
  await sleep(150);
  assert.equal(h.pushes.slice(n).filter((p) => p.coalesce?.key === `doc:${d.id}:edits`).length, 0, 'off delivers nothing');
  h.close();
});

test('addressed comments: mention → plain keyed event; edit → replacement; delete → retraction', async () => {
  const ada = human('Ada');
  const h = await rawHost(url(S.token('Mentioned')));
  const d = S.app.docs.create(ada, 'Talk', 'Hello world.\n');
  S.app.docs.share(d.id, ada, 'agent:mentioned@test.local', 'commenter');
  const c = S.app.comments.create(d.id, ada, { body: 'Hey @Mentioned, thoughts?', anchor: S.app.comments.anchorFromQuote(d.id, 'world') });
  await until(() => h.pushes.some((p) => p.coalesce?.key === `comment:${c.comment.id}`), 'mention push');
  const m = h.pushes.find((p) => p.coalesce?.key === `comment:${c.comment.id}`);
  assert.equal(m.coalesce.initial, true);
  assert.equal(m.coalesce.deferred, undefined);
  for (const t of ['chat:mention', 'chat:addressed', 'chat:from-human', 'docs:comment', 'docs:wake']) assert.ok(m.tags.includes(t), t);
  assert.match(m.payload.content[0].text, /on “world” \(line 1\)/);
  S.app.comments.editBody(c.comment.id, ada, 'Hey @Mentioned, thoughts on the greeting?');
  await until(() => h.pushes.filter((p) => p.coalesce?.key === `comment:${c.comment.id}`).length === 2, 'replacement');
  const r = h.pushes.filter((p) => p.coalesce?.key === `comment:${c.comment.id}`)[1];
  assert.ok(r.tags.includes('chat:edited') && r.tags.includes('docs:wake') && !r.coalesce.initial, 'a replacement keeps its original treatment');
  S.app.comments.remove(c.comment.id, ada);
  await until(() => h.pushes.some((p) => p.coalesce?.key === `comment:${c.comment.id}` && p.coalesce.retract), 'retraction');
  // The agent replies via tool; the human's thread gets it.
  const c2 = S.app.comments.create(d.id, ada, { body: '@Mentioned second question' });
  const rep = await h.tool('reply_comment', { comment: c2.comment.id, text: 'Answer from the agent.' });
  assert.match(rep.text, /Replied/);
  assert.equal(S.app.comments.thread(c2.comment.id)!.replies[0].author, 'agent:mentioned@test.local');
  h.close();
});

test('non-coalescing host: edits arrive as ready-made diffs; retractions degrade to plain notices', async () => {
  const ada = human('Ada');
  const h = await rawHost(url(S.token('OldHost')), { mcpl: { version: '0.5', pushEvents: true } });
  const d = S.app.docs.create(ada, 'Old', 'base\n');
  S.app.docs.share(d.id, ada, 'agent:oldhost@test.local', 'editor');
  await h.tool('read_document', { document: d.id });
  await h.tool('watch', { document: d.id, settle_seconds: 0.03 });
  edit(d.id, ada.sub, (t) => t.insert(t.length, 'added line\n'));
  await until(() => h.pushes.some((p) => p.tags.includes('docs:edit')), 'edit push');
  const p = h.pushes.find((x) => x.tags.includes('docs:edit'));
  assert.equal(p.coalesce, undefined);
  assert.match(p.payload.content[0].text, /\+added line/);
  const c = S.app.comments.create(d.id, ada, { body: '@OldHost ping' });
  await until(() => h.pushes.some((x) => x.origin?.commentId === c.comment.id), 'mention');
  S.app.comments.remove(c.comment.id, ada);
  await until(() => h.pushes.some((x) => x.tags.includes('chat:deleted')), 'deletion notice');
  assert.ok(h.pushes.every((x) => x.coalesce === undefined));
  h.close();
});

test('offline agents: mentions queue in the outbox; a mention deleted while offline is never delivered; edits catch up on connect', async () => {
  const ada = human('Ada');
  const h0 = await rawHost(url(S.token('Sleeper')));
  const d = S.app.docs.create(ada, 'Later', 'start\n');
  S.app.docs.share(d.id, ada, 'agent:sleeper@test.local', 'editor');
  await h0.tool('read_document', { document: d.id });
  await h0.tool('watch', { document: d.id, settle_seconds: 0.03 });
  h0.close();
  await sleep(50);
  const kept = S.app.comments.create(d.id, ada, { body: '@Sleeper please review when you are back' });
  const dropped = S.app.comments.create(d.id, ada, { body: '@Sleeper never mind this one' });
  S.app.comments.remove(dropped.comment.id, ada);
  edit(d.id, ada.sub, (t) => t.insert(t.length, 'while you were away\n'));
  await sleep(100);
  const h = await rawHost(url(S.token('Sleeper')));
  await until(() => h.pushes.some((p) => p.origin?.commentId === kept.comment.id), 'queued mention delivered');
  await until(() => h.pushes.some((p) => p.coalesce?.key === `doc:${d.id}:edits`), 'catch-up edit notice');
  assert.ok(!h.pushes.some((p) => p.origin?.commentId === dropped.comment.id), 'deleted-while-offline mention never delivered');
  assert.match(await h.render(`doc:${d.id}:edits`), /\+while you were away/);
  h.close();
});

test('connections close when the identity token expires', async () => {
  const h = await rawHost(url(S.iss.mint('Brief', 'agent', 'docs', { ttl: 1 })));
  const { code } = await h.closed;
  assert.equal(code, 4001);
});

test('sharing an agent notifies it; first render of an unread document is an outline, not a dump', async () => {
  const ada = human('Ada');
  const h = await rawHost(url(S.token('Newcomer')));
  const d = S.app.docs.create(ada, 'Handbook', '# Handbook\n\n## Intro\n\ntext\n\n## Rules\n\nmore\n');
  S.app.docs.share(d.id, ada, 'agent:newcomer@test.local', 'viewer');
  await until(() => h.pushes.some((p) => p.tags.includes('docs:share')), 'share push');
  assert.ok(h.pushes.find((p) => p.tags.includes('docs:share')).tags.includes('docs:wake'));
  const out = await h.render(`doc:${d.id}:edits`);
  assert.match(out, /You have not read it yet; outline/);
  assert.match(out, /Rules \(line 7\)/);
  h.close();
});
