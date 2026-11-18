import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import ExcelJS from 'exceljs';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { TOOLS } from '../src/tools.js';
import { insertRows, liveStore, readBook, setInput } from '../src/sheet.js';
import { startServer } from './server-harness.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const app = createApp(loadConfig({ DOCS_DATA_DIR: ':memory:', DOCS_ORIGIN: 'http://x', DOCS_ISSUERS: '' } as any), new Map(), { history: { idleMs: 60, agentIdleMs: 40, maxMs: 400 } });
  const admit = (name: string, kind: 'human' | 'agent') => app.principals.admit({ sub: kind === 'human' ? `human:test:${name.toLowerCase()}` : `agent:${name.toLowerCase()}@test.local`, name, kind, issuer: 'test.local', scopes: [], claims: {}, exp: Date.now() / 1000 + 3600 }, kind === 'human' ? 'web' : 'mcpl');
  const ann = admit('Ann', 'human'), bob = admit('Bob', 'human'), quill = admit('Quill', 'agent');
  const run = (who: any) => async (name: string, args: Record<string, unknown>) => ((await TOOLS.find((t) => t.name === name)!.run(app, who, args)) as any).content[0].text as string;
  const d = app.docs.create(ann, 'Ledger', 'date,item,amount\n2026-01-05,Rent,1200\n2026-01-07,"Food, drink",80.5\n2026-01-09,Books,40', 'sheet');
  app.docs.share(d.id, ann, bob.sub, 'editor');
  app.docs.share(d.id, ann, quill.sub, 'editor');
  /** A browser: its own copy of the document, sending what it changed. */
  const browser = (who: { sub: string }) => {
    const doc = new Y.Doc();
    const pull = () => Y.applyUpdate(doc, Y.encodeStateAsUpdate(app.docs.ydoc(d.id), Y.encodeStateVector(doc)));
    pull();
    const push = () => app.docs.applyClientUpdate(d.id, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(app.docs.ydoc(d.id))), { sub: who.sub, via: 'web' });
    const book = () => readBook(liveStore(doc));
    return { doc, pull, push, book, type: (row: number, col: number, text: string) => doc.transact(() => { const b = book(); setInput(doc, b, b.sheets[0], row, col, text); }) };
  };
  return { app, ann, bob, quill, d, tool: run(quill), as: run, browser };
}

test('a spreadsheet is made as one, from rows of text; its text is its cells; it stays a spreadsheet', () => {
  const { app, ann, d } = setup();
  try {
    assert.equal(d.type, 'sheet');
    assert.equal(app.docs.text(d.id), '## Sheet1\ndate\titem\tamount\n2026-01-05\tRent\t1200\n2026-01-07\tFood, drink\t80.5\n2026-01-09\tBooks\t40');
    assert.throws(() => app.docs.setType(d.id, ann, 'markdown'), /stays a spreadsheet/);
    const note = app.docs.create(ann, 'Note', 'hello');
    assert.throws(() => app.docs.setType(note.id, ann, 'sheet'), /made as one/);
    assert.throws(() => app.docs.edit(d.id, ann, (t) => t.insert(0, 'x')), /edit_sheet/);
    assert.throws(() => app.nodes.mount(note.id, d.id, ann), /cannot be mounted/);
    assert.equal(app.docs.search(ann, 'food, drink').length, 1);
  } finally { app.close(); }
});

