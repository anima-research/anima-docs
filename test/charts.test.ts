import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { chartOption, chartText, parseChart, tableOf } from '../src/chart.js';
import { chartSvg } from '../src/chartsvg.js';
import { TOOLS } from '../src/tools.js';
import { startServer } from './server-harness.js';

const BLOCK = 'type: line\ntitle: Spending\nx: month\ny: rent, food\nstacked: yes\nheight: 400\n\nmonth, rent, food\nJan, 1200, 310\nFeb, "1,250", 280.5\nMar, 1250,\n';

test('a chart block: settings, then rows; back to text; the ranges a document draws from', () => {
  const spec = parseChart(BLOCK);
  assert.deepEqual({ type: spec.type, title: spec.title, x: spec.x, y: spec.y, stacked: spec.stacked, height: spec.height }, { type: 'line', title: 'Spending', x: 'month', y: ['rent', 'food'], stacked: true, height: 400 });
  assert.deepEqual(tableOf(spec.rows), { columns: ['month', 'rent', 'food'], rows: [['Jan', 1200, 310], ['Feb', 1250, 280.5], ['Mar', 1250, null]] });
  assert.deepEqual(parseChart(chartText(spec)), spec);
  const code = parseChart('type: code\ndata: https://docs.example/d/dAbc12345?x=1 Ledger!A1:C9\n\nconst x = 1;\nreturn { title: "a: b" };\n');
  assert.deepEqual([code.type, code.source, code.code], ['code', { doc: 'dAbc12345', range: 'Ledger!A1:C9' }, 'const x = 1;\nreturn { title: "a: b" };\n']);
});

test('what is drawn: series in a fixed order of colours, a legend for two or more, and reasons when it cannot be', () => {
  const table = tableOf(parseChart(BLOCK).rows);
  const line = chartOption(parseChart(BLOCK), table, 'light') as { option: any; note: string };
  assert.deepEqual(line.option.series.map((s: any) => [s.type, s.name, s.stack, s.data]), [['line', 'rent', 'all', [1200, 1250, 1250]], ['line', 'food', 'all', [310, 280.5, null]]]);
  assert.deepEqual(line.option.color.slice(0, 2), ['#2a78d6', '#eb6834']);
  assert.ok(line.option.legend && line.option.xAxis.type === 'category' && line.option.yAxis.type === 'value');
  const one = chartOption(parseChart('type: bar\nhorizontal: yes\n\nitem, n\na, 1\nb, 2'), tableOf([['item', 'n'], ['a', 1], ['b', 2]]), 'dark') as { option: any };
  assert.equal(one.option.legend, undefined, 'one series: the title names it');
  assert.equal(one.option.yAxis.type, 'category');
  assert.equal(one.option.color[0], '#3987e5');
  // More series than there are colours: the rest are named, not given made-up colours.
  const wide = tableOf([['x', ...Array.from({ length: 10 }, (_, i) => `s${i + 1}`)], ['a', ...Array.from({ length: 10 }, (_, i) => i)]]);
  const capped = chartOption(parseChart('type: bar'), wide, 'light') as { option: any; note: string };
  assert.equal(capped.option.series.length, 8);
  assert.match(capped.note, /Showing 8 of 10 series: s9, s10 left out/);
  // A pie of many slices folds the small ones together.
  const pie = chartOption(parseChart('type: pie'), tableOf([['k', 'v'], ...Array.from({ length: 12 }, (_, i) => [`k${i}`, i + 1] as [string, number])]), 'light') as { option: any };
  assert.equal(pie.option.series[0].data.length, 8);
  assert.deepEqual(pie.option.series[0].data.at(-1), { name: 'Other (5)', value: 15 });
  assert.match((chartOption(parseChart('type: bar\ny: nope'), table, 'light') as { error: string }).error, /No column “nope”\. Columns: month, rent, food/);
  assert.match((chartOption(parseChart('type: bar'), tableOf([]), 'light') as { error: string }).error, /no data to draw yet/);
  assert.match((chartOption(parseChart('type: scatter'), table, 'light') as { error: string }).error, /needs numbers in its x column/);
});

test('the server draws a chart without a browser; a chart that is code is not run there', () => {
  const svg = chartSvg(parseChart(BLOCK), tableOf(parseChart(BLOCK).rows), { background: true });
  assert.match(svg, /^<svg[^>]* width="720" height="400"/);
  assert.ok(svg.includes('Spending') && svg.includes('#2a78d6') && !/<script/i.test(svg));
  // What a picture leaves out, it says in the picture (nothing else on a published page or in Excel could).
  const nine = tableOf([['x', ...Array.from({ length: 9 }, (_, i) => `s${i + 1}`)], ['a', ...Array.from({ length: 9 }, (_, i) => i)]]);
  assert.ok(chartSvg(parseChart('type: bar'), nine).includes('Showing 8 of 9 series: s9 left out.'));
  const code = chartSvg(parseChart('type: code\ntitle: <b>Mine</b>\n\nthrow new Error("ran")'), { columns: [], rows: [] });
  assert.ok(code.includes('drawn by code') && code.includes('&lt;b&gt;Mine&lt;/b&gt;') && !code.includes('<b>'));
});

