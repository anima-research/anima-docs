import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {
  addSheet, bookChanges, bookText, colIndex, colName, decodeFormula, deleteRows, deleteCols, encodeFormula, grids, initBook, input, insertCols, insertRows,
  liveStore, mapRefs, parseRange, parseTsv, readBook, renameSheet, reorderRows, restoreStore, setBlock, setFormat, setInput, shiftFormula, stored, toTsv,
} from '../src/sheet.js';
import { sheetStoreAt } from '../src/documents.js';
import { Calc, formatNumber } from '../src/sheetcalc.js';

function book(rows: string[][] = []) {
  const doc = new Y.Doc({ gc: false });
  doc.transact(() => { initBook(doc); });
  const read = () => readBook(liveStore(doc));
  if (rows.length) doc.transact(() => { setBlock(doc, read(), read().sheets[0].id, 0, 0, rows); });
  const first = () => read().sheets[0];
  const at = (a1: string) => { const b = read(); const p = parseRange(a1)!; const s = p.sheet ? b.byName.get(p.sheet.toLowerCase())! : b.sheets[0]; return input(b, s, p.rect.top, p.rect.left); };
  const put = (a1: string, text: string) => doc.transact(() => { const b = read(); const p = parseRange(a1)!; const s = p.sheet ? b.byName.get(p.sheet.toLowerCase())! : b.sheets[0]; setBlock(doc, b, s.id, p.rect.top, p.rect.left, [[text]]); });
  const value = (a1: string) => { const b = read(); const calc = new Calc(b); const p = parseRange(a1)!; const s = p.sheet ? b.byName.get(p.sheet.toLowerCase())! : b.sheets[0]; const v = calc.shown(s, p.rect.top, p.rect.left).text; calc.destroy(); return v; };
  return { doc, read, first, at, put, value };
}
/** Two people's documents, exchanging everything they have. */
function sync(a: Y.Doc, b: Y.Doc) {
  const ua = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), ub = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
  Y.applyUpdate(b, ua); Y.applyUpdate(a, ub);
}
function pair(rows: string[][]) {
  const one = book(rows);
  const doc2 = new Y.Doc({ gc: false });
  sync(one.doc, doc2);
  const read2 = () => readBook(liveStore(doc2));
  return { ...one, doc2, read2, both: () => { sync(one.doc, doc2); assert.equal(bookText(one.read()), bookText(read2())); return bookText(one.read()); } };
}

test('addresses: column names both ways, ranges with open ends and sheet names', () => {
  assert.deepEqual([0, 25, 26, 701, 702].map(colName), ['A', 'Z', 'AA', 'ZZ', 'AAA']);
  assert.deepEqual(['A', 'Z', 'AA', 'zz', 'AAA'].map(colIndex), [0, 25, 26, 701, 702]);
  assert.deepEqual(parseRange('B2'), { sheet: null, rect: { top: 1, left: 1, bottom: 1, right: 1 } });
  assert.deepEqual(parseRange('D9:B2'), { sheet: null, rect: { top: 1, left: 1, bottom: 8, right: 3 } });
  assert.deepEqual(parseRange("'My sheet'!B:D"), { sheet: 'My sheet', rect: { top: 0, left: 1, bottom: -1, right: 3 } });
  assert.deepEqual(parseRange('Ledger!A2:C'), { sheet: 'Ledger', rect: { top: 1, left: 0, bottom: -1, right: 2 } });
  assert.equal(parseRange('nonsense here'), null);
});

test('references: found in formulas, and nowhere else', () => {
  const seen: string[] = [];
  const out = mapRefs('=SUM(A1:B2)+LOG10(C3)*1E5+"A1 and ""B2"""+Sheet2!$D$4+\'It\'\'s\'!E5:F6+SUMIF(A:A,TRUE,$B:$B)+Über2+ATAN2(1,2)+.5', (ref, text) => { seen.push(text); return `<${text}>`; });
  assert.deepEqual(seen, ['A1:B2', 'C3', 'Sheet2!$D$4', "'It''s'!E5:F6", 'A:A', '$B:$B']);
  assert.equal(out, '=SUM(<A1:B2>)+LOG10(<C3>)*1E5+"A1 and ""B2"""+<Sheet2!$D$4>+<\'It\'\'s\'!E5:F6>+SUMIF(<A:A>,TRUE,<$B:$B>)+Über2+ATAN2(1,2)+.5');
});

