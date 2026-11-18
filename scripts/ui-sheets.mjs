#!/usr/bin/env node
// Spreadsheets in a real headless browser.
//
// Starts the server on a fresh data directory (dev issuer), then: Alice makes
// a spreadsheet, types values and formulas, pastes rows from the clipboard,
// inserts a row, sorts, formats, copies a formula, fills down, undoes, adds a
// sheet; Bob joins and both type at once (different cells, then the same
// cell); a reader cannot change anything; the history shows the changes; the
// Excel file downloads; a 5,000-row sheet scrolls. Screenshots go to SMOKE_SHOTS.
//
//   npm run build:web && node scripts/ui-sheets.mjs
//   env: SMOKE_PORT (7369), SMOKE_SHOTS ($TMPDIR/anima-docs-sheets-shots), SMOKE_HEADED=1

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT ?? 7369);
const ORIGIN = `http://localhost:${PORT}`;
const SHOTS = process.env.SMOKE_SHOTS ?? join(tmpdir(), 'anima-docs-sheets-shots');
const DATA = mkdtempSync(join(tmpdir(), 'docs-sheets-'));
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
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(`[${who}] console: ${m.text()}`); });
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
const viewport = { width: 1360, height: 860 };
const aliceCtx = await browser.newContext({ viewport, colorScheme: 'light' });
const bobCtx = await browser.newContext({ viewport, colorScheme: 'light' });
const alice = await aliceCtx.newPage();
const bob = await bobCtx.newPage();
watch(alice, 'alice'); watch(bob, 'bob');
let id = '';

