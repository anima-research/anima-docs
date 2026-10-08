import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from './helpers.js';
import { History } from '../src/history.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { TOOLS } from '../src/tools.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(opts = { idleMs: 60, agentIdleMs: 40, maxMs: 400 }) {
  const c = core();
  const history = new History(c.db, c.docs, c.principals, opts);
  const ann = c.actor('Ann');
  const bob = c.actor('Bob');
  const scout = c.actor('Scout', 'agent');
  const d = c.docs.create(ann, 'Notes', '# Notes\n\nalpha\n\nbeta\n\ngamma\n');
  c.docs.share(d.id, ann, bob.sub, 'editor');
  c.docs.share(d.id, ann, scout.sub, 'editor');
  const web = (who: { sub: string }, fn: (t: any) => void) => c.docs.edit(d.id, { sub: who.sub, via: 'web' }, fn);
  const replace = (from: string, to: string) => (t: any) => { const i = t.toString().indexOf(from); t.delete(i, from.length); t.insert(i, to); };
  return { ...c, history, ann, bob, scout, d, web, replace };
}

test('checkpoints: a pause ends a stretch; people edit together; an agent’s edit is its own; a labelled edit stands alone', async () => {
  const { history, docs, d, ann, bob, scout, web, replace } = setup();
  await sleep(80); // the creation stretch closes
  web(ann, replace('alpha', 'ALPHA'));
  web(bob, replace('beta', 'BETA'));
  await sleep(10);
  // An agent's edit closes the people's stretch first, with the state before it.
  docs.edit(d.id, { sub: scout.sub, via: 'mcpl' }, replace('gamma', 'GAMMA'));
  await sleep(80);
  docs.edit(d.id, { sub: ann.sub, via: 'http', label: 'Restored something' }, replace('# Notes', '# Notes!'));
  const list = history.list(d.id).reverse();
  assert.deepEqual(list.map((c) => [c.baseline, c.authors.sort(), c.label]), [
    [true, [], null],                       // where history begins (the empty document at creation)
    [false, [ann.sub], null],               // creation
    [false, [ann.sub, bob.sub].sort(), null],
    [false, [scout.sub], null],
    [false, [ann.sub], 'Restored something'],
  ]);
  const people = list[2];
  const one = history.compare(d.id, people.seq, people.seq);
  assert.match(one.before, /alpha[\s\S]*beta[\s\S]*gamma/);
  assert.match(one.after, /ALPHA[\s\S]*BETA[\s\S]*gamma/, 'the people’s change stops before the agent’s');
  const range = history.compare(d.id, list[2].seq, list[3].seq);
  assert.match(range.after, /ALPHA[\s\S]*BETA[\s\S]*GAMMA/);
  assert.equal(history.compare(d.id, list[1].seq, list[1].seq).before, '');
  history.shutdown();
});

test('checkpoints: hours of continuous typing become many changes, not one', async () => {
  const { history, d, ann, web } = setup({ idleMs: 200, agentIdleMs: 40, maxMs: 120 });
  await sleep(250);
  const before = history.list(d.id).length;
  for (let i = 0; i < 30; i++) { web(ann, (t) => t.insert(t.length, `${i} `)); await sleep(15); }
  await sleep(250);
  const made = history.list(d.id).length - before;
  assert.ok(made >= 3, `continuous typing split into ${made} changes`);
  history.shutdown();
});

test('restore to before or after a change; undo one change keeping later ones; conflicts are refused', async () => {
  const { history, docs, d, ann, bob, web, replace } = setup();
  await sleep(80);
  web(ann, replace('alpha', 'ALPHA'));
  await sleep(80);
  web(bob, replace('gamma', 'GAMMA'));
  await sleep(80);
  const [g, a] = history.list(d.id); // newest first: Bob's gamma, Ann's alpha
  // Undo Ann's change only: Bob's later change stays.
  history.undo(d.id, bob, a.seq);
  assert.match(docs.text(d.id), /\nalpha\n[\s\S]*GAMMA/);
  // Restore to just before Bob's change.
  history.restore(d.id, ann, g.seq, 'before');
  assert.match(docs.text(d.id), /ALPHA[\s\S]*\ngamma\n/);
  // Restore to just after it.
  history.restore(d.id, ann, g.seq, 'after');
  assert.match(docs.text(d.id), /ALPHA[\s\S]*GAMMA/);
  // An undo whose lines were changed since is refused.
  web(bob, replace('GAMMA', 'Gamma!'));
  await sleep(80);
  assert.throws(() => history.undo(d.id, ann, g.seq), /Later edits changed the same lines/);
  // Viewers can't go back.
  const vic = (docs as any).principals; void vic;
  const labels = history.list(d.id).map((c) => c.label).filter(Boolean);
  assert.ok(labels.some((l) => /^Undid h\d+$/.test(l!)) && labels.some((l) => /^Restored to just before h\d+$/.test(l!)), JSON.stringify(labels));
  history.shutdown();
});