test('a chart in a document draws from a spreadsheet for every reader, if whoever wrote it could open the spreadsheet', async () => {
  const S = await startServer();
  try {
    const admit = (name: string) => S.app.principals.admit({ sub: `human:test:${name.toLowerCase()}`, name, kind: 'human', issuer: 'test.local', scopes: [], claims: {}, exp: Date.now() / 1000 + 3600 }, 'web');
    const ann = admit('Ann'), bob = admit('Bob'), eve = admit('Eve');
    const sheet = S.app.docs.create(ann, 'Ledger', 'month,rent,food\nJan,1200,310\nFeb,1250,280.5', 'sheet');
    const secret = S.app.docs.create(ann, 'Salaries', 'who,pay\nAnn,9000', 'sheet');
    const note = S.app.docs.create(ann, 'Report', '# Report\n');
    S.app.docs.share(note.id, ann, bob.sub, 'editor');
    S.app.docs.share(note.id, ann, eve.sub, 'viewer');
    const type = (who: { sub: string }, text: string) => S.app.docs.edit(note.id, { sub: who.sub, via: 'web' }, (t) => t.insert(t.length, text));
    type(ann, `\n\`\`\`chart\ntype: bar\ndata: ${sheet.id} Sheet1!A1:C3\n\`\`\`\n`);
    // Bob and Eve cannot open the spreadsheet; they read the document, so they see the charted range, and only it.
    assert.equal(S.app.docs.role(sheet.id, eve), null);
    assert.deepEqual(S.app.charts.data(note.id, eve, { doc: sheet.id, range: 'Sheet1!A1:C3' }), { columns: ['month', 'rent', 'food'], rows: [['Jan', 1200, 310], ['Feb', 1250, 280.5]] });
    assert.throws(() => S.app.charts.data(note.id, eve, { doc: sheet.id, range: 'Sheet1!A1:C9' }), /not available/);
    // Bob writes a reference to a spreadsheet he cannot open: it does not count for anyone, Ann included, since a chart
    // (it may be Bob's code) is given what the document was granted and never what its reader could open.
    type(bob, `\n\`\`\`chart\ntype: code\ndata: ${secret.id} A1:B2\n\nreturn {};\n\`\`\`\n`);
    for (const who of [bob, eve, ann]) assert.throws(() => S.app.charts.data(note.id, who, { doc: secret.id, range: 'A1:B2' }), /not available/);
    // Ann edits elsewhere in the document: Bob's reference stays Bob's, and stays refused.
    S.app.docs.edit(note.id, { sub: ann.sub, via: 'web' }, (t) => t.insert(0, 'A note from Ann.\n\n'));
    for (const who of [bob, eve, ann]) assert.throws(() => S.app.charts.data(note.id, who, { doc: secret.id, range: 'A1:B2' }), /not available/);
    assert.ok(!S.app.wiki.render(S.app.docs.text(note.id), { base: '', pages: [], nodes: [note.id] }).includes(Buffer.from(JSON.stringify(9000)).toString('base64url')));
    // An example of a chart block inside a longer fence is text, not a chart: it opens nothing.
    type(ann, `\n\`\`\`\`\nAn example:\n\`\`\`chart\ndata: ${secret.id} A1:B1\n\`\`\`\n\`\`\`\`\n`);
    assert.throws(() => S.app.charts.data(note.id, ann, { doc: secret.id, range: 'A1:B1' }), /not available/);
    // Someone with no access to the document gets nothing through it.
    assert.throws(() => S.app.charts.data(note.id, admit('Mallory'), { doc: sheet.id, range: 'Sheet1!A1:C3' }), /No document|not/i);
    // The reference removed: the range is no longer open through the document; put back by Bob, it does not come back.
    S.app.docs.edit(note.id, { sub: ann.sub, via: 'web' }, (t) => { const s = t.toString(), i = s.indexOf('```chart'); t.delete(i, s.indexOf('```\n', i + 3) + 4 - i); });
    assert.throws(() => S.app.charts.data(note.id, eve, { doc: sheet.id, range: 'Sheet1!A1:C3' }), /not available/);
    type(bob, `\n\`\`\`chart\ndata: ${sheet.id} Sheet1!A1:C3\n\`\`\`\n`);
    assert.throws(() => S.app.charts.data(note.id, eve, { doc: sheet.id, range: 'Sheet1!A1:C3' }), /not available/);
    // A grant is for the sheet the words meant when they were written: the same words meaning another sheet open nothing.
    type(ann, `\n\`\`\`chart\ndata: ${sheet.id} A1\n\`\`\`\n\n\`\`\`chart\ndata: ${sheet.id} Sheet1!A1:B2\n\`\`\`\n`);
    assert.deepEqual(S.app.charts.data(note.id, eve, { doc: sheet.id, range: 'A1' }).columns, ['month']);
    assert.deepEqual(S.app.charts.data(note.id, eve, { doc: sheet.id, range: 'Sheet1!A1:B2' }).rows, [['Jan', 1200]]);
    S.app.sheets.apply(sheet.id, ann, [{ rename_sheet: 'Sheet1', to: 'Zed' }, { add_sheet: 'A1' }, { add_sheet: 'Sheet1' }, { set: 'A1!A1', values: [['secret', 'pay'], ['Ann', 9000]] }, { set: 'Sheet1!A1', values: [['secret', 'pay'], ['Ann', 9000]] }]);
    assert.throws(() => S.app.charts.data(note.id, eve, { doc: sheet.id, range: 'A1' }), /not available/, '"A1" now reads as the sheet named A1');
    assert.throws(() => S.app.charts.data(note.id, eve, { doc: sheet.id, range: 'Sheet1!A1:B2' }), /not available/, '"Sheet1" is another sheet now');
    S.app.sheets.apply(sheet.id, ann, [{ delete_sheet: 'A1' }, { delete_sheet: 'Sheet1' }, { rename_sheet: 'Zed', to: 'Sheet1' }]);
    assert.deepEqual(S.app.charts.data(note.id, eve, { doc: sheet.id, range: 'Sheet1!A1:B2' }).rows, [['Jan', 1200]]);
    type(ann, `\n\`\`\`chart\ntype: line\ndata: ${sheet.id} Sheet1!A1:C3\n\`\`\`\n\n\`\`\`chart\ntype: code\ntitle: Mine\ndata: ${sheet.id} Sheet1!A1:C3\n\nreturn {};\n\`\`\`\n`);
    // Over HTTP, and the frame that runs code.
    const frame = await fetch(`${S.base}/chart-frame`);
    assert.equal(frame.status, 200);
    const csp = frame.headers.get('content-security-policy') ?? '';
    assert.match(csp, /sandbox allow-scripts;/);
    assert.match(csp, /default-src 'none'/);
    assert.ok(!/connect-src|allow-same-origin|allow-popups|allow-forms|allow-top-navigation/.test(csp), 'no requests, no origin of the app, no way out by a form, a popup or the top page');
    assert.equal(frame.headers.get('x-frame-options'), null);
    // A published page carries the chart as a picture, and the code chart as a sandboxed frame with its data.
    const html = S.app.wiki.render(S.app.docs.text(note.id), { base: '', pages: [], nodes: [note.id] });
    assert.match(html, /<img class="md-chart-img" alt="Chart"[^>]* src="data:image\/svg\+xml;base64,/);
    assert.ok(!html.includes('data-chart-slot'), 'every marked place was filled');
    const frames = [...html.matchAll(/<iframe class="md-chart-frame" sandbox="allow-scripts"[^>]* src="([^"#]+)#([^"]+)"/g)];
    const m = frames.at(-1)!;
    assert.ok(m[1].endsWith('/chart-frame'));
    const payload = JSON.parse(Buffer.from(m[2], 'base64url').toString());
    assert.deepEqual(payload.table.rows, [['Jan', 1200, 310], ['Feb', 1250, 280.5]]);
    assert.match(payload.text, /return \{\};/);
    // The same page made of other documents has no right to the range: a picture saying so, and no data in the frame.
    const other = S.app.wiki.render(S.app.docs.text(note.id), { base: '', pages: [], nodes: ['dOther123'] });
    assert.ok(!other.includes('md-chart-frame'));
    assert.match(Buffer.from(/base64,([^"]+)"/.exec(other)![1], 'base64').toString(), /was not open to whoever wrote its data line/);
    // A place for a chart written by hand into a page is not one.
    assert.ok(S.app.wiki.render('<span data-chart-slot="0"></span>\n\n```chart\ntype: bar\n\na, b\nx, 1\n```\n', { base: '', pages: [] }).match(/md-chart-img/g)!.length === 1);
  } finally { await S.close(); }
});

test('charts on a sheet: placed, changed and removed by agents; they follow their cells; they go into the Excel file as pictures', async () => {
  const S = await startServer();
  try {
    const ann = S.app.principals.admit({ sub: 'human:test:ann', name: 'Ann', kind: 'human', issuer: 'test.local', scopes: [], claims: {}, exp: Date.now() / 1000 + 3600 }, 'web');
    const tool = async (name: string, args: Record<string, unknown>) => ((await TOOLS.find((t) => t.name === name)!.run(S.app, ann as any, args)) as any).content[0].text as string;
    const d = S.app.docs.create(ann, 'Ledger', 'month,rent,food\nJan,1200,310\nFeb,1250,280.5\nMar,1250,345', 'sheet');
    const before = S.app.docs.saveVersion(d.id, ann, 'before charts');
    const placed = await tool('edit_sheet', { document: d.id, changes: [{ chart: 'A1:C4', type: 'bar', title: 'Spending', stacked: true, at: 'E2' }, { chart: 'A1:B4', code: 'return { series: [] };' }] });
    const [id1, id2] = [...placed.matchAll(/chart (\w{5}) /g)].map((m) => m[1]);
    assert.match(placed, /Placed chart \w{5} \(bar\) of A1:C4\.\nPlaced chart \w{5} \(code\) of A1:B4\. Its code runs in each reader’s browser/);
    assert.match(await tool('read_document', { document: d.id }), new RegExp(`Charts on Sheet1: ${id2} \\(code of A1:B4, at D1\\); ${id1} \\(bar “Spending” of A1:C4, at E2\\)`));
    // A row put in above: the chart's cells and its place move with the rows.
    await tool('edit_sheet', { document: d.id, changes: [{ insert_rows: 1 }, { chart: 'A2:C5', id: id1, type: 'line', title: 'Spending by month' }] });
    assert.match(await tool('read_document', { document: d.id }), new RegExp(`${id2} \\(code of A2:B5, at D2\\); ${id1} \\(line “Spending by month” of A2:C5, at E3\\)`));
    // A change to a chart keeps what it does not name: the code chart given a title is still its code.
    await tool('edit_sheet', { document: d.id, changes: [{ chart: 'A2:B5', id: id2, title: 'Mine' }] });
    assert.match(await tool('read_document', { document: d.id }), new RegExp(`${id2} \\(code “Mine” of A2:B5`));
    assert.match(S.app.sheets.book(d.id) && JSON.stringify([...S.app.docs.ydoc(d.id).getMap('charts').values()]), /return \{ series: \[\] \};/);
    // A sort leaves a chart covering the same area; its last row deleted, it draws the rest; the row it sits on deleted, it sits on the next.
    await tool('edit_sheet', { document: d.id, changes: [{ sort: 'A3:C5', by: 'B', descending: true }] });
    assert.match(await tool('read_document', { document: d.id }), new RegExp(`${id1} \\(line “Spending by month” of A2:C5, at E3\\)`));
    await tool('edit_sheet', { document: d.id, changes: [{ delete_rows: 5 }, { delete_rows: 3 }] });
    assert.match(await tool('read_document', { document: d.id }), new RegExp(`${id2} \\(code “Mine” of A2:B3, at D2\\); ${id1} \\(line “Spending by month” of A2:C3, at E3\\)`));
    await assert.rejects(tool('edit_sheet', { document: d.id, changes: [{ chart: 'A1:C4', type: 'donut' }] }), /type is one of bar, line, area, pie, scatter, code/);
    await assert.rejects(tool('edit_sheet', { document: d.id, changes: [{ chart: 'A1:C4', code: '"\\'.repeat(9000) }] }), /too long/);
    // Something that is not a chart, written where charts are kept, is passed over.
    S.app.docs.editSheet(d.id, ann, (doc) => { doc.getMap('charts').set(`${S.app.sheets.book(d.id).sheets[0].id}:junk1`, 'null'); });
    assert.match(await tool('read_document', { document: d.id }), /Charts on Sheet1: /);
    await assert.rejects(tool('edit_sheet', { document: d.id, changes: [{ delete_chart: 'nope' }] }), /No chart “nope”/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await S.app.sheets.xlsx(d.id)) as any);
    const images = wb.getWorksheet('Sheet1')!.getImages();
    assert.equal(images.length, 2, 'the declarative chart is a picture; the code chart is a picture saying it is code');
    assert.deepEqual(images.map((i) => [i.range.tl.nativeCol, i.range.tl.nativeRow]).sort(), [[3, 1], [4, 2]]);
    assert.match(await tool('edit_sheet', { document: d.id, changes: [{ delete_chart: 'Spending by month' }] }), new RegExp(`Removed chart ${id1}`));
    assert.match(await tool('changes', { document: d.id, since_version: before.id }), /Sheet1: charts changed\./);
  } finally { await S.close(); }
});
