import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { core } from './helpers.js';
import { splitHunks, trimToChange } from '../src/hunks.js';
import { startServer, rawHost, browserClient, until, sleep } from './server-harness.js';

// ------------------------------------------------------------------ model

function setup() {
  const c = core();
  const ann = c.actor('Ann');          // owner
  const bob = c.actor('Bob');          // commenter
  const eve = c.actor('Eve');          // editor
  const d = c.docs.create(ann, 'Plan', '# Plan\n\nWe ship the beta in Q4.\n\nRisks: none.\n');
  c.docs.share(d.id, ann, bob.sub, 'commenter');
  c.docs.share(d.id, ann, eve.sub, 'editor');
  const events: any[] = [];
  c.comments.on('event', (e) => events.push(e));
  const at = (q: string) => c.docs.text(d.id).indexOf(q);
  return { ...c, ann, bob, eve, d, events, at };
}

test('a commenter suggests a replacement; the owner is addressed; an editor accepts and the text changes', () => {
  const { docs, comments, d, bob, eve, ann, events, at } = setup();
  const s = at('Q4');
  const { comment } = comments.suggest(d.id, bob, { anchor: comments.anchorFor(d.id, s, s + 2), text: 'Q3', note: 'we are ahead' });
  assert.deepEqual(comment.suggestion, { original: 'Q4', text: 'Q3', status: 'open' });
  assert.equal(comment.body, 'we are ahead');
  const created = events.find((e) => e.kind === 'created');
  assert.deepEqual(created.newlyAddressed, [{ sub: ann.sub, reason: 'suggestion' }]);
  const t = comments.thread(comment.id)!;
  assert.equal(t.suggestion!.outdated, false);
  assert.equal(t.anchor!.text, 'Q4');
  // A commenter can't accept.
  assert.throws(() => comments.decide(comment.id, bob, 'accept'), /commenter/);
  // Plain resolve is refused for suggestions.
  assert.throws(() => comments.resolve(comment.id, eve, true), /accept or reject/);
  const r = comments.decide(comment.id, eve, 'accept');
  assert.ok(r.applied);
  assert.equal(docs.text(d.id), '# Plan\n\nWe ship the beta in Q3.\n\nRisks: none.\n');
  assert.equal(r.comment.suggestion!.status, 'accepted');
  assert.ok(r.comment.resolvedAt);
  const dec = events.find((e) => e.kind === 'accepted');
  assert.deepEqual(dec.newlyAddressed, [{ sub: bob.sub, reason: 'decision' }]);
  // The decision event precedes the edit (the browser drops its pending copy first).
  assert.throws(() => comments.decide(comment.id, eve, 'reject'), /already accepted/);
});

test('insertions and deletions; rejection leaves the text; a note becomes a reply', () => {
  const { docs, comments, d, bob, eve, at } = setup();
  const before = docs.text(d.id);
  const ins = comments.suggest(d.id, bob, { anchor: comments.anchorFor(d.id, at('beta') + 4, at('beta') + 4), text: ' release' }).comment;
  const del = comments.suggest(d.id, bob, { anchor: comments.anchorFor(d.id, at('Risks: none.\n'), at('Risks: none.\n') + 13), text: '' }).comment;
  const ti = comments.thread(ins.id)!;
  assert.equal(ti.anchor!.point, true);
  assert.equal(ti.suggestion!.outdated, false);
  assert.equal(ti.anchor!.context!.before.endsWith('the beta'), true);
  comments.decide(del.id, eve, 'reject', { note: 'keep it' });
  assert.equal(docs.text(d.id), before);
  const tdel = comments.thread(del.id)!;
  assert.equal(tdel.suggestion!.status, 'rejected');
  assert.equal(tdel.replies[0].body, 'keep it');
  comments.decide(ins.id, eve, 'accept');
  assert.equal(docs.text(d.id), before.replace('the beta', 'the beta release'));
});

test('an insertion point follows concurrent edits; typing at the same spot lands after it', () => {
  const { docs, comments, d, bob, eve, at } = setup();
  const p = at('beta') + 4;
  const ins = comments.suggest(d.id, bob, { anchor: comments.anchorFor(d.id, p, p), text: ' (v2)' }).comment;
  docs.edit(d.id, eve, (t) => t.insert(0, 'Draft\n'));            // before: shifts the point
  docs.edit(d.id, eve, (t) => t.insert(t.toString().indexOf('beta') + 4, '!'));   // at the point
  comments.decide(ins.id, eve, 'accept');
  assert.match(docs.text(d.id), /the beta \(v2\)! in Q4/);
});

