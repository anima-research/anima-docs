# Spreadsheets: how they are stored, and why

Design note, 2026-11-18. Implemented: `src/sheet.ts` (the model, shared by server and browser),
`src/sheetcalc.ts` (values and formats), `src/sheets.ts` (what agents read and change, Excel),
`web/sheetgrid.ts` (the grid).

## 1. What had to hold

Anima Docs is used by organisations where several people and agents work in one sheet at the same
moment. The storage is chosen for that:

- two writes to one cell leave one of the two values on every screen, never a mixture of both;
- a row inserted, removed or moved by one person does not shift what another person is typing,
  or what a formula written a moment ago points at;
- everything a document has still works: history, restore, undo of one change, "what changed since
  you last looked" with authors, search, sharing, links.

A sheet kept as text in the document's `Y.Text` (rows as lines) would have given the last point
for free and failed the first: a text CRDT merges two replacements of `100` into `150250`.

## 2. The stored form

A spreadsheet's Y.Doc holds eight root maps of plain strings and numbers. Nothing is nested, so
the server can check every incoming update completely (`Documents.applyClientUpdate`).

```
sheets  <sheet>                -> order key        (the sheet exists)
names   <sheet>                -> its name
rows    <sheet>:<row>          -> order key        (the row exists)
cols    <sheet>:<col>          -> order key
cells   <sheet>:<row>:<col>    -> what was typed   (a formula starts with "=")
fmt     <sheet>:<row>:<col>    -> number format    (<sheet>::<col> for a whole column)
widths  <sheet>:<col>          -> column width, px
charts  <sheet>:<chart>        -> a chart on the sheet (JSON: settings, its range by ids, the cell it sits on)
```

- **Cells are map entries.** A map entry has one value: concurrent writes resolve to one of them.
- **Rows, columns and sheets have ids.** A cell belongs to a row id and a column id, not to a
  position. Position is an *order key* (fractional indexing): inserting is one new entry, moving
  is one changed entry, and two people inserting at the same place both keep their rows (equal
  keys are ordered by id; inserting between them gives the later ones fresh keys).
- **Formulas point at ids.** `=SUM(C2:C9)` is stored as `=SUM(⟦r1.c3⟧:⟦r8.c3⟧)`. Addresses exist
  only at the edges: what people and agents read and type, what the formula engine is given, what
  goes into Excel. So an insert rewrites no formula (a delete or a sort rewrites only those of §3),
  and a formula typed while someone else inserts a row above still means what its author saw. A reference past the end of the sheet
  grows the sheet (up to 1,000 rows, 100 columns) or stays an address.

## 3. Where addresses still decide

Identity alone would make two things worse than Excel, so the operation that causes them writes
the affected formulas, in the same transaction:

- **Deleting the first or last row (or column) of a range** shrinks the range (`SUM(B2:B9)`
  without row 9 is `SUM(B2:B8)`); a range that goes entirely, or a single cell, reads `#REF!`.
- **Sorting** moves whole rows (each takes the order key of the place it moves to), so a cell
  someone is editing moves with its row. Afterwards formulas read as after a sort in Excel: inside
  the sorted rows a formula points at the same places relative to itself (its own row, the row
  above: a running balance keeps running); outside them a formula covers the same area. Better than
  Excel in one respect: a reference from a sorted row to a cell outside the sorted rows stays on
  that cell without needing `$`.

These rewrites are ordinary cell writes: if someone edits the same formula in the same instant,
one of the two versions stays. A stale one usually shows as `#REF!` or a different range in the
formula bar, but it can also be a range that still evaluates, over other rows than its author
meant. What cannot happen is a data cell (a number someone typed) changing value or row.

## 4. Everything else is derived

- **Text.** `bookText` renders a book as lines (a `## name` line per sheet, cells between tabs).
  `Documents.text` and `textAt` return it for a spreadsheet, so search, link previews and the
  history's comparison need no second path.
- **History.** Checkpoints are Yjs snapshots, as for text. Reading a map at a snapshot needs the
  document's records cut at the snapshot first (`atSnapshots`): Yjs joins the successive values of
  an entry into one record once all are overwritten, and `typeMapGetAllSnapshot` alone then
  misreads the entry's past. Restore and undo work entry by entry (`diffStores`): restore makes
  every entry what it was; undo puts back each entry a change touched, and is refused if one of
  them now holds something else than the change left there, or if rows, columns or a sheet the
  change added have had content put into them since.
- **What changed.** `bookChanges` compares two states by id: rows, columns and sheets added or
  removed, then each cell with what it held, addressed as the sheet stands now. Cells are compared
  as stored, so a formula is not "changed" because a row was inserted above it.
- **Values.** HyperFormula, built from the book with formulas decoded to addresses. The browser
  keeps one engine and feeds it cell writes; a change of shape rebuilds it (about 0.3 s per 100,000
  cells). The server keeps the engines of the eight spreadsheets read last, each until its
  document changes.

## 5. Not built: document types made by agents

The request that led here also asked for types that agents can add without touching this
repository (a bookkeeping ledger, say). The shape agreed in conversation, for later:

- A **type is a document**: a `type.json` (name, base type, and for a sheet its columns, computed
  columns, summary sheets, starting rows), an `index.md` telling agents how to approach documents
  of the type, and optionally an `index.html` view run in the sandbox HTML pages use.
- A document of that type is **stored in its base type's format** (a ledger is a spreadsheet), so
  history, export and everything above keep working, and without the type it is still a plain sheet.
- To build: the reference from a document to its type; the server checking rows against the
  columns; a channel for a sandboxed view to read and write its document's content.
- Not planned: running agent-written code in the server.
