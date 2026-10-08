import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { core } from './helpers.js';
import { Documents } from '../src/documents.js';
import { textChanges } from '../src/diff.js';

test('agent diff: shows others\' changes with attribution, hides the agent\'s own edits', () => {
  const { docs, principals, actor } = core();
  const ada = actor('Ada');
  const scout = actor('Scout', 'agent');
  const d = docs.create(ada, 'Q4 plan', '# Plan\n\n## Goals\n\nShip the beta in Q4.\n\n## Risks\n\nNone yet.\n');
  docs.share(d.id, ada, scout.sub, 'editor');

  // Scout reads: baseline = now.
  let base = docs.snapshot(d.id);

  // Ada edits a goal; Scout edits risks.
  docs.edit(d.id, ada, (t) => { const s = t.toString(); const i = s.indexOf('in Q4'); t.insert(i + 'in '.length, 'early '); });
  const own = docs.edit(d.id, scout, (t) => { const s = t.toString(); const i = s.indexOf('None yet.'); t.delete(i, 'None yet.'.length); t.insert(i, '- Hiring may slip.'); });
  base = Documents.foldOwnEdit(base, docs.ydoc(d.id), own.client, own.deleteSet);

  const c = textChanges(docs, principals, d.id, base, { title: d.title });
  assert.equal(c.changed, true);
  // A small change in a line is shown with the changed words marked.
  assert.match(c.text, /~Ship the beta in \{\+early \+\}Q4\./);
  assert.match(c.text, /changed words marked \[-removed-\]\{\+added\+\}/);
  assert.match(c.text, /Goals/);
  assert.match(c.text, /Ada/);
  assert.doesNotMatch(c.text, /Hiring/, 'own edit must not be reported back');
  assert.deepEqual(c.authors, [ada.sub]);

  // After advancing the baseline, nothing is new.
  const again = textChanges(docs, principals, d.id, docs.snapshot(d.id), { title: d.title });
  assert.equal(again.changed, false);
});

test('agent diff attributes deletions to the deleter, not the inserter', () => {
  const { docs, principals, actor } = core();
  const a = actor('Alice'); const b = actor('Bob'); const agent = actor('Scout', 'agent');
  const d = docs.create(a, 'T', 'one two three\n');
  docs.share(d.id, a, b.sub, 'editor');
  const base = docs.snapshot(d.id);
  docs.edit(d.id, b, (t) => t.delete(4, 4)); // Bob deletes Alice's "two "
  const c = textChanges(docs, principals, d.id, base, { title: d.title });
  assert.deepEqual(c.authors, [b.sub]);
  assert.match(c.text, /Bob/);
  assert.doesNotMatch(c.text, /Alice/);
  void agent;
});

test('client ids are owned: a browser cannot forge another principal\'s content', () => {
  const { docs, actor } = core();
  const a = actor('Alice'); const m = actor('Mallory');
  const d = docs.create(a, 'T', 'hello');
  docs.share(d.id, a, m.sub, 'editor');

  const alice = new Y.Doc(); Y.applyUpdate(alice, Y.encodeStateAsUpdate(docs.ydoc(d.id)));
  alice.getText('body').insert(5, ' world');
  docs.applyClientUpdate(d.id, Y.encodeStateAsUpdate(alice, Y.encodeStateVector(docs.ydoc(d.id))), { sub: a.sub, via: 'web' });
  assert.equal(docs.text(d.id), 'hello world');

  // Mallory replays a doc using Alice's client id.
  const forged = new Y.Doc();
  Y.applyUpdate(forged, Y.encodeStateAsUpdate(docs.ydoc(d.id)));
  forged.clientID = alice.clientID; // (Yjs re-rolls an id it sees remotely; force it back)
  forged.getText('body').insert(0, 'PWNED ');
  assert.throws(() => docs.applyClientUpdate(d.id, Y.encodeStateAsUpdate(forged, Y.encodeStateVector(docs.ydoc(d.id))), { sub: m.sub, via: 'web' }), /another principal/);
  assert.equal(docs.text(d.id), 'hello world');

  // Re-sending already-known content under someone else's id is a harmless no-op.
  docs.applyClientUpdate(d.id, Y.encodeStateAsUpdate(alice), { sub: m.sub, via: 'web' });
});

