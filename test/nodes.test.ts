// The node model: mounts, derived access, sections, split/merge, comments across nodes, navigation trees.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from './helpers.js';
import { Nodes, marker, scanMounts } from '../src/nodes.js';
import { Trees } from '../src/trees.js';
import { Fault } from '../src/auth.js';

function setup() {
  const c = core();
  const nodes = new Nodes(c.db, c.docs);
  nodes.attachComments(c.comments);
  const trees = new Trees(c.db, c.docs, nodes);
  return { ...c, nodes, trees };
}

test('scanMounts: whole-line markers only', () => {
  const m = scanMounts('a\n{{node:dAbc}}\n| {{node:dX}} |\n  {{node:dY}}\n{{node:dZ}}   \nb');
  assert.deepEqual(m.map((x) => [x.child, x.line]), [['dAbc', 2], ['dZ', 5]]);
});

test('mount index follows the body; access derives through parents, capped at editor', () => {
  const { docs, nodes, actor } = setup();
  const owner = actor('Owner'), reader = actor('Reader'), stranger = actor('Stranger');
  const paper = docs.create(owner, 'Paper', 'Intro\n');
  const sec = docs.createNode(owner, { title: '', content: 'Section body', owner: owner.sub });
  assert.equal(docs.role(sec.id, reader), null);
  docs.share(paper.id, owner, reader.sub, 'editor');
  // Not mounted yet: no access through the paper.
  assert.equal(docs.role(sec.id, reader), null);
  nodes.mount(paper.id, sec.id, owner);
  assert.deepEqual(nodes.childrenOf(paper.id).map((x) => x.child), [sec.id]);
  assert.deepEqual(nodes.parentsOf(sec.id), [paper.id]);
  assert.equal(docs.role(sec.id, reader), 'editor');
  assert.equal(docs.role(sec.id, stranger), null);
  assert.equal(docs.derivedOnly(sec.id, reader), true);
  docs.share(paper.id, owner, reader.sub, 'viewer');
  assert.equal(docs.role(sec.id, reader), 'viewer');
  // The owner of the paper owns the section too (sections belong to their parent's owner).
  assert.equal(docs.role(sec.id, owner), 'owner');
  // Removing the marker line by editing removes the mount and the access.
  nodes.unmount(paper.id, sec.id, owner);
  assert.equal(nodes.childrenOf(paper.id).length, 0);
  assert.equal(docs.role(sec.id, reader), null);
  assert.ok(!docs.text(paper.id).includes('{{node:'));
});

test('typing a marker line mounts; cycles are refused; the content tree and flatten', () => {
  const { docs, nodes, actor } = setup();
  const o = actor('O');
  const a = docs.create(o, 'A', 'A top\n');
  const b = docs.create(o, 'B', 'B body\n');
  const c = docs.createNode(o, { title: '', content: 'C body' });
  docs.edit(a.id, o, (t) => t.insert(t.length, `${marker(b.id)}\nA tail`));
  docs.edit(b.id, o, (t) => t.insert(t.length, `${marker(c.id)}`));
  assert.deepEqual(nodes.childrenOf(a.id).map((x) => x.child), [b.id]);
  assert.throws(() => nodes.mount(c.id, a.id, o), (e: Fault) => e.status === 409);
  assert.equal(nodes.wouldCycle(b.id, a.id), true);
  const tree = nodes.tree(a.id, o);
  assert.deepEqual(tree.nodes.map((n) => [n.id, n.depth, n.section]), [[a.id, 0, false], [b.id, 1, false], [c.id, 2, true]]);
  assert.equal(nodes.flatten(a.id, o), 'A top\nB body\nC body\nA tail');
  assert.ok(nodes.flatten(a.id, o, { delimit: true }).includes(`[section ${b.id} “B” begins]`));
  // A literal marker (in a table) stays literal.
  docs.edit(a.id, o, (t) => t.insert(0, `| ${marker(b.id)} |\n`));
  assert.ok(nodes.flatten(a.id, o).startsWith(`| ${marker(b.id)} |`));
  // Someone who can't read B sees the marker as literal text and B is not in their tree.
  const s = actor('S');
  docs.share(a.id, o, s.sub, 'viewer');
  assert.equal(docs.role(b.id, s), 'viewer'); // derived through A
  const t2 = nodes.tree(a.id, s);
  assert.ok(t2.nodes.some((n) => n.id === c.id));
});

