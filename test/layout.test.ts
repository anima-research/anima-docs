// The editor's flattening of a node tree (web/editor/nodes/layout.ts): pure logic, tested here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatten, decompose, placeAt, type TextSource } from '../web/editor/nodes/layout.js';

const src = (t: Record<string, string>): TextSource => (id) => (id in t ? { text: t[id], title: id, type: 'markdown', loaded: true, readable: true } : undefined);

test('a marker line is replaced by the child; separators next to it are structural', () => {
  const L = flatten('r', src({ r: 'a\n{{node:x}}\nb', x: 'c\nd' }));
  assert.equal(L.text, 'a\nc\nd\nb');
  assert.deepEqual(L.mounts.map((m) => [m.child, m.from, m.to, m.depth]), [['x', 2, 5, 1]]);
  assert.equal(placeAt(L, 2)!.node, 'x');
  assert.equal(placeAt(L, 1)!.node, 'r');
});

test('a body ending with a mount gets a phantom line after it; typing there adds a parent line', () => {
  const t = { r: 'a\n{{node:x}}', x: 'c' };
  const L = flatten('r', src(t));
  assert.equal(L.text, 'a\nc\n');
  const tail = placeAt(L, 4)!;
  assert.equal(tail.node, 'r'); assert.equal(tail.phantom, 'tail');
  const r = decompose(L, 4, 4, 'z');
  assert.deepEqual(r.ops, [{ node: 'r', from: t.r.length, to: t.r.length, insert: '\nz' }]);
  // After the insert the phantom is gone and the view text is what was typed.
  const L2 = flatten('r', src({ ...t, r: t.r + '\nz' }));
  assert.equal(L2.text, 'a\nc\nz');
});

test('a body starting with a mount gets a phantom line before it', () => {
  const t = { r: '{{node:x}}\nb', x: 'c' };
  const L = flatten('r', src(t));
  assert.equal(L.text, '\nc\nb');
  const head = placeAt(L, 0)!;
  assert.equal(head.phantom, 'head');
  assert.deepEqual(decompose(L, 0, 0, 'z').ops, [{ node: 'r', from: 0, to: 0, insert: 'z\n' }]);
  assert.equal(flatten('r', src({ ...t, r: 'z\n' + t.r })).text, 'z\nc\nb');
});

test('a covered child is detached whole; text inside it is untouched', () => {
  const L = flatten('r', src({ r: 'a\n{{node:x}}\nb', x: 'c\nd' }));
  const r = decompose(L, 1, 6, '');
  assert.equal(r.unmounts.length, 1);
  assert.ok(r.ops.every((o) => o.node !== 'x'));
});