test('a browser’s cell writes are taken; anything that is not a cell value is refused', () => {
  const { app, ann, bob, d, browser } = setup();
  try {
    const a = browser(ann);
    a.type(1, 2, '1250');           // overwrites a cell the server already has
    a.type(5, 0, '=SUM(C2:C4)');    // a new cell
    a.doc.transact(() => { insertRows(a.doc, a.book().sheets[0], 2, 1); });
    a.push();
    const s = app.sheets.book(d.id).sheets[0];
    assert.equal(app.sheets.calc(d.id).shown(s, 6, 0).text, '1370.5');
    // Written twice before sending: the second write follows the first inside one update.
    a.type(8, 0, 'one'); a.type(8, 0, 'two');
    a.push();
    assert.match(app.docs.text(d.id), /^two$/m);
    // Authorship is the sender's.
    const b = browser(bob);
    b.type(1, 1, 'Rent (flat)');
    b.push();
    b.type(1, 1, 'Rent (house)');
    assert.throws(() => app.docs.applyClientUpdate(d.id, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(app.docs.ydoc(d.id))), { sub: ann.sub, via: 'web' }), /another principal/);
    b.push();
    assert.match(app.docs.text(d.id), /Rent \(house\)/);
    const refused = (fn: (doc: Y.Doc) => void, why: RegExp) => { const c = browser(bob); c.doc.transact(() => fn(c.doc)); assert.throws(() => c.push(), why); };
    refused((doc) => doc.getMap('cells').set('a:b:c', { nested: true } as any), /Only cell values/);
    refused((doc) => doc.getMap('cells').set('a:b:c', new Y.Map() as any), /Only cell values/);
    refused((doc) => doc.getMap('cells').set('a:b:c', ['x'] as any), /Only cell values/);
    refused((doc) => doc.getMap('elsewhere').set('k', 'v'), /Only cell values/);
    refused((doc) => doc.getMap('cells').set('bad key!', 'v'), /Only cell values/);
    refused((doc) => doc.getText('body').insert(0, 'text'), /Only cell values/);
    refused((doc) => doc.getMap('cells').set('a:b:c', 'x'.repeat(40_000)), /Only cell values/);
    // A browser that keeps what it overwrote (no garbage collection) sends one cell's successive values joined: taken.
    const keeper = new Y.Doc({ gc: false });
    Y.applyUpdate(keeper, Y.encodeStateAsUpdate(app.docs.ydoc(d.id)));
    for (const v of ['k1', 'k2', 'k3']) keeper.transact(() => { const bk = readBook(liveStore(keeper)); setInput(keeper, bk, bk.sheets[0], 9, 0, v); });
    app.docs.applyClientUpdate(d.id, Y.encodeStateAsUpdate(keeper, Y.encodeStateVector(app.docs.ydoc(d.id))), { sub: ann.sub, via: 'web' });
    assert.match(app.docs.text(d.id), /^k3$/m);
    // And a text document takes no cells.
    const note = app.docs.create(ann, 'Note', 'hello');
    const n = new Y.Doc();
    Y.applyUpdate(n, Y.encodeStateAsUpdate(app.docs.ydoc(note.id)));
    n.getMap('cells').set('a:b:c', '1');
    assert.throws(() => app.docs.applyClientUpdate(note.id, Y.encodeStateAsUpdate(n, Y.encodeStateVector(app.docs.ydoc(note.id))), { sub: ann.sub, via: 'web' }), /Only plain text/);
  } finally { app.close(); }
});

test('agents read a sheet as values, a part of it, or what was typed', async () => {
  const { app, d, tool } = setup();
  try {
    await tool('edit_sheet', { document: d.id, changes: [{ set: 'A5', values: [['total', '', '=SUM(C2:C4)']] }, { format: 'C:C', as: '#,##0.00' }] });
    const all = await tool('read_document', { document: d.id });
    assert.match(all, /“Ledger” \(d\w+, spreadsheet\)/);
    assert.match(all, /Sheets: Sheet1 \(5 rows × 3 columns filled; 100 × 26 in all\)/);
    assert.match(all, /<<<SHEET\n\tA\tB\tC\n1\tdate\titem\tamount\n2\t2026-01-05\tRent\t1,200.00\n3\t2026-01-07\tFood, drink\t80.50\n4\t2026-01-09\tBooks\t40.00\n5\ttotal\t\t1,320.50\nSHEET>>>/);
    const part = await tool('read_document', { document: d.id, range: 'B2:C3', formulas: true });
    assert.match(part, /Showing Sheet1!B2:C3 — what was typed/);
    assert.match(part, /\n\tB\tC\n2\tRent\t1200\n3\tFood, drink\t80.5\nSHEET>>>/);
    assert.match(await tool('read_document', { document: d.id, range: 'C5', formulas: true }), /5\t=SUM\(C2:C4\)/);
    await assert.rejects(tool('read_document', { document: d.id, range: 'Nowhere!A1' }), /No sheet “Nowhere”\. Sheets: Sheet1/);
    assert.match(await tool('list_documents', {}), /\[spreadsheet\]/);
  } finally { app.close(); }
});

