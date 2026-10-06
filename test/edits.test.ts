import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { core } from './helpers.js';
import { applyEdits } from '../src/edits.js';

const DOC = '# Plan\n\n## Goals\n\nShip it.\nShip it.\n\n## Risks\n\nNone.\n\n## Notes\n\n### Goals\n\nSub-goals.\n';

function setup() {
  const c = core();
  const a = c.actor('Alice');
  const agent = c.actor('Bot', 'agent');
  const d = c.docs.create(a, 'Plan', DOC);
  return { ...c, a, agent, d };
}

test('replace requires a unique match or an explicit occurrence', () => {
  const { docs, d, agent } = setup();
  assert.throws(() => applyEdits(docs, d.id, agent, [{ old_text: 'Ship it.', new_text: 'x' }]), /occurs 2 times \(lines 5, 6\)/);
  applyEdits(docs, d.id, agent, [{ old_text: 'Ship it.', new_text: 'Ship it soon.', occurrence: 2 }]);
  assert.match(docs.text(d.id), /Ship it\.\nShip it soon\./);
  applyEdits(docs, d.id, agent, [{ old_text: 'Ship it', new_text: 'Launch', replace_all: true }]);
  assert.match(docs.text(d.id), /Launch\.\nLaunch soon\./);
});

test('edits are atomic: one failure applies nothing', () => {
  const { docs, d, agent } = setup();
  const before = docs.text(d.id);
  assert.throws(() => applyEdits(docs, d.id, agent, [{ old_text: 'None.', new_text: 'Some.' }, { old_text: 'not there', new_text: '' }]), /Edit 2: old_text not found/);
  assert.equal(docs.text(d.id), before);
});

test('sections: ambiguous headings need a path or level; replace and append keep structure', () => {
  const { docs, d, agent } = setup();
  assert.throws(() => applyEdits(docs, d.id, agent, [{ replace_section: 'Goals', content: 'x' }]), /matches 2 headings/);
  applyEdits(docs, d.id, agent, [{ replace_section: 'Notes > Goals', content: 'Nested replaced.' }]);
  applyEdits(docs, d.id, agent, [{ replace_section: '## Goals', content: 'Top replaced.' }]);
  applyEdits(docs, d.id, agent, [{ append_to_section: 'Risks', text: '- Budget.' }]);
  const t = docs.text(d.id);
  assert.match(t, /## Goals\nTop replaced\.\n\n## Risks/);
  assert.match(t, /None\.\n- Budget\.\n\n## Notes/);
  assert.match(t, /### Goals\nNested replaced\./);
});

test('insert_before/after, append, prepend', () => {
  const { docs, d, agent } = setup();
  applyEdits(docs, d.id, agent, [
    { insert_after: 'None.', text: ' (for now)' },
    { insert_before: '## Risks', text: '| a | b |\n|---|---|\n| 1 | 2 |\n\n' },
    { append: 'The end.' },
    { prepend: '> Draft' },
  ]);
  const t = docs.text(d.id);
  assert.ok(t.startsWith('> Draft\n# Plan'));
  assert.ok(t.endsWith('Sub-goals.\nThe end.'));
  assert.match(t, /\| 1 \| 2 \|\n\n## Risks/);
  assert.match(t, /None\. \(for now\)/);
});

test('a full rewrite is applied minimally: comment anchors on unchanged text survive, attribution is the agent\'s', () => {
  const { docs, comments, d, a, agent } = setup();
  const c = comments.create(d.id, a, { body: 'about risks', anchor: comments.anchorFromQuote(d.id, 'None.') });
  const next = docs.text(d.id).replace('# Plan', '# The Plan').replace('Sub-goals.', 'Sub-goals, revised.');
  applyEdits(docs, d.id, agent, [{ replace_all_content: next }]);
  assert.equal(docs.text(d.id), next);
  const t = comments.thread(c.comment.id)!;
  assert.equal(t.anchor!.text, 'None.');
  assert.equal(t.anchor!.orphaned, false);
  // Every newly inserted item belongs to the agent's server-side client id.
  const client = docs.serverClientFor(d.id, agent.sub);
  assert.equal(docs.ownerOfClient(d.id, client), agent.sub);
});

test('comment anchors follow concurrent edits and orphan when their text is deleted', () => {
  const { docs, comments, d, a } = setup();
  const c = comments.create(d.id, a, { body: 'risk?', anchor: comments.anchorFromQuote(d.id, 'None.') });
  // A remote browser inserts above the anchor.
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(docs.ydoc(d.id)));
  remote.getText('body').insert(0, 'Lots of new text\n\n\n');
  docs.applyClientUpdate(d.id, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(docs.ydoc(d.id))), { sub: a.sub, via: 'web' });
  let t = comments.thread(c.comment.id)!;
  assert.equal(t.anchor!.text, 'None.');
  assert.equal(t.anchor!.line, 13);
  docs.edit(d.id, a, (y) => { const s = y.toString(); y.delete(s.indexOf('None.'), 5); });
  t = comments.thread(c.comment.id)!;
  assert.equal(t.anchor!.orphaned, true);
  assert.equal(t.root.quote, 'None.');
});

test('mentions: longest name wins, ambiguous names are not guessed, no access means no notification', () => {
  const { principals, comments, docs, d, a, actor } = setup();
  actor('Claude'); actor('Claude Opus', 'agent');
  docs.share(d.id, a, 'agent:claude opus@test.local', 'commenter');
  const r = comments.create(d.id, a, { body: 'cc @Claude Opus and @Claude' });
  assert.deepEqual(r.comment.mentions.sort(), ['agent:claude opus@test.local']);
  assert.match(r.warnings.join(' '), /Claude has no access/);
  void principals;
});

test('reported line numbers are final even when a later edit shifts earlier ones', () => {
  const { docs, d, agent } = setup();
  const { report } = applyEdits(docs, d.id, agent, [
    { old_text: 'None.', new_text: 'Some.' },
    { prepend: 'line A\nline B\nline C' },
    { old_text: 'Ship it', new_text: 'Launch it now', replace_all: true },
  ]);
  const lines = docs.text(d.id).split('\n');
  const at = (s: string) => lines.findIndex((l) => l.includes(s)) + 1;
  assert.match(report.applied[0], new RegExp(`line ${at('Some.')}$`));
  assert.match(report.applied[1], /lines 1–3$/);
  assert.match(report.applied[2], new RegExp(`×2 → lines ${at('Launch it now')}–${at('Launch it now') + 1}$`));
});