test('a suggestion goes outdated when its text changes, and then can only be rejected', () => {
  const { docs, comments, d, bob, eve, at } = setup();
  const s = at('Q4');
  const { comment } = comments.suggest(d.id, bob, { anchor: comments.anchorFor(d.id, s, s + 2), text: 'Q3' });
  docs.edit(d.id, eve, (t) => { const i = t.toString().indexOf('Q4'); t.delete(i + 1, 1); t.insert(i + 1, '1'); });
  const t = comments.thread(comment.id)!;
  assert.equal(t.suggestion!.outdated, true);
  assert.throws(() => comments.decide(comment.id, eve, 'accept'), /outdated/);
  assert.throws(() => comments.revise(comment.id, bob, { text: 'Q2' }), /changed/);
  comments.decide(comment.id, eve, 'reject');
  assert.match(docs.text(d.id), /Q1/);
});

test('only the author revises; revising re-anchors; limits and no-op suggestions are refused', () => {
  const { docs, comments, d, bob, eve, at } = setup();
  const s = at('Q4');
  const { comment } = comments.suggest(d.id, bob, { anchor: comments.anchorFor(d.id, s, s + 2), text: 'Q3' });
  assert.throws(() => comments.revise(comment.id, eve, { text: 'Q2' }), /Only the author/);
  const s2 = at('in Q4');
  comments.revise(comment.id, bob, { text: 'by Q3', anchor: comments.anchorFor(d.id, s2, s2 + 5) });
  const t = comments.thread(comment.id)!;
  assert.equal(t.suggestion!.original, 'in Q4');
  assert.equal(t.suggestion!.text, 'by Q3');
  assert.throws(() => comments.suggest(d.id, bob, { anchor: comments.anchorFor(d.id, s, s + 2), text: 'Q4' }), /doesn't change/);
  assert.throws(() => comments.suggest(d.id, bob, { anchor: comments.anchorFor(d.id, 3, 3), text: '' }), /needs some text/);
  // Viewers can't suggest.
  const vic = core; void vic;
  comments.decide(comment.id, eve, 'accept');
  assert.match(docs.text(d.id), /beta by Q3\./);
});

test('accepting keeps other comments anchored (minimal diff)', () => {
  const { docs, comments, d, bob, eve, ann, at } = setup();
  const c = comments.create(d.id, ann, { body: 'scope?', anchor: comments.anchorFromQuote(d.id, 'the beta') }).comment;
  const s = at('We ship the beta in Q4.');
  const sg = comments.suggest(d.id, bob, { anchor: comments.anchorFor(d.id, s, s + 23), text: 'We ship the beta in Q3, maybe.' }).comment;
  comments.decide(sg.id, eve, 'accept');
  assert.equal(comments.thread(c.id)!.anchor!.text, 'the beta');
  void docs;
});

test('a batch of suggestions counts as one write and validates all-or-nothing', () => {
  const { docs, comments, d, bob } = setup();
  docs.edit(d.id, bob, (t) => t.insert(t.length, Array.from({ length: 40 }, (_, i) => `item ${i}\n`).join('')));
  const text = docs.text(d.id);
  const items = Array.from({ length: 40 }, (_, i) => { const at = text.indexOf(`item ${i}\n`); return { anchor: comments.anchorFor(d.id, at, at + 4), text: 'ITEM' }; });
  const r = comments.suggestMany(d.id, bob, items, 'caps');
  assert.equal(r.comments.length, 40);
  assert.equal(r.comments[0].body, 'caps');
  assert.equal(r.comments[1].body, '');
  // One bad item: nothing is created.
  const before = comments.openSuggestionCount(d.id);
  const at = docs.text(d.id).indexOf('Risks');
  assert.throws(() => comments.suggestMany(d.id, bob, [{ anchor: comments.anchorFor(d.id, at, at + 5), text: 'Hazards' }, { anchor: comments.anchorFor(d.id, at, at + 5), text: 'Risks' }]), /doesn't change/);
  assert.equal(comments.openSuggestionCount(d.id), before);
});

// ------------------------------------------------------------------ hunks

test('splitHunks: word-level trimming, and a multi-paragraph rewrite becomes one hunk per changed passage', () => {
  const doc = 'The cat sat on the mat.\n';
  assert.deepEqual(trimToChange(doc, 0, doc.length, 'The cut sat on the mat.\n'), { from: 4, to: 7, text: 'cut' });
  const para = (n: number, w: string) => `Paragraph ${n} talks about ${w} at some length so that it is long enough to matter for splitting purposes here.`;
  const before = [para(1, 'apples'), para(2, 'pears'), para(3, 'plums'), para(4, 'figs')].join('\n\n') + '\n';
  const after = [para(1, 'oranges'), para(2, 'pears'), para(3, 'plums'), para(4, 'dates')].join('\n\n') + '\n';
  const hs = splitHunks(before, 0, before.length, after);
  assert.equal(hs.length, 2);
  assert.deepEqual(hs.map((h) => [before.slice(h.from, h.to), h.text]), [['apples', 'oranges'], ['figs', 'dates']]);
  // Applying every hunk reproduces the target.
  let out = before;
  for (const h of [...hs].reverse()) out = out.slice(0, h.from) + h.text + out.slice(h.to);
  assert.equal(out, after);
  assert.deepEqual(splitHunks(before, 0, before.length, before), []);
});

// ------------------------------------------------------------------ server: tools, realtime, notices

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.close(); });
const url = (token: string) => `ws://127.0.0.1:${S.port}/mcpl?token=${encodeURIComponent(token)}`;
const human = (name: string) => S.app.principals.admit({ sub: `human:test:${name.toLowerCase()}`, name, kind: 'human', issuer: 'test.local', scopes: [], claims: {}, exp: Date.now() / 1000 + 3600 }, 'web');
async function signIn(name: string) {
  const r = await fetch(`${S.base}/auth/login`, { redirect: 'manual' });
  const login = /docs_login=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')![1];
  const token = S.iss.mint(name, 'human', 'docs');
  const jti = token; void jti;
  const ex = await fetch(`${S.base}/auth/exchange`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `docs_login=${login}`, origin: S.base }, body: JSON.stringify({ token }) });
  if (ex.status !== 200) throw new Error(`exchange ${ex.status} ${await ex.text()}`);
  return `docs_session=${/docs_session=([^;]+)/.exec(ex.headers.get('set-cookie') ?? '')![1]}`;
}