test('split moves the tail into a new section and re-anchors comments; merge brings it back', () => {
  const { docs, nodes, comments, actor } = setup();
  const o = actor('O');
  const d = docs.create(o, 'Doc', 'one two three\nfour five six\nseven eight');
  const before = comments.create(d.id, o, { body: 'on two', anchor: comments.anchorFromQuote(d.id, 'two') });
  const after = comments.create(d.id, o, { body: 'on five', anchor: comments.anchorFromQuote(d.id, 'five') });
  const span = comments.create(d.id, o, { body: 'spans', anchor: comments.anchorFromQuote(d.id, 'three\nfour') });
  const cut = 'one two three\n'.length;
  const child = nodes.split(d.id, o, cut);
  assert.equal(child.title, '');
  assert.equal(docs.text(d.id), `one two three\n${marker(child.id)}\n`); // a line of its own after the section
  assert.equal(docs.text(child.id), 'four five six\nseven eight');
  assert.equal(comments.get(before.comment.id)!.docId, d.id);
  const moved = comments.get(after.comment.id)!;
  assert.equal(moved.docId, child.id);
  const ta = comments.thread(after.comment.id)!;
  assert.equal(ta.anchor!.text, 'five');
  const ts = comments.thread(span.comment.id)!;
  assert.equal(ts.root.docId, d.id);
  assert.equal(ts.root.endDocId, child.id);
  assert.equal(ts.anchor!.endDoc, child.id);
  assert.ok(ts.anchor!.text.startsWith('three\n')); // start node's tail
  assert.equal(ts.rel!.endDoc, child.id);
  // Merge back: comments return to the parent, the child is an orphan.
  const r = nodes.merge(d.id, child.id, o);
  assert.equal(r.copied, false);
  assert.equal(docs.text(d.id), 'one two three\nfour five six\nseven eight\n');
  assert.equal(comments.get(after.comment.id)!.docId, d.id);
  assert.equal(comments.thread(after.comment.id)!.anchor!.text, 'five');
  assert.equal(comments.thread(span.comment.id)!.anchor!.text, 'three\nfour');
  assert.equal(comments.get(span.comment.id)!.endDocId, null);
  assert.equal(nodes.parentsOf(child.id).length, 0);
});

test('merging a node mounted elsewhere copies it and keeps its comments', () => {
  const { docs, nodes, comments, actor } = setup();
  const o = actor('O');
  const shared = docs.create(o, 'Shared', 'shared text');
  const a = docs.create(o, 'A', `top\n${marker(shared.id)}\n`);
  const b = docs.create(o, 'B', `${marker(shared.id)}`);
  const c = comments.create(shared.id, o, { body: 'x', anchor: comments.anchorFromQuote(shared.id, 'shared') });
  assert.equal(nodes.mountCount(shared.id), 2);
  const r = nodes.merge(a.id, shared.id, o);
  assert.equal(r.copied, true);
  assert.equal(docs.text(a.id), 'top\nshared text\n');
  assert.equal(comments.get(c.comment.id)!.docId, shared.id);
  assert.deepEqual(nodes.parentsOf(shared.id), [b.id]);
});

test('a comment may start in one node and end in another', () => {
  const { docs, nodes, comments, actor } = setup();
  const o = actor('O');
  const child = docs.createNode(o, { title: '', content: 'child text' });
  const p = docs.create(o, 'P', `parent text\n${marker(child.id)}\n`);
  const start = comments.anchorFromQuote(p.id, 'text');
  const end = comments.anchorFromQuote(child.id, 'child');
  const c = comments.create(p.id, o, { body: 'across', anchor: { start: start.start, end: end.end, quote: 'text…child', endDoc: child.id } });
  const t = comments.thread(c.comment.id)!;
  assert.equal(t.anchor!.endDoc, child.id);
  assert.equal(t.anchor!.text, 'text\n' + marker(child.id) + '\n');
  // A suggestion cannot span.
  assert.throws(() => comments.create(p.id, o, { body: '', anchor: { start: start.start, end: end.end, quote: 'x', endDoc: child.id }, suggestion: { text: 'y' } }), (e: Fault) => e.status === 400);
  // And the other node must be commentable by the actor.
  const v = actor('V');
  docs.share(p.id, o, v.sub, 'commenter');
  nodes.unmount(p.id, child.id, o);
  assert.throws(() => comments.create(p.id, v, { body: 'no', anchor: { start: start.start, end: end.end, quote: 'q', endDoc: child.id } }), (e: Fault) => e.status === 404);
});

test('sections: created mounted, owned by the parent owner, listed nowhere, renamed into documents', () => {
  const { docs, nodes, actor } = setup();
  const o = actor('O'), e = actor('E');
  const p = docs.create(o, 'P', 'body\n');
  docs.share(p.id, o, e.sub, 'editor');
  const s = nodes.createSection(p.id, e, { content: 'sec' });
  assert.equal(s.ownerSub, o.sub);
  assert.equal(s.title, '');
  assert.ok(docs.text(p.id).includes(marker(s.id)));
  assert.ok(!docs.list(o).some((d) => d.id === s.id));
  assert.ok(docs.list(o, { sections: true }).some((d) => d.id === s.id));
  docs.rename(s.id, e, 'Named now');
  assert.ok(docs.list(o).some((d) => d.id === s.id));
  docs.rename(s.id, e, '');
  assert.equal(docs.get(s.id)!.title, '');
  // A nameless node must be reachable: un-naming an unmounted document is refused.
  const lone = docs.create(o, 'Lone');
  assert.throws(() => docs.rename(lone.id, o, ''), (e: Fault) => e.status === 400);
});

