# Node model: documents made of sections made of documents

Design note, 2026-10-12 (trees added the same day). Status: agreed, validated by a standalone
prototype (`docs-tree-proto`, see the end). Nothing in this repo implements it yet.

## 1. Why

Neither Notion nor Roam got the unit right. Notion documents are blocks, which
makes them hard to work with as data; Roam's blocks make unstructured prose
awkward. Long-form work (papers, specs, handbooks) is done in *sections*: the
unit people and agents assign, watch, diff, comment on, move and reuse. A
section is large, textual, and sometimes shared between documents.

The model: **one node type**. A node has a body (a text, in some type: markdown,
LaTeX, plain) and may be mounted inside other nodes' bodies. A named node is a
document; a nameless node is a section; a node with an empty body and children
is a folder. The name is the *only* difference between a document and a
section.

Every current Anima document is already a node: a named node with no mounts.
Nothing existing changes until someone mounts a node.

## 2. The model

```
node
  id        opaque, server-assigned
  name      text | null          null = section (reachable only through a parent)
  type      'markdown' | 'latex' | 'text' | …   (per node; the editor and the renderer switch on it)
  body      one Y.Text, exactly as documents are stored today
```

A **mount** is a line in a parent's body that is exactly the marker:

```
{{node:<id>}}
```

Column 0, nothing else on the line, trailing whitespace allowed. Anything else
(`| {{node:x}} |` in a table cell, `- {{node:x}}` in a list, an indented marker)
is literal text, not a mount. This is not a prohibition; it is non-recognition,
and it is the same limit markdown itself has: a table cell cannot hold block
content. Children are block-level, in every type. The rule is lexical and
type-independent: the mount index is a line scan, no parser involved. An
indented marker is the escape when a document is *about* the syntax.

Cycles are refused at mount time (a node cannot contain itself, directly or
transitively). Orphans (nodes with no parent) are allowed and expected.

## 3. Flattening: the virtual document

The editor shows one document: the pre-order flattening of the tree. A parent's
lines are emitted in order; a mount line is replaced by the child's flattened
lines. Line separators that touch a mount line on either side become
**structural newlines**: they exist in the virtual document, belong to no node,
cannot be deleted, and nothing can be inserted *into* them. Consequently:

