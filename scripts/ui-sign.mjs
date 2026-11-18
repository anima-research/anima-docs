#!/usr/bin/env node
// Filling in and signing a PDF, in a real headless browser.
//
// Starts the server on a fresh data directory (dev issuer). An agent puts a
// PDF with form fields in Alice's collection and asks for her signature (a
// field beside "Signature:") and her initials (a field by its box). Alice
// sees the file waiting, opens it, fills the form (in Cyrillic, to take the
// path through the font that holds it), draws her signature and initials,
// types a line and places the date, and saves. The saved PDF is then read
// back: the typed words are in it, the pictures are in it, the form is flat,
// the agent's threads are answered and closed, and the history names Alice.
// Her signature is kept for her: a second PDF takes it without the pad.
//
//   npm run build:web && node scripts/ui-sign.mjs
//   env: SMOKE_PORT (7369), SMOKE_SHOTS ($TMPDIR/anima-docs-sign-shots), SMOKE_HEADED=1

import { chromium } from 'playwright';
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT ?? 7369);
const ORIGIN = `http://localhost:${PORT}`;
const SHOTS = process.env.SMOKE_SHOTS ?? join(tmpdir(), 'anima-docs-sign-shots');
const DATA = mkdtempSync(join(tmpdir(), 'docs-sign-'));
const WORK = mkdtempSync(join(tmpdir(), 'docs-sign-out-'));
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
const run = (cmd, args) => new Promise((ok, no) => execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (e, out, err) => (e ? no(new Error(err || e.message)) : ok(out))));

/** A one-page agreement with a name field, a checkbox, and lines to sign and date. */
async function agreement(title) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const say = (text, x, y, size = 12) => page.drawText(text, { x, y, size, font });
  say(title, 72, 700, 20);
  say('The undersigned agrees to the terms set out above.', 72, 660);
  say('Name:', 72, 600);
  say('I have read the terms', 96, 560);
  say('Signature:', 72, 480);
  say('Date:', 72, 420);
  const form = doc.getForm();
  form.createTextField('name').addToPage(page, { x: 120, y: 592, width: 260, height: 22 });
  form.createCheckBox('agree').addToPage(page, { x: 72, y: 556, width: 14, height: 14 });
  return Buffer.from(await doc.save());
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
/** Draw on a pad as a hand would: a few strokes. */
async function scribble(page, pad) {
  const b = await pad.boundingBox();
  const at = (fx, fy) => [b.x + b.width * fx, b.y + b.height * fy];
  for (const stroke of [[[0.12, 0.7], [0.2, 0.25], [0.28, 0.72], [0.36, 0.3], [0.45, 0.68]], [[0.5, 0.5], [0.62, 0.35], [0.7, 0.6], [0.86, 0.42]]]) {
    await page.mouse.move(...at(...stroke[0]));
    await page.mouse.down();
    for (const p of stroke.slice(1)) await page.mouse.move(...at(...p), { steps: 6 });
    await page.mouse.up();
  }
}