test('a formula is stored by what it points at, and reads back as typed', () => {
  const { read, first, doc, at } = book([['1', '2', '=A1+B1'], ['3', '4', '=SUM(A1:B2)']]);
  const b = read();
  for (const f of ['=A1+B1', '=SUM($A$1:B2)', '=SUMIF(A:A,">1",B:B)', '="A1"&A2', '=Sheet1!B2*2', '=IF(A1>0,TRUE,FALSE)', '=A1:B2']) {
    const enc = encodeFormula(b, first(), f);
    if (f !== '=IF(A1>0,TRUE,FALSE)' && !f.includes('"A1"')) assert.ok(!/[A-Z]\d/.test(enc.replace(/⟦[^⟧]*⟧/g, '')), `${f} -> ${enc}`);
    assert.equal(decodeFormula(b, first(), enc), f === '=Sheet1!B2*2' ? '=Sheet1!B2*2' : f);
  }
  assert.ok(stored(b, first(), 0, 2).includes('⟦'));
  // A row inserted above: the formula follows its cells, and nothing was rewritten.
  const before = stored(read(), first(), 0, 2);
  doc.transact(() => { insertRows(doc, first(), 0, 2); });
  assert.equal(stored(read(), first(), 2, 2), before);
  assert.equal(at('C3'), '=A3+B3');
  assert.equal(at('C4'), '=SUM(A3:B4)');
  doc.transact(() => { insertCols(doc, first(), 1, 1); });
  assert.equal(at('D3'), '=A3+C3');
  // The row a formula points into goes: #REF!.
  doc.transact(() => { deleteRows(doc, read(), first(), 2, 1); });
  assert.equal(at('D3'), '=SUM(A3:C3)');
  assert.equal(at('D2'), ''); // the row that held =A3+C3 is the one that went
});

test('a range grows with rows put inside it; a sort keeps every formula on its row', () => {
  const t = book([['item', 'n'], ['b', '2'], ['a', '1'], ['c', '3'], ['total', '=SUM(B2:B4)']]);
  t.doc.transact(() => { insertRows(t.doc, t.first(), 2, 1); });
  t.put('B3', '10');
  assert.equal(t.at('B6'), '=SUM(B2:B5)');
  assert.equal(t.value('B6'), '16');
  t.put('C2', '=B2*2');
  // Sort rows 2..5 by column A.
  const s = t.first();
  const order = [1, 2, 3, 4].sort((x, y) => input(t.read(), s, x, 0).localeCompare(input(t.read(), s, y, 0)));
  t.doc.transact(() => { reorderRows(t.doc, t.read(), s, 1, order); });
  assert.deepEqual(grids(t.read()).get(s.id)!.map((r) => r[0]), ['item', '', 'a', 'b', 'c', 'total']);
  assert.equal(t.at('C4'), '=B4*2'); // the formula moved with its row and still reads its own row
  assert.equal(t.at('B6'), '=SUM(B2:B5)'); // the total still covers the sorted area
  assert.equal(t.value('B6'), '16');
});

test('a sort keeps a running balance running, and a reference to a cell outside the sorted rows where it was', () => {
  const t = book([['date', 'amount', 'balance', 'share', '100'], ['3', '30', '=B2', '=B2/$E$1'], ['1', '10', '=C2+B3', '=B3/E1'], ['2', '20', '=C3+B4', '=B4/$E$1']]);
  assert.equal(t.value('C4'), '60');
  const s = t.first();
  t.doc.transact(() => { reorderRows(t.doc, t.read(), s, 1, [2, 3, 1]); });
  const g = grids(t.read()).get(s.id)!;
  assert.deepEqual(g.slice(1).map((r) => r.slice(0, 2)), [['1', '10'], ['2', '20'], ['3', '30']]);
  // Each balance still adds the row above it (the first one now reads the header: as it would in Excel).
  assert.deepEqual(g.slice(1).map((r) => r[2]), ['=C1+B2', '=C2+B3', '=B4']);
  assert.deepEqual(g.slice(1).map((r) => r[3]), ['=B2/E1', '=B3/$E$1', '=B4/$E$1']);
});