- every node boundary is a line break, so a boundary is a CodeMirror block widget;
- every virtual position maps to exactly one `(node, offset)` — at a boundary,
  the *deepest* node wins (typing at the first character of a child goes into
  the child; typing at the end of the parent's preceding line goes into the parent);
- a node whose body *starts* with a mount has coinciding seams; the rule above
  resolves them, and the bands stack visually.

A collapsed mount contributes nothing to the virtual document (lazy flatten);
its band stays, with a summary. Collapse state is per view, never synced.
A mounted-but-not-yet-loaded node renders the same way until its body arrives.

## 4. Editing semantics

Local edits are changes to the virtual document, decomposed into per-node ops
(`src/layout.ts` in the prototype is the reference):

- A change is split at structural newlines before it is applied, so the view is
  always consistent with the flattening.
- A deletion touching several nodes deletes the covered ranges in each.
- A deletion that covers a child's whole content **and both seams** detaches the
  child from the parent (the marker line is removed) and touches nothing inside
  it: the node may be mounted elsewhere, and an orphan should be intact. Only the
  outermost covered mounts are detached; nested ones go with them.
- Backspace at a child's first line asks to **merge** the child into the parent
  (its body replaces the marker line). If the node is mounted elsewhere, this is
  a *copy* and the node (and its comments) stay alive. Delete/Backspace on a
  seam otherwise does nothing.
- **Split** at the cursor: the rest of the node's body becomes a new nameless
  child, mounted at the cut.
- Typing a marker line by hand mounts the node (after the client loads it).
- A deleted blank line before a marker is parent text and goes; that is correct.

**Undo** is per node and composite: each client keeps one `Y.UndoManager` per
node (capture timeout 0, tracking only its own origin) and a group stack
recording which nodes each user action touched. Undoing the newest group undoes
its items on every node in it, so a cross-seam delete that detached a child
undoes as one step and re-mounts it. Remote and agent edits are never undone.
Two facts from the prototype: the manager must exist before a node's first local
transaction; and `Item.redone`, which Yjs uses to redirect relative positions
into re-created text, is **peer-local and never synced**, so after undo/redo the
undoing client rewrites the anchors of comments in the touched nodes (untracked
origin). Without this, other peers resolve those anchors by the undone length.

## 5. Names, documents, roots

- `name` lives with the node (synced). Renaming is an edit of the node, not of
  any parent. Names need not be unique; a namespace/path layer can come later
  over the same nodes.
- Any named node can be opened as the **root** of a view: just its subtree.
  Other viewers keep their own roots; edits flow regardless; undo history
  survives re-rooting because it is per node.
- A root bar shows the nearest *named* ancestors (walking up through nameless
  sections) as "up" links.
- Naming a section makes it a document; un-naming makes it a section. Nothing
  else changes.

## 6. Loading protocol

Today a client subscribes to one document room. With mounts, a view needs the
root and every expanded, mounted node. The server keeps a **mount index** from
the line scan of each body (`mounts(parent, child, nth)`), maintained on every
update. On open, the server sends the root and its reachable subtree (depth- and
size-bounded; the rest arrives on expand). When a body gains a marker, the
client requests the child; until it arrives the mount renders as collapsed. A
client may hold many node rooms over one socket; the current per-document
realtime protocol generalises with a node id per frame.

Opening a *tree* (§17) is cheaper than opening a document: the server sends the
placement tree (ids, names, types, order) and nothing else; bodies load when a
page is opened or a mount expands.

## 7. Permissions

A nameless node has no ACL of its own. Access is derived: a principal can read
a node if it can read a parent that mounts it (transitively, to a named node
with an ACL); write likewise. Mounting a node into another document requires
read access to the node, and extends that document's readers to it. Named nodes
keep today's ACL rows and share links. This is the same shape as link-derived
access: it must be re-evaluated when a mount is removed or an ancestor's ACL
changes (the existing role sweep covers it). Guests and the masking rules are
unchanged; they apply per node.

## 8. Comments and anchors

An anchor is `(node, Y relative position)`. A comment has two anchors and may
start in one node and end in another; it resolves per side into the virtual
document and renders across the seam (a comment entirely inside a collapsed node
is simply not drawn). Split and merge re-anchor in two phases around the text
op: resolve to offsets in the old texts, apply, re-create anchors in the new
texts, in one transaction that joins the undo group. A comment on a shared node
belongs to the node; it currently renders at the first instance only (open).

`comments.doc_id` becomes the node id of the *start* anchor; add
`end_doc_id` and a second relative position.

## 9. Suggestions

`suggest.ts` keeps a pending ChangeSet over one shared text. With mounts it
becomes one pending ChangeSet per node, produced by the same decomposition the
editor uses for ordinary edits; a suggestion that spans a seam is two hunks on
two nodes under one suggestion id, accepted or rejected together. The anchor
rules of §8 apply. This is the largest rework of existing code; phase 1 may
restrict suggestions to single-node documents.

## 10. History

Checkpoints stay per node (they are Yjs snapshots of one text). A document's
history is the union of its nodes' checkpoints plus a **composition log**: the
mount index changes, with authors. "Restore the document to T" restores every
node reachable at T to its state at T and the composition to T. Restoring a
node that is shared changes it for every parent; the UI says so before doing it.

## 11. Agents

Per-document machinery becomes per-node unchanged: baselines (snapshots) and
attributed diffs, watches, edits under a server-side client id, activity.
Additions:

- `read_document` returns the tree (node ids, names, types, depth) with bodies
  inline or on request; `read_node`, `edit_node`, `watch` by node id.
- The `sections` wake filter matches node ids (stable) instead of heading text.
- `split`, `merge`, `mount`, `unmount` as tools; `mount` is also just writing a
  marker line.
- Diffs are rendered per node and labelled with the node's breadcrumb.

## 12. Rendering and export

Rendering is block substitution: render the parent with the marker line as a
placeholder block, substitute the child's rendered block. Markdown → HTML as
today; a LaTeX child inside markdown renders as a fragment (or verbatim); a
LaTeX root exports by concatenation with markers mapped to `\input{}`, with an
optional server-side `latexmk` preview. Plain export flattens with heading
levels shifted by depth. Import splits on H1/H2 into sections.

## 13. Performance

The prototype re-flattens and diffs the whole virtual document on every change,
which is fine to roughly 100k characters. The real implementation maps Yjs
deltas into the view incrementally and flattens lazily (collapsed and
not-yet-loaded nodes cost nothing). Per-node syntax highlighting is a
decoration pass per segment in the prototype; a proper mixed-language setup
belongs in the real editor.

## 14. Schema and migration

`documents` already is the per-text unit (update log, state, deletions,
yclients, activity, baselines, checkpoints, comments all key on `doc_id`). It
becomes the node table:

```
documents: title → nullable (null = section); add type TEXT NOT NULL DEFAULT 'markdown'
mounts(parent_id, child_id, nth, PRIMARY KEY (parent_id, child_id, nth))   -- from the line scan
mount_log(seq, parent_id, child_id, op 'mount'|'unmount', sub, at)        -- composition history
comments: add end_doc_id, end_rel (second anchor)
```

Every existing row is a named node with no mounts; the index starts empty. No
data migration, only an idempotent `ALTER` + two tables, as with previous
schema versions.

## 15. Phases

1. Mount index, per-node rooms and the loading protocol, async-aware flatten,
   the editor binding (decomposition, structural newlines, composite undo,
   anchor rewrite after undo), names/outline/collapse/open-as-root, comments
   with two anchors. Suggestions limited to single-node documents. Existing
   documents unaffected.
2. Navigation trees (§17): placements, server-side derivation, the nav pane,
   subpages footer, tree-scoped access and watches. Suggestions over the
   virtual document; composition log and multi-node restore; agent tools per
   node; node-id wake filters.
3. LaTeX export/preview; folders/paths over names; read-only transclusion if
   still wanted.

## 16. Open

- Comments on a shared node: render at every instance, or at the one in view?
- Shared-node restore: warn (current intent) vs fork on restore.
- Name uniqueness and the path layer.
- Whether a merge of a *shared* node should be offered at all, or only "copy".
- Nav disambiguation when two placed pages share a name (path or id).
- "Convert placement to inline mount" and the reverse as nav actions.
- "+ tree" on a long document makes it the landing page of the tree; whether to
  offer "new tree with this document as first page" instead.

## 17. Navigation trees

A document placed in a tree gets a Notion-style left nav. This is a *second
kind of edge* over the same nodes, and it must stay distinct from mounts, or
directories collapse back into inline inclusion.

```
placement (tree, parent, child, order, derived)
```

- A **tree** is a node designated as a root (`trees(root_id)`); the nav shows
  the placements under it. Roots are listed in the interface; a tree is opened
  by its root. The root's own body is the landing page.
- A placement has **no effect on any body**. A node may be placed in several
  trees and under several parents; a placement may not cycle within one tree.
- **Subpages by default.** When a document is placed, its *named* mounted
  descendants (looking through nameless sections) are placed under it, marked
  `derived`. New mounts inside a placed document place themselves. Sections are
  never placed: they are the document's outline, not pages.
- **Derived placements follow the mounts.** When the child loses its name or is
  no longer mounted under that parent, the derived placement goes. Explicit
  placements (made by a person or an agent) persist until removed.
- **Removing is sticky.** Removing a placement never deletes anything; it leaves
  an exclusion `(tree, parent, child)` so the subpage is not re-derived behind
  the user's back. An explicit re-place clears the exclusion.
- A page that is placed under a parent but **not mounted inline** in it is
  rendered as an automatic *Subpages* footer in the parent's view: rendered,
  never written into the body. "+ subpage" in the nav creates a named node and a
  placement only; mounting it inline is a separate act.
- **Path context.** A node in several trees has several paths; the breadcrumb is
  the path of the tree it was opened through (the tree is part of the URL), with
  "also in: …" for the other trees where it is placed or is a root.
- **Unfiled**: named nodes in no tree and with no parent, listed so they can be
  found. Remove-from-tree and delete are different actions and look different.
- **Access through trees** works like access through mounts (§7): a placement
  extends the readers of the tree to the page, and making one requires that the
  placer could share the page. Trees are the natural sharing unit ("share this
  workspace"); the role sweep re-evaluates on unplace and on ACL changes.
- **Agents.** `tree(root)` returns the placement tree; `place`, `unplace`,
  `move`; a watch on a tree root covers every page under it (new pages, edits
  anywhere) in one digest — the "work on a document set" case. Derivation is
  the server's job, off the mount index, on every body update.
- Per-user nav collapse state is client-local. Search and the documents list
  can be scoped to the current tree.

Schema:

```
trees(root_id PRIMARY KEY REFERENCES documents(id), created_by, created_at)
placements(tree_id, parent_id, child_id, ord REAL, derived INTEGER, placed_by, at,
           PRIMARY KEY (tree_id, parent_id, child_id))
placement_exclusions(tree_id, parent_id, child_id, by, at, PRIMARY KEY (tree_id, parent_id, child_id))
```

Prototype: `src/trees.ts` (placements, derivation, exclusions, paths, cycles,
subpages-not-inline, unfiled), the nav pane and footer in `src/main.ts`; six
Playwright steps cover derivation, naming, "+ subpage", sticky removal, a second
tree with "also in", cycle refusal and reordering synced to the other peer.

## Prototype

`docs-tree-proto` (local, not in this repo): CodeMirror 6 over a tree of Yjs
texts, two peers on one page with adjustable latency, an "agent" editing nodes
directly. `src/layout.ts` (flatten / placeAt / decompose / splitChange) is the
reference for §3–4; `src/undo.ts` for composite undo; `src/comments.ts` for
anchors and re-anchoring. 10 unit tests on the layout logic and a 33-step
Playwright run (39 steps) covering seams, cross-seam edits, concurrent peers, hand-typed
mounts, split/merge/detach, composite undo and redo, spanning comments through
split and merge, three-level nesting, shared nodes, collapse, naming and
re-rooting, and navigation trees.