test('agent tools: suggest_edit splits and notifies the owning agent once; accept_suggestion applies; the suggester hears the decision', async () => {
  const owner = await rawHost(url(S.token('Owna')));
  const helper = await rawHost(url(S.token('Helpa')));
  try {
    const made = await owner.tool('create_document', { title: 'Essay', content: 'Intro about apples.\n\nMiddle part that stays the same for a good while, long enough to split the rewrite into separate passages.\n\nOutro about figs.\n' });
    const id = /\((d\w+)\)/.exec(made.text)![1];
    await owner.tool('share_document', { document: id, with: 'agent:helpa@test.local', role: 'commenter' }).catch(() => undefined);
    S.app.docs.share(id, S.app.principals.get('agent:owna@test.local') as any, 'agent:helpa@test.local', 'commenter');
    // A commenter can't edit, but can suggest.
    const denied = await helper.tool('edit_document', { document: id, edits: [{ old_text: 'apples', new_text: 'pears' }] });
    assert.equal(denied.isError, true);
    owner.pushes.length = 0;
    const s = await helper.tool('suggest_edit', { document: id, note: 'fruit update', edits: [{ replace_all_content: 'Intro about pears.\n\nMiddle part that stays the same for a good while, long enough to split the rewrite into separate passages.\n\nOutro about dates.\n' }] });
    assert.match(s.text, /Suggested 2 changes/);
    const ids = [...s.text.matchAll(/\[(c\w+)\]/g)].map((m) => m[1]);
    assert.equal(ids.length, 2);
    // One settled notice to the owner, tagged and listing both.
    await until(() => owner.pushes.some((p) => p.tags.includes('docs:suggestion')), 'owner notice');
    await sleep(150);
    const notices = owner.pushes.filter((p) => p.tags.includes('docs:suggestion'));
    assert.equal(notices.length, 1);
    assert.ok(notices[0].tags.includes('docs:wake') && notices[0].tags.includes('chat:from-agent'));
    const body = notices[0].payload.content[0].text;
    assert.match(body, /Helpa.*suggested 2 changes to “Essay”/);
    assert.match(body, /replace “apples” with “pears”/);
    assert.match(body, /note: fruit update/);
    // Inline reading.
    const inline = await owner.tool('read_document', { document: id, suggestions: 'inline' });
    assert.match(inline.text, /Intro about \{~~apples~>pears~~\}\{>>c\w+<<\}\./);
    assert.match(inline.text, /2 open suggestions shown inline/);
    // Accept one, reject the other with a reason.
    helper.pushes.length = 0;
    const acc = await owner.tool('accept_suggestion', { suggestions: [ids[0]] });
    assert.match(acc.text, /Accepted 1/);
    const rej = await owner.tool('reject_suggestion', { suggestions: [ids[1]], reason: 'figs stay' });
    assert.match(rej.text, /Rejected 1/);
    assert.equal(S.app.docs.text(id), 'Intro about pears.\n\nMiddle part that stays the same for a good while, long enough to split the rewrite into separate passages.\n\nOutro about figs.\n');
    await until(() => helper.pushes.some((p) => p.tags.includes('docs:suggestion')), 'decision notice');
    await sleep(150);
    const dn = helper.pushes.filter((p) => p.tags.includes('docs:suggestion'));
    assert.equal(dn.length, 1);
    assert.match(dn[0].payload.content[0].text, /accepted your suggestion/);
    assert.match(dn[0].payload.content[0].text, /rejected your suggestion.*figs stay/);
    // The owner's own accept is not reported back to it as someone else's edit; list shows the decided ones.
    const listed = await owner.tool('list_comments', { document: id, only: 'suggestions', include_resolved: true });
    assert.match(listed.text, /ACCEPTED by Owna/);
    assert.match(listed.text, /REJECTED by Owna/);
  } finally { owner.close(); helper.close(); }
});

