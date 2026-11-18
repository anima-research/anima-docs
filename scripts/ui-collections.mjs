#!/usr/bin/env node
// File collections in a real headless browser.
//
// Starts the server on a fresh data directory (dev issuer), then: Alice makes
// a file collection, uploads files (by the picker and as a folder), sees them
// as a list and as a grid with thumbnails, opens an image, a PDF and a
// markdown file, edits and saves the markdown, renames, moves and deletes,
// follows a link to a folder, and shares the collection with Bob, who can
// look but not change. Screenshots (light, dark, narrow) go to SMOKE_SHOTS.
//
//   npm run build:web && node scripts/ui-collections.mjs
//   env: SMOKE_PORT (7368), SMOKE_SHOTS ($TMPDIR/anima-docs-collections-shots), SMOKE_HEADED=1

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT ?? 7368);
const ORIGIN = `http://localhost:${PORT}`;
const SHOTS = process.env.SMOKE_SHOTS ?? join(tmpdir(), 'anima-docs-collections-shots');
const DATA = mkdtempSync(join(tmpdir(), 'docs-collections-'));
const LOCAL = mkdtempSync(join(tmpdir(), 'docs-collections-files-'));
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
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });

/** A PNG of one colour fading to another, encoded by hand. */
function makePng(w, h, [r0, g0, b0], [r1, g1, b1]) {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * (w * 3 + 1) + 1 + x * 3, t = (x + y) / (w + h);
    raw[i] = r0 + (r1 - r0) * t; raw[i + 1] = g0 + (g1 - g0) * t; raw[i + 2] = b0 + (b1 - b0) * t;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';

// The files on "Alice's disk".
const local = (name, body) => { const p = join(LOCAL, name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); return p; };
const F = {
  photo: local('Island at dusk.png', makePng(900, 600, [250, 170, 90], [40, 60, 140])),
  notes: local('Field notes.md', '# Field notes\n\nThe island at dusk:\n\n![the island](Island%20at%20dusk.png)\n\n- tide was **low**\n- two herons\n'),
  data: local('readings.json', JSON.stringify({ station: 'north', readings: [12.1, 12.4, 13.0] }, null, 2)),
  pdf: local('Survey report (final).pdf', PDF),
  empty: local('empty.txt', ''),
};
local('trip/day 1/heron.png', makePng(640, 640, [70, 150, 120], [220, 240, 230]));
local('trip/day 1/shore.png', makePng(800, 500, [30, 100, 190], [200, 220, 250]));
local('trip/day 2/log.txt', 'Day two: rain.\n');
local('trip/.DS_Store', 'junk');

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
const names = (page) => page.locator('.coll-row:not(.head) .coll-name, .coll-tile-name').allTextContents();
const row = (page, name) => page.locator('.coll-row:not(.head), .coll-tile', { has: page.getByText(name, { exact: true }) });
const act = async (page, name, action) => { await row(page, name).locator('.coll-more').click(); await page.getByRole('menuitem', { name: action, exact: true }).click(); };
const listed = (page, id) => page.evaluate((i) => fetch(`/api/docs/${i}/files`).then((r) => r.json()).then((j) => j.files.map((f) => f.path)), id);

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
  await step('Alice makes a file collection from the New document dialog', async () => {
    await signIn(bob, 'Bob Rivera');
    await signIn(alice, 'Alice Chen');
    await alice.getByRole('button', { name: 'New document' }).first().click();
    await alice.getByLabel('Title').fill('Field work');
    await alice.getByText('File collection', { exact: true }).click();
    await shot(alice, '01-new-collection-dialog');
    await alice.getByRole('button', { name: 'Create' }).click();
    await alice.waitForURL(/\/d\/[A-Za-z0-9]+$/);
    id = new URL(alice.url()).pathname.split('/').pop();
    await alice.locator('.coll .empty-state', { hasText: 'No files yet' }).waitFor();
    assert(!(await alice.locator('.doc-toolbar').isVisible()), 'no formatting toolbar on a collection');
    assert(!(await alice.locator('.editor-page').isVisible()), 'no editor on a collection');
    await shot(alice, '02-empty-collection');
  });

  await step('uploads files of several kinds; the list shows them by name with sizes', async () => {
    await alice.locator('.coll input[type=file]:not([webkitdirectory])').setInputFiles([F.photo, F.notes, F.data, F.pdf, F.empty]);
    await alice.locator('.coll-row:not(.head)').nth(4).waitFor();
    assert(JSON.stringify(await names(alice)) === JSON.stringify(['empty.txt', 'Field notes.md', 'Island at dusk.png', 'readings.json', 'Survey report (final).pdf']), `names: ${await names(alice)}`);
    assert((await alice.locator('.coll-summary').textContent()).startsWith('5 files'), 'summary counts the files');
    await shot(alice, '03-list');
  });

  await step('uploads a folder: its structure is kept and junk files are left out', async () => {
    await alice.locator('.coll input[webkitdirectory]').setInputFiles(join(LOCAL, 'trip'));
    await row(alice, 'trip').waitFor();
    const paths = await listed(alice, id);
    assert(paths.includes('trip/day 1/heron.png') && paths.includes('trip/day 2/log.txt'), `paths: ${paths}`);
    assert(!paths.some((p) => p.includes('.DS_Store')), 'no .DS_Store');
    assert((await row(alice, 'trip').locator('.c-size').textContent()).startsWith('3 files'), 'the folder says what it holds');
  });

  await step('the grid shows pictures of the images', async () => {
    await alice.getByRole('radio', { name: 'Grid' }).click();
    const img = row(alice, 'Island at dusk.png').locator('img.coll-thumb-img');
    await img.waitFor();
    await alice.waitForFunction((el) => el.complete && el.naturalWidth > 0, await img.elementHandle());
    const w = await img.evaluate((el) => el.naturalWidth);
    assert(w === 360, `the thumbnail is 360 px wide, not the original 900 (got ${w})`);
    await shot(alice, '04-grid');
  });

  await step('a folder opens; the breadcrumb and the address follow, and Back returns', async () => {
    await row(alice, 'trip').locator('.coll-tile-open').click();
    await row(alice, 'day 1').locator('.coll-tile-open').click();
    await row(alice, 'heron.png').waitFor();
    assert(new URL(alice.url()).searchParams.get('at') === 'trip/day 1', `address: ${alice.url()}`);
    assert((await alice.locator('.coll-crumbs').textContent()) === 'All filestripday 1', 'breadcrumb');
    await shot(alice, '05-folder-grid');
    await alice.goBack();
    await row(alice, 'day 2').waitFor();
    await alice.locator('.coll-crumb', { hasText: 'All files' }).click();
    await row(alice, 'readings.json').waitFor();
  });

  await step('an image opens in the viewer; arrows step through the folder and Escape closes', async () => {
    await row(alice, 'Island at dusk.png').locator('.coll-tile-open').click();
    const img = alice.locator('img.coll-image');
    await img.waitFor();
    await alice.waitForFunction((el) => el.complete && el.naturalWidth === 900, await img.elementHandle());
    await shot(alice, '06-image');
    await alice.keyboard.press('ArrowRight');
    await alice.locator('.coll-view-name', { hasText: 'readings.json' }).waitFor();
    await alice.locator('.coll-source .cm-content', { hasText: '"station": "north"' }).waitFor();
    await alice.locator('.coll-view-bar').click({ position: { x: 300, y: 10 } });
    await alice.keyboard.press('Escape');
    await row(alice, 'readings.json').waitFor();
    assert(!new URL(alice.url()).searchParams.get('at'), 'back at the top');
  });

  await step('a PDF is shown in a frame the browser may fill', async () => {
    const res = alice.waitForResponse((r) => /\/media\/[0-9a-f]{32}\.pdf$/.test(r.url()));
    await row(alice, 'Survey report (final).pdf').locator('.coll-tile-open').click();
    const r = await res;
    assert(r.status() === 200 && r.headers()['content-type'] === 'application/pdf', `pdf response: ${r.status()} ${r.headers()['content-type']}`);
    assert(r.headers()['x-frame-options'] === 'SAMEORIGIN' && /frame-ancestors 'self'/.test(r.headers()['content-security-policy']), 'the PDF may be framed by the app, and only by it');
    await alice.locator('iframe.coll-pdf').waitFor();
    await shot(alice, '07-pdf');
    await alice.getByRole('button', { name: 'Back to the folder' }).click();
  });

  await step('markdown opens rendered, with the picture beside it; editing and saving changes the file', async () => {
    await row(alice, 'Field notes.md').locator('.coll-tile-open').click();
    await alice.locator('.coll-rendered h1', { hasText: 'Field notes' }).waitFor();
    const pic = alice.locator('.coll-rendered img');
    await alice.waitForFunction((el) => el.complete && el.naturalWidth === 900, await pic.elementHandle());
    await shot(alice, '08-markdown-read');
    await alice.getByRole('radio', { name: 'Edit' }).click();
    await alice.locator('.coll-source .cm-content').click();
    await alice.keyboard.press('ControlOrMeta+End');
    await alice.keyboard.insertText('- one seal\n');
    assert(await alice.getByRole('button', { name: 'Save' }).isEnabled(), 'Save lights up');
    await shot(alice, '09-markdown-edit');
    await alice.keyboard.press('ControlOrMeta+s');
    await alice.locator('.toast', { hasText: 'Saved' }).waitFor();
    const text = await alice.evaluate((i) => fetch(`/p/${i}/Field%20notes.md`, { cache: 'no-store' }).then((r) => r.text()), id);
    assert(text.endsWith('- two herons\n- one seal\n'), `saved text: ${JSON.stringify(text.slice(-40))}`);
    await alice.getByRole('radio', { name: 'Read' }).click();
    await alice.locator('.coll-rendered li', { hasText: 'one seal' }).waitFor();
    await alice.getByRole('button', { name: 'Back to the folder' }).click();
  });

  await step('rename, move into a new folder, and delete a folder', async () => {
    await alice.getByRole('radio', { name: 'List' }).click();
    await act(alice, 'readings.json', 'Rename…');
    await alice.getByLabel('Name').fill('readings north.json');
    await alice.getByRole('button', { name: 'Rename' }).click();
    await row(alice, 'readings north.json').waitFor();
    await act(alice, 'readings north.json', 'Move…');
    await alice.getByLabel('To folder').fill('data/2026');
    await alice.getByRole('button', { name: 'Move', exact: true }).click();
    await row(alice, 'data').waitFor();
    assert((await listed(alice, id)).includes('data/2026/readings north.json'), 'moved, the folders made on the way');
    await act(alice, 'trip', 'Delete');
    await alice.locator('dialog[open]', { hasText: 'the 3 files in it' }).getByRole('button', { name: 'Delete' }).click();
    await row(alice, 'trip').waitFor({ state: 'detached' });
    assert(!(await listed(alice, id)).some((p) => p.startsWith('trip/')), 'the folder went with its files');
    await shot(alice, '10-list-after');
  });

  await step('a new folder exists once something is in it; replacing a file asks first', async () => {
    await alice.getByRole('button', { name: 'New folder' }).click();
    await alice.getByLabel('Name').fill('drafts');
    await alice.getByRole('button', { name: 'Create' }).click();
    await alice.locator('.coll .empty-state', { hasText: 'This folder is empty' }).waitFor();
    assert(new URL(alice.url()).searchParams.get('at') === 'drafts', 'inside the new folder');
    await alice.locator('.coll input[type=file]:not([webkitdirectory])').setInputFiles([F.empty]);
    await row(alice, 'empty.txt').waitFor();
    await alice.locator('.coll input[type=file]:not([webkitdirectory])').setInputFiles([F.empty]);
    await alice.locator('dialog[open]', { hasText: 'already here' }).getByRole('button', { name: 'Cancel' }).click();
    assert((await listed(alice, id)).filter((p) => p === 'drafts/empty.txt').length === 1, 'still one');
  });

  await step('Bob, shared as a viewer, follows a link to a file and can look but not change', async () => {
    const shared = await alice.evaluate((i) => fetch(`/api/docs/${i}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ who: '@Bob Rivera', role: 'viewer' }) }).then((r) => r.status), id);
    assert(shared === 200, `share: ${shared}`);
    await bob.goto(`${ORIGIN}/d/${id}?at=${encodeURIComponent('Island at dusk.png')}`);
    await bob.locator('img.coll-image').waitFor();
    await bob.getByRole('button', { name: 'Back to the folder' }).click();
    await row(bob, 'Field notes.md').waitFor();
    assert(!(await bob.getByRole('button', { name: 'Upload' }).isVisible()) && !(await bob.getByRole('button', { name: 'New folder' }).isVisible()), 'no upload for a viewer');
    await row(bob, 'Field notes.md').locator('.coll-more').click();
    assert(await bob.getByRole('menuitem', { name: 'Delete' }).count() === 0 && await bob.getByRole('menuitem', { name: 'Download' }).count() === 1, 'a viewer’s menu reads, it does not write');
    await bob.keyboard.press('Escape');
    await bob.goto(`${ORIGIN}/`);
    await bob.locator('.doc-row', { hasText: 'Field work' }).locator('.type-chip', { hasText: 'Files' }).waitFor();
  });

  await step('dark and narrow', async () => {
    const dark = await browser.newContext({ viewport, colorScheme: 'dark', storageState: await aliceCtx.storageState() });
    const d = await dark.newPage(); watch(d, 'alice-dark');
    await d.goto(`${ORIGIN}/d/${id}`);
    await row(d, 'Field notes.md').waitFor();
    await shot(d, '11-list-dark');
    await dark.close();
    const narrow = await browser.newContext({ viewport: { width: 390, height: 800 }, colorScheme: 'light', storageState: await aliceCtx.storageState() });
    const n = await narrow.newPage(); watch(n, 'alice-phone');
    await n.goto(`${ORIGIN}/d/${id}`);
    await row(n, 'Field notes.md').waitFor();
    assert(await n.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'fits a phone');
    await shot(n, '12-list-phone');
    await narrow.close();
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
  rmSync(LOCAL, { recursive: true, force: true });
  writeFileSync(join(SHOTS, 'RESULT.txt'), `${failed ? 'FAILED' : 'PASSED'}\n${results.join('\n')}\n`);
  console.log(`\n${failed ? 'FAILED' : 'PASSED'} — ${results.length} steps; screenshots in ${SHOTS}`);
  process.exit(failed ? 1 : 0);
}