test('edit_sheet: cells, appended rows, inserts, deletes, sorting, sheets; one call is all or nothing', async () => {
  const { app, d, tool } = setup();
  try {
    const grid = async (range?: string) => /<<<SHEET\n[^\n]*\n([\s\S]*)\nSHEET>>>/.exec(await tool('read_document', { document: d.id, range, formulas: true }))?.[1].split('\n').map((l) => l.split('\t').slice(1).join('|')) ?? [];
    let out = await tool('edit_sheet', { document: d.id, changes: [
      { append: [['2026-01-03', 'Paper', 12], ['2026-01-02', 'Ink', true]] },
      { set: 'D1', value: 'double' }, { set: 'D2', values: [['=C2*2'], ['=C3*2']] },
      { set: 'A8', values: [['total', null, '=SUM(C2:C6)']] },
    ] });
    assert.match(out, /Appended 2 rows to Sheet1 at rows 5–6\.\nWrote D1\.\nWrote D2:D3\.\nWrote A8:C8\./);
    assert.deepEqual(await grid('A5:C8'), ['2026-01-03|Paper|12', '2026-01-02|Ink|TRUE', '', 'total||=SUM(C2:C6)']);
    out = await tool('edit_sheet', { document: d.id, changes: [{ sort: 'A2:D6', by: 'A' }] });
    assert.match(out, /Sorted rows 2–6 of Sheet1 by column A\. Whole rows moved\./);
    assert.deepEqual(await grid('A1:D8'), ['date|item|amount|double', '2026-01-02|Ink|TRUE', '2026-01-03|Paper|12', '2026-01-05|Rent|1200|=C4*2', '2026-01-07|Food, drink|80.5|=C5*2', '2026-01-09|Books|40', '', 'total||=SUM(C2:C6)']);
    out = await tool('edit_sheet', { document: d.id, changes: [{ insert_rows: 2, count: 1 }, { set: 'A2', values: [['2026-01-01', 'Opening', 500]] }, { delete_rows: 3 }, { insert_columns: 'B' }, { delete_columns: 'E' }] });
    assert.deepEqual(await grid('A1:D8'), ['date||item|amount', '2026-01-01||Opening|500', '2026-01-03||Paper|12', '2026-01-05||Rent|1200', '2026-01-07||Food, drink|80.5', '2026-01-09||Books|40', '', 'total|||=SUM(D3:D6)']); // the row put in above the range is not in it, as in Excel
    out = await tool('edit_sheet', { document: d.id, changes: [{ rename_sheet: 'Sheet1', to: 'Ledger' }, { add_sheet: 'Summary' }, { set: 'Summary!A1', values: [['spent', '=SUM(Ledger!D2:D6)']] }, { sheet: 'Summary', set: 'A2', value: 'n' }, { sheet: 'Summary', set: 'B2', value: '=COUNTA(Ledger!C:C)-1' }] });
    assert.match(await tool('read_document', { document: d.id, range: 'Summary' }), /1\tspent\t1832\.5\n2\tn\t5\n/);
    // One bad change: none of the call applies.
    const before = app.docs.text(d.id), rev = app.docs.get(d.id)!.rev;
    await assert.rejects(tool('edit_sheet', { document: d.id, changes: [{ set: 'A1', value: 'CHANGED' }, { delete_sheet: 'Nope' }] }), /Change 2: No sheet “Nope”.* Nothing was changed\./);
    await assert.rejects(tool('edit_sheet', { document: d.id, changes: [{ add_sheet: 'ledger' }] }), /already a sheet named “Ledger”/);
    await assert.rejects(tool('edit_sheet', { document: d.id, changes: [{ frobnicate: 1 }] }), /not a change I know/);
    assert.equal(app.docs.text(d.id), before);
    assert.equal(app.docs.get(d.id)!.rev, rev);
    await assert.rejects(tool('edit_document', { document: d.id, edits: [{ append: 'x' }] }), /use edit_sheet/);
    await assert.rejects(tool('suggest_edit', { document: d.id, edits: [{ append: 'x' }] }), /no suggestions yet/);
    await assert.rejects(tool('add_comment', { document: d.id, quote: 'Rent', text: 'why?' }), /name the cells/);
    assert.match(await tool('add_comment', { document: d.id, text: 'Is D4 right?' }), /Comment thread \w+ created/);
    assert.match(await tool('search', { query: 'opening', document: d.id }), /Opening/);
  } finally { app.close(); }
});

