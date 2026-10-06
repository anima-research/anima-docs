import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { startServer, rawHost, until, sleep, browserClient } from './server-harness.js';

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.close(); });

async function signIn(name: string): Promise<string> {
  const r = await fetch(`${S.base}/auth/exchange`, { method: 'POST', headers: { Origin: S.base, Cookie: 'docs_login=x', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: S.iss.mint(name, 'human') }) });
  return `docs_session=${/docs_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')![1]}`;
}

const browser = (cookie: string, docId: string, origin = S.base) => browserClient(S, cookie, docId, origin);

const rel = (doc: Y.Doc, from: number, to: number) => ({
  start: Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(doc.getText('body'), from, 0))).toString('base64'),
  end: Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(doc.getText('body'), to, -1))).toString('base64'),
});

test('cross-origin and unauthorized sockets are refused', async () => {
  const ann = await signIn('Ann');
  const d = S.app.docs.create(S.app.principals.get('human:test:ann') as any, 'X', 'x');
  await assert.rejects(browser(ann, d.id, 'https://evil.example'), /403/);
  await assert.rejects(browser('docs_session=nope', d.id), /401/);
  const bob = await signIn('Bob');
  await assert.rejects(browser(bob, d.id), /404/);
});

test('two editors converge; a viewer syncs silently and cannot write; identities in awareness come from the session', async () => {
  const ann = await signIn('Ann'), bob = await signIn('Bob'), vic = await signIn('Vic');
  const annP = S.app.principals.admit({ sub: 'human:test:ann', name: 'Ann', kind: 'human', issuer: 'test.local', scopes: [], claims: {}, exp: Date.now() / 1000 + 3600 }, 'web');
  const d = S.app.docs.create(annP, 'Live', 'Hello\n');
  S.app.docs.share(d.id, annP, 'human:test:bob', 'editor');
  S.app.docs.share(d.id, annP, 'human:test:vic', 'viewer');
  const a = await browser(ann, d.id), b = await browser(bob, d.id), v = await browser(vic, d.id);
  assert.equal(a.text(), 'Hello\n');
  a.doc.getText('body').insert(5, ', world');
  b.doc.getText('body').insert(0, '# ');
  await until(() => a.text() === '# Hello, world\n' && b.text() === a.text() && v.text() === a.text(), 'convergence');
  assert.equal(S.app.docs.text(d.id), '# Hello, world\n');
  await sleep(50);
  assert.ok(!v.json.some((m) => m.type === 'error'), 'a viewer\'s benign sync is not an error');
  v.doc.getText('body').insert(0, 'VANDAL ');
  await until(() => v.json.some((m) => m.type === 'error'), 'viewer edit refused');
  assert.ok(!S.app.docs.text(d.id).includes('VANDAL'));
  // Spoofed awareness name is overwritten with the session identity.
  b.awareness.setLocalState({ user: { name: 'Ann (definitely)' }, cursor: null });
  await until(() => [...a.awareness.getStates().values()].some((s: any) => s.user?.sub === 'human:test:bob'), 'bob in awareness');
  const bobState = [...a.awareness.getStates().values()].find((s: any) => s.user?.sub === 'human:test:bob') as any;
  assert.equal(bobState.user.name, 'Bob');
  a.close(); b.close(); v.close();
});

test('comments over the socket with client anchors; threads broadcast; an MCPL agent\'s edit and presence arrive live', async () => {
  const ann = await signIn('Ann');
  const annP = S.app.principals.get('human:test:ann')!;
  const agentHost = await rawHost(`ws://127.0.0.1:${S.port}/mcpl?token=${encodeURIComponent(S.token('Scribe'))}`);
  const d = S.app.docs.create({ ...annP, admin: false, scopes: [], via: 'web', exp: 0 } as any, 'Notes', 'The cat sat on the mat.\n');
  S.app.docs.share(d.id, { ...annP, admin: false } as any, 'agent:scribe@test.local', 'editor');
  const a = await browser(ann, d.id);
  const t = a.text();
  const r = await a.ask({ type: 'comment.create', body: '@Scribe is "cat" right?', anchor: rel(a.doc, t.indexOf('cat'), t.indexOf('cat') + 3) });
  assert.equal(r.ok, true, r.error);
  await until(() => a.json.some((m) => m.type === 'threads' && m.threads.some((th: any) => th.id === r.data.id)), 'threads broadcast');
  await until(() => agentHost.pushes.some((p) => p.origin?.commentId === r.data.id), 'agent got the mention');
  // Agent edits through MCPL; the browser sees the text and the agent's cursor.
  await agentHost.tool('edit_document', { document: d.id, edits: [{ old_text: 'cat', new_text: 'dog' }] });
  await until(() => a.text().includes('dog'), 'agent edit arrives live');
  await until(() => [...a.awareness.getStates().values()].some((s: any) => s.user?.name === 'Scribe' && s.user?.kind === 'agent' && s.cursor), 'agent presence with cursor');
  // The comment anchor followed the replacement (anchored text "cat" was deleted → orphaned).
  const th = (await a.ask({ type: 'threads', includeResolved: true })).data.find((x: any) => x.id === r.data.id);
  assert.equal(th.quote, 'cat');
  const reply = await a.ask({ type: 'comment.reply', comment: r.data.id, body: 'thanks', resolve: true });
  assert.equal(reply.ok, true);
  a.close(); agentHost.close();
});