try {
  await step('Alice makes a spreadsheet from the New document dialog: a grid, no text editor', async () => {
    await signIn(bob, 'Bob Rivera');
    await signIn(alice, 'Alice Chen');
    await alice.getByRole('button', { name: 'New document' }).first().click();
    await alice.getByLabel('Title').fill('Household ledger');
    await alice.getByText('Spreadsheet', { exact: true }).click();
    await shot(alice, '01-new-spreadsheet-dialog');
    await alice.getByRole('button', { name: 'Create' }).click();
    await alice.waitForURL(/\/d\/[A-Za-z0-9]+$/);
    id = new URL(alice.url()).pathname.split('/').pop();
    await alice.locator('.sheet-view .sheet-rh', { hasText: /^1$/ }).waitFor();
    await alice.locator('dialog[open]').waitFor({ state: 'detached' }); // the New document dialog holds the keyboard until it has closed
    assert(!(await alice.locator('.doc-toolbar').isVisible()), 'no formatting toolbar on a spreadsheet');
    assert(!(await alice.locator('.editor-page').isVisible()), 'no text editor on a spreadsheet');
    eq(await nameBox(alice), 'A1', 'the first cell is selected');
    eq(await alice.locator('.sheet-tab').allTextContents(), ['Sheet1'], 'one sheet');
  });

  await step('typing fills cells: Tab goes right, Enter goes down; a formula shows its value and the bar shows the formula', async () => {
    await type(alice, 'date', 'Tab'); await type(alice, 'item', 'Tab'); await type(alice, 'amount', 'Enter');
    await click(alice, 'A2');
    for (const [d, item, n] of [['2026-01-09', 'Books', '40'], ['2026-01-05', 'Rent', '1200'], ['2026-01-07', 'Food', '80.5']]) {
      await type(alice, d, 'Tab'); await type(alice, item, 'Tab'); await type(alice, n, 'Enter');
      await alice.keyboard.press('Home');
    }
    await click(alice, 'B6'); await type(alice, 'total', 'Tab'); await type(alice, '=SUM(C2:C4)', 'Enter');
    await see(alice, ['A1', 'B2', 'C3', 'C6'], ['date', 'Books', '1200', '1320.5'], 'cells');
    await click(alice, 'C6');
    eq(await fx(alice), '=SUM(C2:C4)', 'the formula bar shows what was typed');
    eq(await alice.locator('.sc[data-at="C3"]').evaluate((e) => getComputedStyle(e).textAlign), 'right', 'numbers sit on the right');
    // Escape leaves a cell as it was; F2 and a double click edit what is there.
    await click(alice, 'B2'); await alice.keyboard.type('oops'); await alice.keyboard.press('Escape');
    await see(alice, ['B2'], ['Books'], 'Escape cancels');
    await alice.keyboard.press('F2'); await alice.keyboard.type(' (used)'); await alice.keyboard.press('Enter');
    await see(alice, ['B2'], ['Books (used)'], 'F2 edits in place');
    // Through the formula bar.
    await click(alice, 'B2'); await alice.locator('.sheet-fx').fill('Books'); await alice.keyboard.press('Enter');
    await see(alice, ['B2'], ['Books'], 'the formula bar writes the cell');
    await shot(alice, '02-typed');
  });

  await step('rows pasted from another program land as cells; an inserted row leaves the total pointing at the same cells', async () => {
    await click(alice, 'A5');
    await paste(alice, '2026-01-11\tTrain\t62\n2026-01-12\t"Tea, coffee"\t9.5\n');
    await see(alice, ['A5', 'B5', 'C5', 'B6', 'C6'], ['2026-01-11', 'Train', '62', 'Tea, coffee', '9.5'], 'pasted rows (they overwrote the old total row)');
    await click(alice, 'B8'); await type(alice, 'total', 'Tab'); await type(alice, '=SUM(C2:C6)', 'Enter');
    await see(alice, ['C8'], ['1392'], 'total');
    await menu(alice, '3', 'Insert a row above', 'row');
    await see(alice, ['B3', 'B4', 'C9'], ['', 'Rent', '1392'], 'the row is new and empty; the total moved down');
    await click(alice, 'C9');
    eq(await fx(alice), '=SUM(C2:C7)', 'the range grew around the new row');
    await click(alice, 'A3'); await type(alice, '2026-01-03', 'Tab'); await type(alice, 'Paper', 'Tab'); await type(alice, '12', 'Enter');
    await see(alice, ['C9'], ['1404'], 'the new row counts');
  });

  await step('sorting by a column moves whole rows and keeps row 1; a number format shows in the cells', async () => {
    await click(alice, 'D1'); await type(alice, 'with tax', 'Enter'); await type(alice, '=C2*1.2', 'Enter');
    await click(alice, 'A2'); await click(alice, 'D7', { modifiers: ['Shift'] });
    eq(await nameBox(alice), 'A2:D7', 'a range is selected');
    await menu(alice, 'A', /Sort by column A, A → Z/, 'col');
    await see(alice, ['A2', 'B2', 'A7', 'B7', 'D7'], ['2026-01-03', 'Paper', '2026-01-12', 'Tea, coffee', ''], 'sorted by date');
    await see(alice, ['B5', 'D5'], ['Books', '48'], 'the formula went with its row (Books, 40) and still reads its own row');
    await click(alice, 'D5');
    eq(await fx(alice), '=C5*1.2', 'and reads as written for where it is now');
    await see(alice, ['C9'], ['1404'], 'the total is unchanged');
    await menu(alice, 'C', /Sort by column C, Z → A/, 'col');
    await see(alice, ['B1', 'B2', 'B7'], ['item', 'Rent', 'Tea, coffee'], 'row 1 stayed; largest first');
    await alice.mouse.click(...Object.values(await alice.evaluate(() => { const b = [...document.querySelectorAll('.sheet-ch')].find((h) => h.firstChild?.textContent === 'C').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + 12 }; })));
    await alice.locator('.sheet-format').click();
    await alice.getByRole('menuitemradio', { name: /^Number/ }).click();
    await see(alice, ['C2', 'C7', 'C9'], ['1,200.00', '9.50', '1,404.00'], 'formatted');
    await shot(alice, '03-sorted-formatted');
  });

  await step('a copied formula lands shifted; Ctrl+D fills down; undo and redo step back and forth', async () => {
    await click(alice, 'D2'); await type(alice, '=C2*1.2', 'Enter');
    await click(alice, 'D2');
    eq(await copy(alice), '1440', 'the clipboard gets the value');
    await click(alice, 'D3'); await paste(alice, '1440');
    await see(alice, ['D3'], [String(80.5 * 1.2)], 'pasted here, it is the formula for this row');
    await click(alice, 'D3'); eq(await fx(alice), '=C3*1.2', 'shifted one row');
    await click(alice, 'D3'); await click(alice, 'D7', { modifiers: ['Shift'] });
    await alice.keyboard.press(`${MOD}+d`);
    await click(alice, 'D7'); eq(await fx(alice), '=C7*1.2', 'filled down');
    await alice.keyboard.press(`${MOD}+z`);
    await see(alice, ['D7'], [''], 'undo takes the fill back');
    await alice.keyboard.press(`${MOD}+Shift+z`);
    await see(alice, ['D7'], ['11.4'], 'redo brings it again');
    // Dragging the corner handle fills too.
    await click(alice, 'E2'); await type(alice, '=D2-C2', 'Enter'); await click(alice, 'E2');
    const hb = await alice.locator('.sheet-fill').boundingBox();
    await alice.mouse.move(hb.x + 3, hb.y + 3); await alice.mouse.down(); await alice.mouse.move(hb.x + 3, hb.y + 3 + 25 * 5, { steps: 6 }); await alice.mouse.up();
    await click(alice, 'E7'); eq(await fx(alice), '=D7-C7', 'filled by dragging');
    // Delete clears a range; the status line sums what is selected.
    await click(alice, 'C2'); await click(alice, 'C7', { modifiers: ['Shift'] });
    assert(/Sum 1404 · Average 234 · Count 6/.test(await alice.locator('.sheet-stats').textContent()), `stats: ${await alice.locator('.sheet-stats').textContent()}`);
  });

  await step('a second sheet reads the first; renaming a sheet carries its formulas', async () => {
    await alice.getByRole('button', { name: 'Add a sheet' }).click();
    eq(await alice.locator('.sheet-tab').allTextContents(), ['Sheet1', 'Sheet2'], 'two sheets');
    await type(alice, 'spent', 'Tab'); await type(alice, '=Sheet1!C9', 'Enter');
    await see(alice, ['B1'], ['1404'], 'a value from the other sheet');
    await alice.locator('.sheet-tab', { hasText: 'Sheet1' }).dblclick();
    await alice.getByLabel('Name').fill('Ledger');
    await alice.getByRole('button', { name: 'Rename' }).click();
    await alice.locator('.sheet-tab', { hasText: 'Ledger' }).waitFor();
    await alice.locator('.sheet-tab', { hasText: 'Sheet2' }).click();
    await click(alice, 'B1'); eq(await fx(alice), '=Ledger!C9', 'the formula follows the new name');
    await see(alice, ['B1'], ['1404'], 'and still has its value');
    await alice.locator('.sheet-tab', { hasText: 'Ledger' }).click();
    await shot(alice, '04-two-sheets');
  });

  await step('Bob joins: each sees the other’s cell and what the other types; one cell written by both keeps one value', async () => {
    const shared = await alice.evaluate((i) => fetch(`/api/docs/${i}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ who: '@Bob Rivera', role: 'editor' }) }).then((r) => r.status), id);
    assert(shared === 200, `share: ${shared}`);
    await bob.goto(`${ORIGIN}/d/${id}`);
    await bob.locator('.sc[data-at="B2"]', { hasText: 'Rent' }).waitFor();
    await click(bob, 'F3');
    await alice.locator('.sheet-peer span', { hasText: 'Bob Rivera' }).waitFor();
    await click(alice, 'F2');
    await bob.locator('.sheet-peer span', { hasText: 'Alice Chen' }).waitFor();
    // Different cells at the same moment.
    await Promise.all([type(alice, 'alice was here'), type(bob, 'bob was here')]);
    await until(async () => (await cell(alice, 'F3')) === 'bob was here' && (await cell(bob, 'F2')) === 'alice was here', 'both to see both cells');
    // Bob inserts a row above while Alice is still typing in hers: her text lands in her row.
    await click(alice, 'G5'); await alice.keyboard.type('still typing');
    await menu(bob, '2', 'Insert a row above', 'row');
    await alice.keyboard.press('Enter');
    await until(async () => (await cell(bob, 'G6')) === 'still typing', 'her entry in the row that moved down');
    await see(alice, ['G6'], ['still typing'], 'on her side too');
    await menu(bob, '2', /Delete row 2/, 'row');
    await see(alice, ['B2', 'B3'], ['Rent', 'Food'], 'Alice sees the row gone');
    await see(bob, ['B2', 'B3'], ['Rent', 'Food'], 'Bob sees the row gone');
    // The same cell, both cut off from each other for a moment: one value wins on both sides, whole.
    await aliceCtx.setOffline(true); await bobCtx.setOffline(true);
    await sleep(200);
    await click(alice, 'C3'); await type(alice, '111');
    await click(bob, 'C3'); await type(bob, '999');
    await aliceCtx.setOffline(false); await bobCtx.setOffline(false);
    await alice.evaluate(() => window.dispatchEvent(new Event('online'))); await bob.evaluate(() => window.dispatchEvent(new Event('online')));
    const final = await until(async () => { const [a, b] = [await cell(alice, 'C3'), await cell(bob, 'C3')]; return a === b && (a === '111.00' || a === '999.00') ? a : null; }, 'both to agree on C3', 15000);
    assert(final === '111.00' || final === '999.00', `C3 is one of the two values: ${final}`);
    await see(alice, ['B2', 'C2', 'B3'], ['Rent', '1,200.00', 'Food'], 'and it is the same cell for both: nothing else moved');
    await shot(alice, '05-two-people');
  });

  await step('a reader sees the sheet and can change nothing', async () => {
    await alice.evaluate((i) => fetch(`/api/docs/${i}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ who: '@Bob Rivera', role: 'viewer' }) }).then((r) => r.status), id);
    await bob.locator('.sheet-view.read-only').waitFor();
    const before = await cell(bob, 'B2');
    await click(bob, 'B2'); await bob.keyboard.type('nope'); await bob.keyboard.press('Enter'); await bob.keyboard.press('Delete');
    await sleep(300);
    await see(bob, ['B2'], [before], 'unchanged for the reader');
    await see(alice, ['B2'], [before], 'and for everyone');
    assert(!(await bob.locator('.sheet-add').count()), 'no way to add a sheet');
    await click(bob, 'B2');
    eq(await copy(bob), before, 'a reader can still copy');
  });

  await step('the history lists the changes; the Excel file downloads; a reload shows the same sheet', async () => {
    await alice.getByRole('button', { name: 'More' }).click();
    await alice.getByRole('menuitem', { name: 'History' }).click();
    await alice.locator('.side-panel.open').waitFor();
    await until(async () => (await alice.locator('.side-panel.open').textContent()).includes('Alice Chen'), 'the history to list Alice');
    await shot(alice, '06-history');
    const file = await alice.evaluate((i) => fetch(`/api/docs/${i}/export.xlsx`).then(async (r) => ({ status: r.status, type: r.headers.get('content-type'), name: r.headers.get('content-disposition'), size: (await r.arrayBuffer()).byteLength })), id);
    assert(file.status === 200 && /spreadsheetml/.test(file.type) && /Household ledger\.xlsx/.test(file.name) && file.size > 3000, `xlsx: ${JSON.stringify(file)}`);
    const was = await cells(alice, ['B2', 'C2', 'C9', 'F2']);
    await alice.reload();
    await alice.locator('.sc[data-at="B2"]').waitFor();
    await see(alice, ['B2', 'C2', 'C9', 'F2'], was, 'after a reload');
  });

  await step('five thousand pasted rows: the bottom is a scroll away and sums at once', async () => {
    await alice.getByRole('button', { name: 'Add a sheet' }).click();
    const rows = Array.from({ length: 5000 }, (_, i) => `2026-02-${String(1 + (i % 28)).padStart(2, '0')}\titem ${i + 1}\t${(i % 97) + 0.5}\t=C${i + 1}*2`).join('\n');
    const t0 = Date.now();
    await paste(alice, rows);
    await alice.locator('.sc[data-at="D1"]', { hasText: /^1$/ }).waitFor();
    const pasteMs = Date.now() - t0;
    await alice.keyboard.press(`${MOD}+ArrowDown`);
    await until(async () => (await nameBox(alice)) === 'A5000', 'the jump to the last row');
    await alice.locator('.sc[data-at="B5000"]', { hasText: 'item 5000' }).waitFor();
    await click(alice, 'F5000'); await type(alice, '=SUM(C1:C5000)');
    const want = String(Array.from({ length: 5000 }, (_, i) => (i % 97) + 0.5).reduce((a, b) => a + b, 0));
    await see(alice, ['F5000'], [want], 'the sum of five thousand rows');
    const nodes = await alice.locator('.sheet-cells .sc').count();
    assert(nodes < 800, `only the cells in view are in the page (${nodes})`);
    results.push(`    paste of 5,000 × 4 cells shown after ${pasteMs} ms; ${nodes} cell elements in the page`);
    await shot(alice, '07-five-thousand-rows');
  });

  await step('dark theme and a phone-sized window', async () => {
    for (const [name, opts] of [['08-dark', { viewport, colorScheme: 'dark' }], ['09-phone', { viewport: { width: 390, height: 800 }, colorScheme: 'light' }]]) {
      const ctx = await browser.newContext({ ...opts, storageState: await aliceCtx.storageState() });
      const p = await ctx.newPage(); watch(p, name);
      await p.goto(`${ORIGIN}/d/${id}`);
      await p.locator('.sc[data-at="B2"]').waitFor();
      assert(await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${name}: the page does not scroll sideways`);
      await shot(p, name);
      await ctx.close();
    }
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