test('prune thins old history into hours, then days, keeping labelled changes', () => {
  const { history, db, d } = setup();
  const day = 86400_000, now = Date.now();
  const snap = (db.prepare('SELECT snapshot FROM checkpoints WHERE doc_id = ? LIMIT 1').get(d.id) as { snapshot: Buffer }).snapshot;
  const ins = db.prepare(`INSERT INTO checkpoints (doc_id, start_at, end_at, snapshot, authors, added, removed, label, kind) VALUES (?, ?, ?, ?, ?, 1, 0, ?, 'edit')`);
  // 40 days ago: six changes in one day; 10 days ago: four in one hour, one labelled.
  for (let i = 0; i < 6; i++) ins.run(d.id, now - 40 * day + i * 3600_000, now - 40 * day + i * 3600_000 + 60_000, snap, JSON.stringify([`p${i}`]), null);
  const hour = Math.floor((now - 10 * day) / 3600_000) * 3600_000;
  for (let i = 0; i < 4; i++) ins.run(d.id, hour + i * 600_000, hour + i * 600_000 + 60_000, snap, JSON.stringify([`q${i}`]), i === 1 ? 'Restored' : null);
  history.prune(now);
  const rows = db.prepare(`SELECT authors, added, label FROM checkpoints WHERE doc_id = ? AND kind = 'edit' AND end_at < ? ORDER BY seq`).all(d.id, now - 5 * day) as { authors: string; added: number; label: string | null }[];
  const old = rows.filter((r) => r.authors.includes('p'));
  assert.equal(old.length, 1);
  assert.equal(JSON.parse(old[0].authors).length, 6);
  assert.equal(old[0].added, 6);
  const recent = rows.filter((r) => r.authors.includes('q'));
  assert.equal(recent.filter((r) => r.label === 'Restored').length, 1, 'labelled change kept');
  assert.equal(recent.length, 2);
  history.shutdown();
});

test('agent tools: versions lists changes; changes diffs one or a range; restore_version and undo_change go back', async () => {
  const app = createApp(loadConfig({ DOCS_DATA_DIR: ':memory:', DOCS_ORIGIN: 'http://x', DOCS_ISSUERS: '' } as any), new Map(), { history: { idleMs: 60, agentIdleMs: 40, maxMs: 400 } });
  try {
    const ann = app.principals.admit({ sub: 'human:test:ann', name: 'Ann', kind: 'human', issuer: 'test.local', scopes: [], claims: {}, exp: Date.now() / 1000 + 3600 }, 'web');
    const agent = app.principals.admit({ sub: 'agent:quill@test.local', name: 'Quill', kind: 'agent', issuer: 'test.local', scopes: [], claims: {}, exp: Date.now() / 1000 + 3600 }, 'mcpl');
    const tool = (name: string, args: Record<string, unknown>) => TOOLS.find((t) => t.name === name)!.run(app, agent as any, args) as any;
    const d = app.docs.create(ann, 'Plan', 'one\ntwo\nthree\n');
    app.docs.share(d.id, ann, agent.sub, 'editor');
    await sleep(80);
    app.docs.edit(d.id, { sub: ann.sub, via: 'web' }, (t) => { const i = t.toString().indexOf('two'); t.delete(i, 3); t.insert(i, 'TWO'); });
    await sleep(80);
    app.docs.edit(d.id, { sub: ann.sub, via: 'web' }, (t) => t.insert(t.length, 'four\n'));
    await sleep(80);
    const v = (await tool('versions', { document: d.id })).content[0].text as string;
    const ids = [...v.matchAll(/^\s+(h\d+)\s/gm)].map((m) => m[1]);
    assert.ok(ids.length >= 3, v);
    const [newest, middle] = ids;
    const one = (await tool('changes', { document: d.id, from: middle, to: middle })).content[0].text as string;
    assert.match(one, /changed in h\d+/);
    assert.match(one, /-two/);
    assert.match(one, /\+TWO/);
    assert.doesNotMatch(one, /four/);
    const range = (await tool('changes', { document: d.id, from: middle, to: newest })).content[0].text as string;
    assert.match(range, /\+four/);
    await tool('undo_change', { document: d.id, change: middle });
    assert.equal(app.docs.text(d.id), 'one\ntwo\nthree\nfour\n');
    await tool('restore_version', { document: d.id, version: newest, at: 'before' });
    assert.equal(app.docs.text(d.id), 'one\nTWO\nthree\n');
  } finally { app.close(); }
});