test('what changed is told by cell with who wrote it; history restores and undoes', async () => {
  const { app, ann, bob, d, tool, as, browser } = setup();
  try {
    await tool('read_document', { document: d.id });
    await sleep(80);
    const a = browser(ann);
    a.type(1, 2, '1300'); a.push();
    const b = browser(bob);
    b.type(3, 1, ''); b.type(4, 0, 'new row'); b.push();
    await sleep(80);
    const changes = await tool('changes', { document: d.id, mark_read: false });
    assert.match(changes, /“Ledger” \(d\w+\) changed since you last looked — 3 cells by /);
    assert.match(changes, /\nB4: Books → \(empty\) · Bob/);
    assert.match(changes, /\nC2: 1200 → 1300 · Ann/);
    assert.match(changes, /\nA5: \(empty\) → new row · Bob/);
    // The agent's own edit is not news to it; what the others did before it still is.
    await tool('edit_sheet', { document: d.id, changes: [{ set: 'A6', value: 'mine' }, { set: 'C2', value: 1301 }] });
    const after = await tool('changes', { document: d.id });
    assert.match(after, /2 cells by Bob/);
    assert.ok(!/mine|1301|C2/.test(after), after);
    assert.match(await tool('changes', { document: d.id }), /Nothing changed since you last looked/);
    await tool('edit_sheet', { document: d.id, changes: [{ set: 'C2', value: 1300 }] });
    await sleep(80);
    const versions = await tool('versions', { document: d.id });
    const ids = [...versions.matchAll(/^\s+(h\d+)\s/gm)].map((m) => m[1]);
    assert.ok(ids.length >= 3, versions);
    const people = /^\s+(h\d+)\s[^\n]*Ann, Bob|^\s+(h\d+)\s[^\n]*Bob, Ann/m.exec(versions)!;
    const h = people[1] ?? people[2];
    assert.match(await tool('changes', { document: d.id, from: h, to: h }), /changed in h\d+ — 3 cells/);
    // Undo just the people's stretch: the agent's later cell stays.
    assert.match(await tool('undo_change', { document: d.id, change: h }), /Undid h\d+/);
    assert.equal(app.docs.text(d.id), '## Sheet1\ndate\titem\tamount\n2026-01-05\tRent\t1200\n2026-01-07\tFood, drink\t80.5\n2026-01-09\tBooks\t40\n\nmine');
    await assert.rejects(tool('undo_change', { document: d.id, change: h }), /no longer in the document/);
    // A later write to one of its cells blocks undoing a change on its own.
    await as(ann)('edit_sheet', { document: d.id, changes: [{ set: 'B2', value: 'Rent!' }] });
    await sleep(80);
    const v2 = await tool('versions', { document: d.id });
    const annChange = /^\s+(h\d+)\s[^\n]*Ann\s+\+/m.exec(v2)![1];
    await tool('edit_sheet', { document: d.id, changes: [{ set: 'B2', value: 'Rent?' }] });
    await assert.rejects(tool('undo_change', { document: d.id, change: annChange }), /Later edits changed the same cells/);
    // Restore to where history begins: the sheet as it was made.
    const made = [...v2.matchAll(/^\s+(h\d+)\s/gm)].map((m) => m[1]).at(-2)!; // the last listed is where history begins: nothing yet
    await tool('restore_version', { document: d.id, version: made, at: 'after' });
    assert.equal(app.docs.text(d.id), '## Sheet1\ndate\titem\tamount\n2026-01-05\tRent\t1200\n2026-01-07\tFood, drink\t80.5\n2026-01-09\tBooks\t40');
    const v = app.docs.saveVersion(d.id, ann, 'clean');
    await tool('edit_sheet', { document: d.id, changes: [{ delete_rows: 2, count: 2 }, { add_sheet: 'Scratch' }] });
    await tool('restore_version', { document: d.id, version: v.id });
    assert.equal(app.sheets.book(d.id).sheets.length, 1);
    assert.match(app.docs.text(d.id), /Rent\t1200\n2026-01-07/);
  } finally { app.close(); }
});