const server = await startServer();
const browser = await chromium.launch({ headless: !process.env.SMOKE_HEADED });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: 'light' });
const alice = await ctx.newPage();
watch(alice, 'alice');
let id = '', scout = '';
const op = async (name, args) => (await (await fetch(`${ORIGIN}/api/operations/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${scout}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) })).json()).content[0].text;
const row = (name) => alice.locator('.coll-row:not(.head), .coll-tile', { has: alice.getByText(name, { exact: true }) });

try {
  await step('an agent puts an agreement in Alice’s collection and asks her to sign and to initial it', async () => {
    await alice.goto(`${ORIGIN}/`);
    await alice.getByLabel('Your name').fill('Alice Chen');
    await alice.getByRole('button', { name: 'Continue' }).click();
    await alice.locator('main.home h1', { hasText: 'Documents' }).waitFor();
    scout = (await (await fetch(`${ORIGIN}/dev/token`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Scout', kind: 'agent' }) })).json()).token;
    await op('whoami', {});
    id = await alice.evaluate(async () => {
      const d = await (await fetch('/api/docs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Agreements', type: 'files' }) })).json();
      await fetch(`/api/docs/${d.id}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ who: '@Scout', role: 'editor' }) });
      return d.id;
    });
    for (const name of ['Lease 2026.pdf', 'Second form.pdf']) await op('attach_file', { document: id, path: `to sign/${name}`, content: (await agreement(name.replace('.pdf', ''))).toString('base64'), encoding: 'base64' });
    const asked = await op('add_comment', { document: id, field: 'signature', file: 'to sign/Lease 2026.pdf', near: 'Signature:', assign_to: '@Alice Chen', text: 'The lease for the new office: please sign.' });
    assert(/^Signature field on page 1 .* placed beside “Signature:”.*Assigned to Alice Chen/s.test(asked), asked);
    const init = await op('add_comment', { document: id, field: 'initials', file: 'to sign/Lease 2026.pdf', page: 1, box: [0.82, 0.9, 0.1, 0.045], assign_to: '@Alice Chen' });
    assert(/^Initials field on page 1/.test(init), init);
  });

  await step('the file shows that it waits for her; opening it opens it for signing, with both places marked', async () => {
    await alice.goto(`${ORIGIN}/d/${id}?at=${encodeURIComponent('to sign')}`);
    // Asking for the history commits what is waiting: the agent's uploads are a change of their own, before hers.
    await alice.evaluate((i) => fetch(`/api/docs/${i}/git/log`).then((r) => r.json()), id);
    await row('Lease 2026.pdf').locator('.sign-chip.mine', { hasText: 'Sign' }).waitFor();
    assert(await row('Second form.pdf').locator('.sign-chip').count() === 0, 'nothing is asked on the other file');
    await shot(alice, '01-waiting');
    await row('Lease 2026.pdf').locator('.coll-open').click();
    await alice.locator('.sign-page.drawn').first().waitFor();
    await alice.locator('.sign-field.signature.mine', { hasText: 'Sign here' }).waitFor();
    await alice.locator('.sign-field.initials.mine', { hasText: 'Initial here' }).waitFor();
    assert((await alice.locator('.sign-hint').textContent()) === '2 places to sign.', `hint: ${await alice.locator('.sign-hint').textContent()}`);
    // The signature field is on the line of the word it was placed beside, to its right.
    const where = await alice.evaluate(() => { const f = document.querySelector('.sign-field.signature').getBoundingClientRect(), p = document.querySelector('.sign-page').getBoundingClientRect(); return { x: (f.left - p.left) / p.width, y: (f.bottom - p.top) / p.height }; });
    assert(where.x > 0.2 && where.x < 0.3 && Math.abs(where.y - (792 - 478) / 792) < 0.02, `field at ${JSON.stringify(where)}`);
    await shot(alice, '02-to-sign');
  });

  await step('she fills in the form: a name in Cyrillic, a box ticked', async () => {
    await alice.locator('.sign-input').fill('Аліса Chen');
    await alice.locator('.sign-check').check();
    assert(await alice.getByRole('button', { name: 'Save', exact: true }).isEnabled(), 'there is something to save');
  });

  await step('she draws her signature and her initials once, and each goes in its place', async () => {
    await alice.locator('.sign-field.signature').click();
    const pad = alice.locator('dialog[open] canvas.sign-pad');
    await pad.waitFor();
    assert(await alice.getByRole('button', { name: 'Use this as my signature' }).isDisabled(), 'nothing drawn yet');
    await scribble(alice, pad);
    await shot(alice, '03-pad');
    await alice.getByRole('button', { name: 'Use this as my signature' }).click();
    await alice.locator('.sign-item.image img[alt="Your signature"]').waitFor();
    assert(await alice.locator('.sign-field.signature').count() === 0, 'the place is taken');
    await alice.locator('.sign-field.initials').click();
    await scribble(alice, alice.locator('dialog[open] canvas.sign-pad'));
    await alice.getByRole('button', { name: 'Use these as my initials' }).click();
    await alice.locator('.sign-item.image img[alt="Your initials"]').waitFor();
    // Inside the box she was asked to sign in.
    const fits = await alice.evaluate(() => { const s = document.querySelector('.sign-item.image').getBoundingClientRect(), p = document.querySelector('.sign-page').getBoundingClientRect(); return { x: (s.left - p.left) / p.width, bottom: (s.bottom - p.top) / p.height, w: s.width / p.width }; });
    assert(fits.x > 0.2 && fits.w < 0.3 && Math.abs(fits.bottom - (792 - 478) / 792) < 0.02, `signature at ${JSON.stringify(fits)}`);
  });

  await step('she types a line and places the date', async () => {
    const page = alice.locator('.sign-page').first();
    const box = await page.boundingBox();
    await alice.getByRole('button', { name: 'Text' }).click();
    await page.click({ position: { x: box.width * 0.45, y: box.height * 0.3 } });
    await alice.keyboard.type('Read and agreed in Kyiv');
    await alice.getByRole('button', { name: 'Date' }).click();
    await page.click({ position: { x: box.width * 0.3, y: box.height * (792 - 424) / 792 } });
    assert(await alice.locator('.sign-item.text').count() === 2, 'a typed line and a date');
    await shot(alice, '04-filled');
  });

  await step('saving makes the next version of the file: words, pictures and a flat form are in it', async () => {
    await alice.getByRole('button', { name: 'Save', exact: true }).click();
    // Saved when the signing view has given way to the file as it now is (a toast would be gone before a slow machine looked).
    await alice.locator('iframe.coll-pdf').waitFor().catch(async (e) => { throw new Error(`the signing view did not close; the page said: ${await alice.locator('.toast').allTextContents()} (${e.message.split('\n')[0]})`); });
    const b64 = await alice.evaluate(async (i) => { const b = new Uint8Array(await (await fetch(`/p/${i}/to%20sign/Lease%202026.pdf`, { cache: 'no-store' })).arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); }, id);
    const out = join(WORK, 'signed.pdf');
    writeFileSync(out, Buffer.from(b64, 'base64'));
    const signed = await PDFDocument.load(Buffer.from(b64, 'base64'));
    assert(signed.getForm().getFields().length === 0, 'the form is flat: nothing left to change');
    const text = await run('pdftotext', ['-enc', 'UTF-8', out, '-']);
    for (const words of ['Аліса Chen', 'Read and agreed in Kyiv', String(new Date().getFullYear()), 'Signature:']) assert(text.includes(words), `the PDF says “${words}”: ${JSON.stringify(text)}`);
    const pictures = (await run('pdfimages', ['-list', out])).trim().split('\n').slice(2);
    assert(pictures.length >= 2, `the signature and the initials are pictures in it: ${pictures.join(' | ')}`);
    // The date sits on the line of "Date:", the signature on the line of "Signature:": what she saw is where it is.
    const boxes = await run('pdftotext', ['-bbox', out, '-']);
    // (The year also stands in the title; what she placed was written last.)
    const yOf = (word) => Number([...boxes.matchAll(new RegExp(`yMax="([\\d.]+)">${word}<`, 'g'))].pop()?.[1]);
    assert(Math.abs(yOf('Date:') - yOf(String(new Date().getFullYear()))) < 8, `the date is on its line: ${yOf('Date:')} vs ${yOf(String(new Date().getFullYear()))}`);
    await alice.screenshot({ path: join(SHOTS, '05-saved.png') });
  });

  await step('the agent hears it in its threads; the history names Alice; nothing waits any more', async () => {
    const threads = await op('list_comments', { document: id, include_resolved: true });
    assert((threads.match(/RESOLVED by Alice Chen/g) ?? []).length === 2 && threads.includes('Signed.') && threads.includes('Initialled.'), threads);
    const log = await alice.evaluate((i) => fetch(`/api/docs/${i}/git/log`).then((r) => r.json()), id);
    assert(log.commits[0].author === 'Alice Chen' && log.commits[0].message === 'Change to sign/Lease 2026.pdf', JSON.stringify(log.commits[0]));
    await alice.getByRole('button', { name: 'Back to the folder' }).click();
    await row('Lease 2026.pdf').waitFor();
    assert(await alice.locator('.sign-chip').count() === 0, 'no file waits for a signature');
  });

  await step('her signature is kept for her: on another PDF it is placed without drawing again, and only she can read it', async () => {
    await row('Second form.pdf').locator('.coll-open').click();
    await alice.locator('iframe.coll-pdf').waitFor();
    await alice.getByRole('button', { name: 'Fill & sign' }).click();
    await alice.locator('.sign-page.drawn').first().waitFor();
    const page = alice.locator('.sign-page').first();
    const box = await page.boundingBox();
    await alice.getByRole('button', { name: 'Signature', exact: true }).click();
    await page.click({ position: { x: box.width * 0.4, y: box.height * 0.4 } });
    await alice.locator('.sign-item.image img[alt="Your signature"]').waitFor();
    assert(await alice.locator('dialog[open] canvas.sign-pad').count() === 0, 'no pad: the kept signature is used');
    // Leaving with it unsaved asks first.
    await alice.getByRole('button', { name: 'Close', exact: true }).click();
    await alice.locator('dialog[open]', { hasText: 'has not been saved' }).getByRole('button', { name: 'Leave' }).click();
    await alice.locator('iframe.coll-pdf').waitFor();
    assert((await alice.evaluate(() => fetch('/api/me/signature').then((r) => r.status))) === 200, 'hers to read');
    assert((await fetch(`${ORIGIN}/api/me/signature`, { headers: { Authorization: `Bearer ${scout}` } })).status === 403, 'not an agent’s');
  });

  await step('no uncaught errors in the page', async () => { assert(consoleErrors.length === 0, `errors:\n${consoleErrors.join('\n')}`); });
} catch {
  try { await alice.screenshot({ path: join(SHOTS, 'FAIL-alice.png') }); } catch { /* ignore */ }
  if (consoleErrors.length) console.error(`page errors:\n${consoleErrors.slice(0, 12).join('\n')}`);
  console.error(`server log tail:\n${server.log().split('\n').slice(-30).join('\n')}`);
} finally {
  await browser.close().catch(() => undefined);
  server.proc.kill('SIGTERM');
  await sleep(300);
  if (server.proc.exitCode === null) server.proc.kill('SIGKILL');
  rmSync(DATA, { recursive: true, force: true });
  rmSync(WORK, { recursive: true, force: true });
  writeFileSync(join(SHOTS, 'RESULT.txt'), `${failed ? 'FAILED' : 'PASSED'}\n${results.join('\n')}\n`);
  console.log(`\n${failed ? 'FAILED' : 'PASSED'} — ${results.length} steps; screenshots in ${SHOTS}`);
  process.exit(failed ? 1 : 0);
}
