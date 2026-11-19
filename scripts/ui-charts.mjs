#!/usr/bin/env node
// Charts in a real headless browser.
//
// Starts the server on a fresh data directory (dev issuer), then: Alice puts a
// chart in a document (Insert ▸ Chart), sees it under its block and in the
// preview, points it at a range of a spreadsheet, and writes one as code; Bob,
// who can read the document but not the spreadsheet, sees the charts; the code
// runs in a frame that reaches neither the network nor the page; Alice places
// a chart on a sheet, changes a cell and sees it follow, and changes its kind.
// Screenshots go to SMOKE_SHOTS.
//
//   npm run build:web && node scripts/ui-charts.mjs
//   env: SMOKE_PORT (7370), SMOKE_SHOTS ($TMPDIR/anima-docs-charts-shots), SMOKE_HEADED=1

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT ?? 7370);
const ORIGIN = `http://localhost:${PORT}`;
const SHOTS = process.env.SMOKE_SHOTS ?? join(tmpdir(), 'anima-docs-charts-shots');
const DATA = mkdtempSync(join(tmpdir(), 'docs-charts-'));
mkdirSync(SHOTS, { recursive: true });

const results = [];
let failed = false;
async function step(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push(`  ✓ ${name} (${Date.now() - t0} ms)`); console.log(`✓ ${name}`); }
  catch (e) { failed = true; results.push(`  ✗ ${name}: ${e.message.split('\n')[0]}`); console.error(`✗ ${name}\n${e.stack ?? e}`); throw e; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const eq = (got, want, what) => assert(JSON.stringify(got) === JSON.stringify(want), `${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
async function until(fn, what, ms = 5000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(50); }
}

async function startServer() {
  if (await fetch(`${ORIGIN}/health`).then(() => true, () => false)) throw new Error(`Something is already listening on port ${PORT}; stop it or set SMOKE_PORT.`);
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: root, env: { ...process.env, PORT: String(PORT), DOCS_ORIGIN: ORIGIN, DOCS_DATA_DIR: DATA, DOCS_DEV_ISSUER: 'dev.local', DOCS_ISSUERS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(`server exited:\n${log}`);
    try { if ((await fetch(`${ORIGIN}/health`)).ok) return { proc, log: () => log }; } catch { /* not yet */ }
    await sleep(150);
  }
  proc.kill();
  throw new Error(`server did not start:\n${log}`);
}

const consoleErrors = [];
function watch(page, who) {
  page.on('pageerror', (e) => consoleErrors.push(`[${who}] pageerror: ${e.message}`));
  // The code chart of this test tries the network on purpose: the frame's policy refusing it is the point.
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|Content Security Policy/.test(m.text())) consoleErrors.push(`[${who}] console: ${m.text()}`); });
}
async function signIn(page, name) {
  await page.goto(`${ORIGIN}/`);
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('main.home h1', { hasText: 'Documents' }).waitFor();
}

// ---- working the grid
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
/** What a cell shows ('' when empty or out of view). */
const cell = (page, at) => page.evaluate((a) => document.querySelector(`.sheet-cells .sc[data-at="${a}"]`)?.textContent ?? '', at);
const cells = (page, list) => Promise.all(list.map((a) => cell(page, a)));
/** Wait until these cells show these values (the grid paints on the next frame). */
async function see(page, list, want, what) {
  let got;
  try { await until(async () => { got = await cells(page, list); return JSON.stringify(got) === JSON.stringify(want); }, what, 3000); }
  catch { throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
/** Click a cell by its address (it must be in view). */
async function click(page, at, opts = {}) {
  const m = /^([A-Z]+)(\d+)$/.exec(at);
  const pos = await page.evaluate(([letters, row]) => {
    const heads = [...document.querySelectorAll('.sheet-ch')];
    const hd = heads.find((h) => h.firstChild?.textContent === letters);
    const sc = document.querySelector('.sheet-scroll').getBoundingClientRect();
    if (!hd) return null;
    const b = hd.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: sc.top + 25 + (row - 1) * 25 + 12 - document.querySelector('.sheet-scroll').scrollTop };
  }, [m[1], Number(m[2])]);
  assert(pos, `column ${m[1]} is not in view`);
  const { modifiers = [], ...rest } = opts;
  for (const k of modifiers) await page.keyboard.down(k);
  await page.mouse.click(pos.x, pos.y, rest);
  for (const k of modifiers) await page.keyboard.up(k);
}
/** Type into the selected cell and move on with Enter (or Tab). */
async function type(page, text, key = 'Enter') { await page.keyboard.type(text); await page.keyboard.press(key); }
const fx = (page) => page.locator('.sheet-fx').inputValue();
const nameBox = (page) => page.locator('.sheet-name').textContent();
/** Put text on the clipboard of the grid, as a paste from another program would. */
const paste = (page, text) => page.evaluate((t) => { const dt = new DataTransfer(); dt.setData('text/plain', t); document.querySelector('.sheet-sink').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, text);
/** Copy the selection; returns what went to the clipboard. */
const copy = (page) => page.evaluate(() => { const dt = new DataTransfer(); document.querySelector('.sheet-sink').dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true })); return dt.getData('text/plain'); });
/** Close the page's socket to the server (the browser context is offline, so it cannot come back yet) and wait for the page to say so. */
const cut = async (page) => { await page.evaluate(() => window.__cutSockets()); await until(() => page.evaluate(() => window.__socketsOpen() === 0), 'the page to be cut off'); };
const menu = async (page, at, item, where = 'cell') => {
  if (where === 'cell') await click(page, at, { button: 'right' });
  else {
    const pos = await page.evaluate(([w, a]) => {
      const sc = document.querySelector('.sheet-scroll'), b = sc.getBoundingClientRect();
      if (w === 'row') return { x: b.left + 20, y: b.top + 25 + (Number(a) - 1) * 25 + 12 - sc.scrollTop };
      const hd = [...document.querySelectorAll('.sheet-ch')].find((h) => h.firstChild?.textContent === a).getBoundingClientRect();
      return { x: hd.left + hd.width / 2, y: b.top + 12 };
    }, [where, at]);
    await page.mouse.click(pos.x, pos.y, { button: 'right' });
  }
  await page.getByRole('menuitem', { name: item }).click();
};

const server = await startServer();
const browser = await chromium.launch({ headless: !process.env.SMOKE_HEADED });
const viewport = { width: 1360, height: 900 };
const aliceCtx = await browser.newContext({ viewport, colorScheme: 'light' });
const bobCtx = await browser.newContext({ viewport, colorScheme: 'dark' });
const alice = await aliceCtx.newPage();
const bob = await bobCtx.newPage();
watch(alice, 'alice'); watch(bob, 'bob');
const api = (page, method, path, body) => page.evaluate(([m, p, b]) => fetch(p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) })), [method, path, body]);
/** What a chart drawn in the page shows: the text of its SVG. */
const drawn = (page, sel) => page.locator(`${sel}:visible svg`).first().evaluate((s) => s.textContent, null, { timeout: 2000 }).catch(() => '');
let docId = '', sheetId = '';

try {
  await step('Insert ▸ Chart puts a chart block in a document; it is drawn under the block and in the preview', async () => {
    await signIn(bob, 'Bob Rivera');
    await signIn(alice, 'Alice Chen');
    sheetId = (await api(alice, 'POST', '/api/docs', { title: 'Ledger', type: 'sheet', content: 'month,rent,food\nJan,1200,310\nFeb,1250,280.5\nMar,1250,345' })).json.id;
    docId = (await api(alice, 'POST', '/api/docs', { title: 'Quarterly report', content: '# Quarterly report\n\nWhat we spent.\n\n' })).json.id;
    await alice.goto(`${ORIGIN}/d/${docId}`);
    await alice.locator('.cm-content').click();
    await alice.keyboard.press(`${MOD}+End`);
    await alice.getByRole('button', { name: 'Insert', exact: true }).click();
    await alice.getByRole('menuitem', { name: /^Chart/ }).click();
    await alice.locator('.cm-chart svg').waitFor();
    const text = await drawn(alice, '.cm-chart');
    assert(text.includes('Title') && text.includes('First') && text.includes('Second'), `the chart under the block: ${text}`);
    await shot(alice, '01-inserted-chart');
    await alice.getByRole('button', { name: 'Preview', exact: true }).click().catch(() => alice.getByRole('radio', { name: 'Preview' }).click());
    await alice.locator('.preview-body .md-chart svg, .preview-pane .md-chart svg').first().waitFor();
    await shot(alice, '02-preview');
  });

  await step('a chart draws from a spreadsheet range; a reader of the document sees it without access to the spreadsheet', async () => {
    const text = `# Quarterly report\n\nWhat we spent.\n\n\`\`\`chart\ntype: bar\ntitle: Spending by month\nstacked: yes\ndata: ${sheetId} Sheet1!A1:C4\n\`\`\`\n\n\`\`\`chart\ntype: pie\ntitle: Rent share\n\nwho, amount\nRent, 3700\nFood, 935.5\n\`\`\`\n`;
    const r = await api(alice, 'POST', `/api/operations/edit_document`, { document: docId, edits: [{ replace_all_content: text }] });
    assert(r.status === 200, `edit: ${JSON.stringify(r)}`);
    await until(async () => (await alice.locator('.md-chart:visible svg').count()) >= 2, 'both charts in the preview');
    await until(async () => (await drawn(alice, '.md-chart')).includes('Mar'), 'the months from the spreadsheet');
    const bar = await drawn(alice, '.md-chart');
    assert(bar.includes('Spending by month') && bar.includes('rent') && bar.includes('food') && bar.includes('Jan'), `the bar chart: ${bar}`);
    await shot(alice, '03-from-a-sheet');
    assert((await api(alice, 'POST', `/api/docs/${docId}/share`, { who: '@Bob Rivera', role: 'viewer' })).status === 200, 'share with Bob');
    await bob.goto(`${ORIGIN}/d/${docId}`);
    await until(async () => (await bob.locator('.md-chart:visible svg').count()) >= 2, 'Bob to see both charts');
    await until(async () => (await drawn(bob, '.md-chart')).includes('Mar'), 'Bob to see the data');
    eq((await api(bob, 'GET', `/api/docs/${sheetId}`)).status, 404, 'Bob cannot open the spreadsheet itself');
    eq((await api(bob, 'GET', `/api/docs/${docId}/chart-data?doc=${sheetId}&range=${encodeURIComponent('Sheet1!A1:C9')}`)).status, 404, 'nor any other range of it');
    await shot(bob, '04-reader-dark');
  });

  await step('a chart that is code runs in a frame: it draws, and reaches neither the network nor the page around it', async () => {
    const code = [
      'const probe = {};',
      'try { await fetch("/api/me"); probe.net = "reached"; } catch { probe.net = "blocked"; }',
      'try { probe.page = String(parent.document.title); } catch { probe.page = "blocked"; }',
      'try { probe.cookie = document.cookie || "none"; } catch { probe.cookie = "blocked"; }',
      'return { title: { text: `net ${probe.net}, page ${probe.page}, cookie ${probe.cookie}`, textStyle: { color: theme.text, fontSize: 13 } }, color: theme.colors,',
      '  xAxis: { type: "category", data: data.rows.map((r) => r[0]) }, yAxis: {}, series: [{ type: "bar", data: data.rows.map((r) => r[1] + r[2]) }] };',
    ].join('\n');
    const text = `# Code\n\n\`\`\`chart\ntype: code\ntitle: Totals\ndata: ${sheetId} Sheet1!A1:C4\n\n${code}\n\`\`\`\n`;
    eq((await api(alice, 'POST', `/api/operations/edit_document`, { document: docId, edits: [{ replace_all_content: text }] })).status, 200, 'edit');
    await alice.locator('iframe.md-chart-frame:visible').first().waitFor();
    const frame = alice.frameLocator('iframe.md-chart-frame:visible').first();
    await frame.locator('svg').first().waitFor();
    const shown = await frame.locator('svg').first().evaluate((s) => s.textContent);
    assert(/net blocked, page blocked, cookie (blocked|none)/.test(shown), `what the code could reach: ${shown}`);
    assert(shown.includes('Jan') && shown.includes('Mar'), `the data reached the code: ${shown}`);
    eq(await alice.locator('iframe.md-chart-frame:visible').first().getAttribute('sandbox'), 'allow-scripts', 'the frame is sandboxed');
    await sleep(1200); // the bars grow in
    await shot(alice, '05-code-chart');
    // Opened by itself (a link someone was sent), the frame's address runs nothing.
    const lone = await aliceCtx.newPage();
    await lone.goto(`${ORIGIN}/chart-frame#${Buffer.from(JSON.stringify({ text: 'type: code\n\nel.textContent = "ran";' })).toString('base64url')}`);
    await lone.locator('.note', { hasText: 'shows nothing by itself' }).waitFor();
    assert(!(await lone.locator('#chart').textContent()).includes('ran'), 'the code did not run');
    await lone.close();
    // Code that throws says so in the frame, and nothing else breaks.
    eq((await api(alice, 'POST', `/api/operations/edit_document`, { document: docId, edits: [{ replace_all_content: '```chart\ntype: code\n\nthrow new Error("my mistake");\n```\n' }] })).status, 200, 'edit');
    await until(async () => (await alice.frameLocator('iframe.md-chart-frame:visible').first().locator('.note').textContent({ timeout: 500 }).catch(() => '')).includes('my mistake'), 'the error to show in the frame');
  });

  await step('a chart is placed on a sheet from the selected cells, follows a changed cell, and can be changed', async () => {
    await alice.goto(`${ORIGIN}/d/${sheetId}`);
    await alice.locator('.sc[data-at="B2"]').waitFor();
    await click(alice, 'A1'); await click(alice, 'C4', { modifiers: ['Shift'] });
    await alice.getByRole('button', { name: 'Chart the selected cells' }).click();
    await alice.locator('dialog').getByPlaceholder('Title').fill('Spending');
    await alice.getByRole('button', { name: 'Place chart' }).click();
    await alice.locator('.sheet-chart-body svg').waitFor();
    eq(await alice.locator('.sheet-chart-title').textContent(), 'Spending', 'the panel names the chart');
    let text = await drawn(alice, '.sheet-chart-body');
    assert(text.includes('Jan') && text.includes('rent') && text.includes('food'), `the chart on the sheet: ${text}`);
    await click(alice, 'A2'); await type(alice, 'January');
    await until(async () => (await drawn(alice, '.sheet-chart-body')).includes('January'), 'the chart to follow the cell');
    await shot(alice, '06-chart-on-sheet');
    await alice.getByRole('button', { name: 'Change this chart' }).click();
    await alice.locator('dialog').getByLabel('Kind').first().selectOption('pie');
    await alice.getByRole('button', { name: 'Save' }).click();
    await until(async () => (await drawn(alice, '.sheet-chart-body')).includes('%'), 'the pie with its shares');
    await shot(alice, '07-pie-on-sheet');
    const xlsx = await alice.evaluate((i) => fetch(`/api/docs/${i}/export.xlsx`).then(async (r) => ({ status: r.status, size: (await r.arrayBuffer()).byteLength })), sheetId);
    assert(xlsx.status === 200 && xlsx.size > 15_000, `the Excel file with its picture: ${JSON.stringify(xlsx)}`);
    await alice.getByRole('button', { name: 'Remove this chart' }).click();
    await until(async () => (await alice.locator('.sheet-chart').count()) === 0, 'the chart to go');
    await alice.keyboard.press(`${MOD}+z`);
    await alice.locator('.sheet-chart-body svg').waitFor();
  });

  await step('no uncaught errors in any page', async () => { assert(consoleErrors.length === 0, `errors:\n${consoleErrors.join('\n')}`); });
} catch {
  try { await alice.screenshot({ path: join(SHOTS, 'FAIL-alice.png') }); await bob.screenshot({ path: join(SHOTS, 'FAIL-bob.png') }); } catch { /* ignore */ }
  if (consoleErrors.length) console.error(`page errors:\n${consoleErrors.slice(0, 12).join('\n')}`);
  console.error(`server log tail:\n${server.log().split('\n').slice(-30).join('\n')}`);
} finally {
  await browser.close().catch(() => undefined);
  server.proc.kill('SIGTERM');
  await sleep(300);
  if (server.proc.exitCode === null) server.proc.kill('SIGKILL');
  rmSync(DATA, { recursive: true, force: true });
  writeFileSync(join(SHOTS, 'RESULT.txt'), `${failed ? 'FAILED' : 'PASSED'}\n${results.join('\n')}\n`);
  console.log(`\n${failed ? 'FAILED' : 'PASSED'} — ${results.length} steps; screenshots in ${SHOTS}`);
  process.exit(failed ? 1 : 0);
}