test('a range that loses its last or first row keeps the rest; one that goes entirely reads #REF!', () => {
  const t = book([['n'], ['1'], ['2'], ['3'], ['=SUM(A2:A4)', '=A2', '=SUM(A2:A3)']]);
  t.doc.transact(() => { deleteRows(t.doc, t.read(), t.first(), 3, 1); });
  assert.equal(t.at('A4'), '=SUM(A2:A3)');
  t.doc.transact(() => { deleteRows(t.doc, t.read(), t.first(), 1, 1); });
  assert.equal(t.at('A3'), '=SUM(A2:A2)');
  assert.equal(t.at('B3'), '=#REF!');
  assert.equal(t.value('A3'), '2');
  t.doc.transact(() => { deleteRows(t.doc, t.read(), t.first(), 1, 1); });
  assert.equal(t.at('A2'), '=SUM(#REF!)');
  const c = book([['1', '2', '3', '=SUM(A1:C1)']]);
  c.doc.transact(() => { deleteCols(c.doc, c.read(), c.first(), 2, 1); });
  assert.equal(c.at('C1'), '=SUM(A1:B1)');
});

test('a reference past the end of the sheet grows the sheet a little, or stays an address', () => {
  const t = book();
  assert.equal(t.first().rows.length, 100);
  t.put('A1', '=SUM(B1:B300)');
  assert.equal(t.first().rows.length, 300);
  assert.ok(!stored(t.read(), t.first(), 0, 0).includes('B300'));
  t.put('A2', '=SUM(B1:B90000)');
  assert.equal(t.first().rows.length, 300);
  assert.equal(t.at('A2'), '=SUM(B1:B90000)');
});

test('copying a formula elsewhere shifts what is not pinned with $', () => {
  assert.equal(shiftFormula('=A1+$B$2+C$3+$D4+SUM(A:A)+Other!E5', 2, 1), '=B3+$B$2+D$3+$D6+SUM(B:B)+Other!F7');
  assert.equal(shiftFormula('=A1', -1, 0), '=#REF!');
  assert.equal(shiftFormula('plain A1', 3, 3), 'plain A1');
});

test('two people at once: one cell keeps one value, never a mixture', () => {
  const t = pair([['item', 'amount'], ['rent', '100']]);
  t.doc.transact(() => { setInput(t.doc, t.read(), t.first(), 1, 1, '150'); });
  t.doc2.transact(() => { const b = t.read2(); setInput(t.doc2, b, b.sheets[0], 1, 1, '250'); });
  const text = t.both();
  assert.ok(/rent\t(150|250)$/m.test(text), text);
});

test('two people at once: a row inserted above does not move what the other is typing or what their formula means', () => {
  const t = pair([['a', '1'], ['b', '2'], ['c', '3']]);
  t.doc.transact(() => { insertRows(t.doc, t.first(), 1, 1); setInput(t.doc, t.read(), t.read().sheets[0], 1, 0, 'new'); });
  t.doc2.transact(() => { const b = t.read2(); setInput(t.doc2, b, b.sheets[0], 2, 1, '30'); setInput(t.doc2, b, b.sheets[0], 0, 2, '=B3*2'); });
  t.both();
  const b = t.read(), s = b.sheets[0];
  assert.deepEqual(grids(b).get(s.id)!.slice(0, 4), [['a', '1', '=B4*2'], ['new'], ['b', '2'], ['c', '30']]);
  const calc = new Calc(b);
  assert.equal(calc.shown(s, 0, 2).text, '60');
  calc.destroy();
});

test('two people at once: both append a row at the bottom and both rows stay; a row can then go between them', () => {
  const t = pair([['a'], ['b']]);
  const add = (doc: Y.Doc, text: string) => doc.transact(() => { const s = readBook(liveStore(doc)).sheets[0]; const [id] = insertRows(doc, s, 2, 1); doc.getMap('cells').set(`${s.id}:${id}:${s.cols[0]}`, text); });
  add(t.doc, 'mine'); add(t.doc2, 'theirs');
  t.both();
  const col = () => grids(t.read()).get(t.first().id)!.map((r) => r[0]);
  assert.deepEqual(col().slice(0, 2), ['a', 'b']);
  assert.deepEqual(col().slice(2, 4).sort(), ['mine', 'theirs']);
  const was = col().slice(2, 4);
  t.doc.transact(() => { insertRows(t.doc, t.first(), 3, 1); });
  t.put('A4', 'between');
  assert.deepEqual(col().slice(2, 5), [was[0], 'between', was[1]]);
  t.both();
});