test('persistence round-trip through the update log and compaction', () => {
  const { db, docs, actor, principals } = core();
  const a = actor('Alice');
  const d = docs.create(a, 'T', '');
  for (let i = 0; i < 900; i++) docs.edit(d.id, a, (t) => t.insert(t.length, String(i % 10)));
  const expected = docs.text(d.id);
  const fresh = new Documents(db, principals, { defaultAccess: 'restricted' });
  assert.equal(fresh.text(d.id), expected);
  assert.ok((db.prepare('SELECT count(*) AS n FROM doc_updates WHERE doc_id = ?').get(d.id) as any).n < 400);
});

test('minimal replacement keeps unchanged text identity (anchors survive)', () => {
  const { docs, actor } = core();
  const a = actor('Alice');
  const d = docs.create(a, 'T', 'The quick brown fox jumps.');
  const ytext = docs.ydoc(d.id).getText('body');
  const anchor = Y.createRelativePositionFromTypeIndex(ytext, 10); // "brown"
  docs.edit(d.id, a, (t) => Documents.replaceMinimal(t, 0, t.length, 'A quick brown fox leaps.'));
  const abs = Y.createAbsolutePositionFromRelativePosition(anchor, docs.ydoc(d.id))!;
  assert.equal(docs.text(d.id).slice(abs.index, abs.index + 5), 'brown');
});

test('access control: restricted by default, roles, general access', () => {
  const { docs, actor } = core();
  const a = actor('Alice'); const b = actor('Bob'); const c = actor('Carol');
  const d = docs.create(a, 'Private', 'x');
  assert.equal(docs.role(d.id, b), null);
  assert.throws(() => docs.require(d.id, b, 'viewer'), /No document/);
  docs.share(d.id, a, b.sub, 'commenter');
  assert.equal(docs.role(d.id, b), 'commenter');
  assert.throws(() => docs.require(d.id, b, 'editor'), /commenter/);
  assert.throws(() => docs.share(d.id, b, c.sub, 'viewer'), /commenter/);
  docs.setGeneralAccess(d.id, a, 'viewer');
  assert.equal(docs.role(d.id, c), 'viewer');
  assert.equal(docs.role(d.id, b), 'commenter');
  assert.equal(docs.list(c).length, 1);
});

test('agent diff: a small change in a long paragraph is word-marked and trimmed; a rewrite stays as whole lines', () => {
  const { docs, principals, actor } = core();
  const ann = actor('Ann');
  const long = 'In practice this is usually described as the subconscious mind of the model, which is useful as a picture but says little about mechanism. '.repeat(4).trim();
  const d = docs.create(ann, 'T', `# T\n\n${long}\n\nShort line.\n`);
  const base = docs.snapshot(d.id);
  docs.edit(d.id, { sub: ann.sub, via: 'web' }, (t) => { const i = t.toString().indexOf('mind of the model'); t.delete(i + 8, 3); t.insert(i + 8, 'a'); });
  docs.edit(d.id, { sub: ann.sub, via: 'web' }, (t) => { const i = t.toString().indexOf('Short line.'); t.delete(i, 11); t.insert(i, 'Entirely different words now.'); });
  const c = textChanges(docs, principals, d.id, base, { title: 'T' });
  assert.match(c.text, /~…?.*subconscious mind of \[-the-\]\{\+a\+\} model.*…/);
  assert.ok(!c.text.includes(long), 'the long paragraph is not repeated whole');
  assert.match(c.text, /-Short line\.\n\+Entirely different words now\./);
  assert.ok(c.text.length < 900, `compact: ${c.text.length} chars`);
});