test('the Excel file holds values, formulas with their results, formats and widths', async () => {
  const S = await startServer();
  try {
    const ann = S.app.principals.admit({ sub: 'human:test:ann', name: 'Ann', kind: 'human', issuer: 'test.local', scopes: [], claims: {}, exp: Date.now() / 1000 + 3600 }, 'web');
    const d = S.app.docs.create(ann, 'Q1 / Ledger', 'date\titem\tamount\n2026-01-05\tRent\t1200\n2026-01-07\tFood\t80.5', 'sheet');
    S.app.sheets.apply(d.id, ann, [{ set: 'A4', values: [['total', '', '=SUM(C2:C3)'], ['share', '', '=C2/C4'], ['bad', '', '=1/0']] }, { format: 'C2:C4', as: '€#,##0.00' }, { format: 'C5', as: '0.0%' }, { add_sheet: 'Notes & such' }, { set: "'Notes & such'!A1", value: '=Sheet1!C4' }]);
    S.app.docs.editSheet(d.id, ann, (doc) => { const s = readBook(liveStore(doc)).sheets[0]; doc.getMap('widths').set(`${s.id}:${s.cols[1]}`, 225); });
    const agent = S.token('Quill');
    const quill = S.app.verify(agent);
    assert.equal((await fetch(`${S.base}/api/docs/${d.id}/export.xlsx`, { headers: { Authorization: `Bearer ${agent}` } })).status, 404, 'no access, no file');
    S.app.docs.share(d.id, ann, S.app.principals.admit(quill, 'mcpl').sub, 'viewer');
    const res = await fetch(`${S.base}/api/docs/${d.id}/export.xlsx`, { headers: { Authorization: `Bearer ${agent}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /filename="Q1 {2,3}Ledger\.xlsx"/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as any);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['Sheet1', 'Notes & such']);
    const ws = wb.getWorksheet('Sheet1')!;
    assert.equal(ws.getCell('B2').value, 'Rent');
    assert.equal(ws.getCell('C2').value, 1200);
    assert.equal(ws.getCell('C2').numFmt, '"€"#,##0.00');
    assert.equal(ws.getCell('A2').numFmt, 'yyyy-mm-dd');
    assert.equal((ws.getCell('A2').value as Date).toISOString(), '2026-01-05T00:00:00.000Z');
    assert.deepEqual(ws.getCell('C4').value, { formula: 'SUM(C2:C3)', result: 1280.5 });
    assert.equal(ws.getCell('C5').numFmt, '0.0%');
    assert.deepEqual(ws.getCell('C6').value, { formula: '1/0', result: { error: '#DIV/0!' } });
    assert.equal(ws.getColumn(2).width, 30);
    assert.deepEqual(wb.getWorksheet('Notes & such')!.getCell('A1').value, { formula: 'Sheet1!C4', result: 1280.5 });
    // On a published page a spreadsheet is its values, as tables.
    assert.equal(S.app.sheets.markdown(d.id).split('\n\n## ')[0], '## Sheet1\n\n| date | item | amount |\n| --- | --- | --: |\n| 2026-01-05 | Rent | €1,200.00 |\n| 2026-01-07 | Food | €80.50 |\n| total |  | €1,280.50 |\n| share |  | 93.7% |\n| bad |  | #DIV/0! |');
    const md = await fetch(`${S.base}/api/docs/${S.app.docs.create(ann, 'Note', 'x').id}/export.xlsx`, { headers: { Authorization: `Bearer ${S.token('Quill')}` } });
    assert.notEqual(md.status, 200);
  } finally { await S.close(); }
});