test('two people at once: one sorts while the other edits a cell; a row deleted by one and edited by the other is gone', () => {
  const t = pair([['c', '3'], ['a', '1'], ['b', '2']]);
  t.doc.transact(() => { reorderRows(t.doc, t.read(), t.first(), 0, [1, 2, 0]); });
  t.doc2.transact(() => { const b = t.read2(); setInput(t.doc2, b, b.sheets[0], 0, 1, '33'); });
  t.both();
  assert.deepEqual(grids(t.read()).get(t.first().id)!.slice(0, 3), [['a', '1'], ['b', '2'], ['c', '33']]);
  t.doc.transact(() => { deleteRows(t.doc, t.read(), t.first(), 0, 1); });
  t.doc2.transact(() => { const b = t.read2(); setInput(t.doc2, b, b.sheets[0], 0, 1, 'late'); });
  t.both();
  assert.deepEqual(grids(t.read()).get(t.first().id)!.slice(0, 2), [['b', '2'], ['c', '33']]);
});

test('sheets: formulas across sheets follow a rename; a removed sheet leaves #REF!', () => {
  const t = book([['10'], ['20']]);
  t.doc.transact(() => { addSheet(t.doc, t.read(), 'Summary'); });
  t.put('Summary!A1', '=SUM(Sheet1!A1:A2)');
  assert.equal(t.value('Summary!A1'), '30');
  t.doc.transact(() => { const b = t.read(); renameSheet(t.doc, b, b.sheets[0], 'Ledger 2026'); });
  assert.equal(t.at('Summary!A1'), "=SUM('Ledger 2026'!A1:A2)");
  assert.equal(t.value('Summary!A1'), '30');
  assert.throws(() => t.doc.transact(() => { const b = t.read(); renameSheet(t.doc, b, b.sheets[1], 'ledger 2026'); }), /already a sheet/);
  assert.equal(bookText(t.read()), '## Ledger 2026\n10\n20\n\n## Summary\n=SUM(\'Ledger 2026\'!A1:A2)');
});

test('values: numbers, dates, percentages, money, text, errors; formats', () => {
  const t = book([['2026-03-04', '=A1+30', '12.5%', '$1200', "'007", '=1/0', '=A1>0', '3/4/2026', '04.03.2026', '=B1-I1'], ['1234.5', '=A2', '=SUM(A2:B2)', '=NOPE(1)']]);
  const b = t.read(), s = b.sheets[0];
  const calc = new Calc(b);
  const row = (r: number, n: number) => Array.from({ length: n }, (_, c) => calc.shown(s, r, c));
  assert.deepEqual(row(0, 10).map((x) => x.text), ['2026-03-04', '2026-04-03', '12.5%', '$1,200.00', '007', '#DIV/0!', 'TRUE', '3/4/2026', '2026-03-04', '30']);
  assert.deepEqual(row(0, 7).map((x) => x.kind), ['number', 'number', 'number', 'number', 'text', 'error', 'bool']);
  assert.deepEqual(row(1, 4).map((x) => x.text), ['1234.5', '1234.5', '2469', '#NAME?']);
  t.doc.transact(() => { setFormat(t.doc, s, { top: 0, left: 0, bottom: 99, right: 0 }, '#,##0.00'); setFormat(t.doc, s, { top: 1, left: 1, bottom: 1, right: 1 }, '€#,##0.00'); });
  const calc2 = new Calc(t.read());
  assert.equal(calc2.shown(s, 1, 0).text, '1,234.50');
  assert.equal(calc2.shown(s, 1, 1).text, '€1,234.50');
  calc.destroy(); calc2.destroy();
  const noDate = () => ({ year: 2026, month: 3, day: 4, hours: 15, minutes: 7, seconds: 9 });
  assert.equal(formatNumber(-1234.567, '#,##0.00', noDate), '-1,234.57');
  assert.equal(formatNumber(0.125, '0%', noDate), '13%');
  assert.equal(formatNumber(-0.001, '0.00', noDate), '0.00');
  assert.equal(formatNumber(1, 'yyyy-mm-dd hh:mm', noDate), '2026-03-04 15:07');
  assert.equal(formatNumber(1, 'dd/mm/yy', noDate), '04/03/26');
});