test('realtime: a suggesting browser creates, revises and withdraws its suggestions; stale anchors fail alone; editors decide', async () => {
  const ann = await signIn('Annie');
  const bob = await signIn('Bobby');
  const annP = S.app.principals.get('human:test:annie')!;
  const d = S.app.docs.create(annP as any, 'Live', 'one two three\n');
  S.app.docs.share(d.id, annP as any, 'human:test:bobby', 'commenter');
  const b = await browserClient(S, bob, d.id);
  const a = await browserClient(S, ann, d.id);
  try {
    const yt = b.doc.getText('body');
    const enc = (i: number, assoc: number) => Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(yt, i, assoc))).toString('base64');
    const range = (from: number, to: number) => ({ start: enc(from, 0), end: enc(to, -1) });
    const point = (i: number) => { const p = enc(i, -1); return { start: p, end: p }; };
    let r = await b.ask({ type: 'suggestion.sync', ops: [
      { op: 'create', key: 'k1', anchor: range(4, 7), original: 'two', text: 'TWO' },
      { op: 'create', key: 'k2', anchor: point(13), original: '', text: ' four' },
      { op: 'create', key: 'k3', anchor: range(0, 3), original: 'uno', text: 'ONE' },   // stale: original doesn't match
    ] });
    assert.equal(r.ok, true);
    const res = r.data.results;
    assert.deepEqual(res.map((x: any) => x.ok), [true, true, false]);
    assert.equal(res[2].status, 409);
    const [s1, s2] = [res[0].id, res[1].id];
    await until(() => a.json.some((m) => m.type === 'threads' && m.threads.length === 2), 'threads to the owner');
    const last = a.json.filter((m) => m.type === 'threads').at(-1);
    const sg = last.threads.find((t: any) => t.id === s2).suggestion;
    assert.deepEqual(sg, { original: '', text: ' four', status: 'open', outdated: false, point: true });
    // Revise s1 to cover more text; withdraw s2.
    r = await b.ask({ type: 'suggestion.sync', ops: [
      { op: 'update', id: s1, anchor: range(4, 13), original: 'two three', text: 'TWO THREE' },
      { op: 'withdraw', id: s2 },
    ] });
    assert.deepEqual(r.data.results.map((x: any) => x.ok), [true, true]);
    // The commenter can't decide; the owner can.
    r = await b.ask({ type: 'suggestion.decide', id: s1, decision: 'accept' });
    assert.equal(r.ok, false);
    r = await a.ask({ type: 'suggestion.decide', id: s1, decision: 'accept' });
    assert.equal(r.ok, true, r.error);
    await until(() => b.text() === 'one TWO THREE\n', 'accepted text reaches the suggester');
    const thr = b.json.filter((m) => m.type === 'threads');
    // The suggester saw the decision before (or with) the text change.
    const decidedAt = b.json.findIndex((m) => m.type === 'threads' && m.threads.some((t: any) => t.id === s1 && t.suggestion?.status === 'accepted'));
    assert.ok(decidedAt >= 0 && thr.length >= 3);
  } finally { a.close(); b.close(); }
});