test('navigation trees: derived subpages, sticky exclusion, placed-only pages, cycles, paths, access', () => {
  const { docs, nodes, trees, actor } = setup();
  const o = actor('O'), r = actor('R');
  const method = docs.create(o, 'Method', 'm');
  const sec = docs.createNode(o, { title: '', content: `inside\n${marker(method.id)}` });
  const paper = docs.create(o, 'Paper', `top\n${marker(sec.id)}\n`);
  const appendix = docs.create(o, 'Appendix', 'app');
  const t = trees.create(paper.id, o);
  // Method is mounted through a nameless section: derived as a subpage of Paper.
  assert.deepEqual(t.placements.map((p) => [p.parent, p.child, p.derived]), [[paper.id, method.id, true]]);
  // Explicit placement of an unrelated page.
  assert.equal(trees.place(paper.id, paper.id, appendix.id, o), true);
  assert.deepEqual(trees.children(paper.id, paper.id).map((p) => p.child), [method.id, appendix.id]);
  assert.deepEqual(trees.subpagesNotInline(paper.id, paper.id), [appendix.id]);
  // A reader of the tree root can open a placed page through it.
  docs.share(paper.id, o, r.sub, 'viewer');
  assert.equal(docs.role(appendix.id, r), 'viewer');
  assert.ok(trees.view(paper.id, r).nodes.some((n) => n.id === appendix.id));
  // Reorder.
  trees.move(paper.id, paper.id, appendix.id, o, -1);
  assert.deepEqual(trees.children(paper.id, paper.id).map((p) => p.child), [appendix.id, method.id]);
  // Sticky removal: unmounting and re-mounting does not bring a removed subpage back.
  trees.unplace(paper.id, paper.id, method.id, o);
  assert.equal(trees.isPlaced(paper.id, method.id), false);
  nodes.unmount(sec.id, method.id, o);
  nodes.mount(sec.id, method.id, o);
  assert.equal(trees.isPlaced(paper.id, method.id), false);
  assert.equal(trees.place(paper.id, paper.id, method.id, o), true);
  assert.equal(trees.isPlaced(paper.id, method.id), true);
  // Derived placements follow the mounts.
  const extra = docs.create(o, 'Extra', 'x');
  nodes.mount(method.id, extra.id, o);
  assert.ok(trees.children(paper.id, method.id).some((p) => p.child === extra.id && p.derived));
  nodes.unmount(method.id, extra.id, o);
  assert.ok(!trees.children(paper.id, method.id).some((p) => p.child === extra.id));
  // ... and names: un-naming a derived subpage drops it; naming a mounted section adds it.
  nodes.mount(method.id, extra.id, o);
  docs.rename(extra.id, o, '');
  assert.ok(!trees.isPlaced(paper.id, extra.id));
  docs.rename(extra.id, o, 'Extra again');
  assert.ok(trees.isPlaced(paper.id, extra.id));
  // Renaming a page in a tree announces a tree change (the nav shows titles).
  const changed: string[] = [];
  trees.on('changed', (e: { tree: string }) => changed.push(e.tree));
  docs.rename(method.id, o, 'Method renamed');
  assert.ok(changed.includes(paper.id), 'rename did not announce the tree');
  // Reparent: under another page, at a position; cycles refused; editors of both parents only.
  const extra2 = docs.create(o, 'Extra2', 'x');
  trees.place(paper.id, paper.id, extra2.id, o);
  trees.reparent(paper.id, extra2.id, paper.id, method.id, o, 0);
  assert.deepEqual(trees.children(paper.id, method.id).map((p) => p.child)[0], extra2.id);
  assert.ok(!trees.children(paper.id, paper.id).some((p) => p.child === extra2.id));
  assert.throws(() => trees.reparent(paper.id, method.id, paper.id, extra2.id, o), (e: Fault) => e.status === 409);
  trees.reparent(paper.id, extra2.id, method.id, paper.id, o, 0);
  assert.equal(trees.children(paper.id, paper.id)[0].child, extra2.id);
  assert.throws(() => trees.reparent(paper.id, extra2.id, paper.id, method.id, r, 0), (e: Fault) => e.status === 403);
  // Cycles.
  assert.equal(trees.place(paper.id, method.id, paper.id, o), false);
  // Paths and a second tree.
  trees.create(method.id, o);
  const paths = trees.pathsOf(extra.id, o);
  assert.deepEqual(paths.map((p) => [p.tree, p.path.map((x) => x.id)]).sort(), [[method.id, [method.id, extra.id]], [paper.id, [paper.id, method.id, extra.id]]].sort());
  // Placing needs sharing rights on the child.
  const v = actor('V');
  const theirs = docs.create(v, 'Theirs', 't');
  docs.share(theirs.id, v, o.sub, 'viewer');
  assert.throws(() => trees.place(paper.id, paper.id, theirs.id, o), (e: Fault) => e.status === 403);
  // A section cannot be a root or be placed.
  assert.throws(() => trees.create(sec.id, o), (e: Fault) => e.status === 400);
  // Dropping the tree keeps every page.
  trees.drop(paper.id, o);
  assert.equal(trees.isRoot(paper.id), false);
  assert.ok(docs.get(appendix.id));
});