test('the calculator follows cell writes without being rebuilt', () => {
  const t = book([['1', '=A1*2'], ['=SUM(B1:B1)']]);
  const calc = new Calc(t.read());
  const s = t.first();
  t.put('A1', '21');
  calc.update(t.read(), [{ sheet: s, row: 0, col: 0 }]);
  assert.equal(calc.shown(s, 1, 0).text, '42');
  t.put('A1', '');
  calc.update(t.read(), [{ sheet: s, row: 0, col: 0 }]);
  assert.equal(calc.shown(s, 1, 0).text, '0');
  calc.destroy();
});

test('changes between two states are told in a spreadsheet’s terms; a restore brings the earlier state back', () => {
  const t = book([['item', 'n'], ['a', '1'], ['b', '2'], ['total', '=SUM(B2:B3)']]);
  const snap = Y.snapshot(t.doc);
  const at = (s: Y.Snapshot) => sheetStoreAt(t.doc, s);
  const textBefore = bookText(t.read());
  assert.equal(bookText(readBook(at(snap))), textBefore);
  t.doc.transact(() => { insertRows(t.doc, t.first(), 1, 1); });
  t.put('A2', 'z'); t.put('B2', '26'); t.put('B3', '5');
  t.doc.transact(() => { deleteCols(t.doc, t.read(), t.first(), 5, 1); addSheet(t.doc, t.read(), 'Notes'); });
  const c = bookChanges(at(snap), liveStore(t.doc));
  assert.deepEqual(c.notes, ['Sheet1: row 2 added.', 'Sheet1: column F (as lettered before) removed.', 'Sheet “Notes” was added.']);
  // The total's formula is not listed: it still points at the same cells.
  assert.deepEqual(c.cells.map((x) => `${x.where}: ${x.before} -> ${x.after}`), ['Sheet1!A2:  -> z', 'Sheet1!B2:  -> 26', 'Sheet1!B3: 1 -> 5']);
  t.doc.transact(() => { restoreStore(t.doc, at(snap)); });
  assert.equal(bookText(t.read()), textBefore);
  assert.equal(t.read().sheets.length, 1);
});

test('a cell written many times by one person still reads right at every earlier moment', () => {
  const t = book([['x']]);
  const snaps: [Y.Snapshot, string][] = [];
  for (const v of ['one', 'two', 'three', '', 'four']) { t.put('A1', v); snaps.push([Y.snapshot(t.doc), v]); }
  t.put('A1', 'five'); t.put('A1', '');
  for (const [snap, v] of snaps) assert.equal(bookText(readBook(sheetStoreAt(t.doc, snap))), `## Sheet1${v ? `\n${v}` : ''}`);
  // The same after the document has been stored and loaded again.
  const again = new Y.Doc({ gc: false });
  Y.applyUpdate(again, Y.encodeStateAsUpdate(t.doc));
  for (const [snap, v] of snaps) assert.equal(bookText(readBook(sheetStoreAt(again, snap))), `## Sheet1${v ? `\n${v}` : ''}`);
});

test('clipboard text: tabs and lines, quoted cells holding either', () => {
  assert.deepEqual(parseTsv('a\tb\n1\t2\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseTsv('a\t"two\nlines"\t"say ""hi"""\r\n\t\tz'), [['a', 'two\nlines', 'say "hi"'], ['', '', 'z']]);
  assert.deepEqual(parseTsv('"unclosed\tx'), [['"unclosed', 'x']]);
  assert.deepEqual(parseTsv('5" nails\tok'), [['5" nails', 'ok']]);
  const rows = [['a', 'two\nlines', 'tab\there', 'q"uote'], ['', '1', '', '']];
  assert.deepEqual(parseTsv(toTsv(rows)), rows);
});
