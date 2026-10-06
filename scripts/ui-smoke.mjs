#!/usr/bin/env node
// End-to-end UI smoke test in a real headless browser.
//
// Starts the server on a fresh data directory (dev issuer), then: two people
// sign in, create a document, edit concurrently and see each other's text and
// cursors, insert a table and an image, comment with an @mention, reply and
// resolve, change sharing to commenter (who can't type but can comment), an
// agent edits and comments over the operations API, and preview renders the
// table. Share links: the owner makes an "anyone" link in the share dialog, a
// signed-out visitor continues as a guest (can comment, can't type, can
// rename), a "members" link asks for sign-in and resumes after it, and
// revoking the link ends the guest's access at once. Screenshots (light,
// dark, narrow) go to SMOKE_SHOTS.
//
//   npm run build:web && node scripts/ui-smoke.mjs
//   env: SMOKE_PORT (7366), SMOKE_SHOTS ($TMPDIR/anima-docs-smoke-shots), SMOKE_DATA (temp dir), SMOKE_HEADED=1,
//        SMOKE_SERVER_ROOT (run the server from another checkout; defaults to this repo)

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT ?? 7366);
const ORIGIN = `http://localhost:${PORT}`;
const SHOTS = process.env.SMOKE_SHOTS ?? join(tmpdir(), 'anima-docs-smoke-shots');
const DATA = process.env.SMOKE_DATA ?? mkdtempSync(join(tmpdir(), 'docs-smoke-'));
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

// ------------------------------------------------------------------ helpers

const results = [];
let failed = false;
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`  ✓ ${name} (${Date.now() - t0} ms)`);
    console.log(`✓ ${name}`);
  } catch (e) {
    failed = true;
    results.push(`  ✗ ${name}: ${e.message.split('\n')[0]}`);
    console.error(`✗ ${name}\n${e.stack ?? e}`);
    throw e;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** A small PNG (gradient sky, island, sea), encoded by hand. */
function makePng(w = 480, h = 270) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      let r = 120 + (y / h) * 80, g = 180 + (y / h) * 50, b = 245;
      const sea = h * 0.62 + Math.sin(x / 18) * 3;
      const dx = (x - w * 0.5) / (w * 0.22), dy = (y - sea) / (h * 0.28);
      if (y > sea) { r = 30; g = 100 + (y - sea) / 2; b = 190; }
      if (dx * dx + dy * dy < 1 && y <= sea + 2) { r = 34; g = 170; b = 120; }
      if (Math.hypot(x - w * 0.8, y - h * 0.22) < 22) { r = 255; g = 214; b = 90; }
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function startServer() {
  const busy = await fetch(`${ORIGIN}/health`).then(() => true, () => false);
  if (busy) throw new Error(`Something is already listening on port ${PORT}; stop it or set SMOKE_PORT.`);
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: process.env.SMOKE_SERVER_ROOT ?? root,
    env: { ...process.env, PORT: String(PORT), DOCS_ORIGIN: ORIGIN, DOCS_DATA_DIR: DATA, DOCS_DEV_ISSUER: 'dev.local', DOCS_ISSUERS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(`server exited:\n${log}`);
    try { const r = await fetch(`${ORIGIN}/health`); if (r.ok) return { proc, log: () => log }; } catch { /* not yet */ }
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

async function signIn(page, name, admin = false) {
  await page.goto(`${ORIGIN}/`);
  await page.getByLabel('Your name').fill(name);
  if (admin) await page.getByLabel('Sign in as an administrator').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('main.home h1', { hasText: 'Documents' }).waitFor();
}

async function openDoc(page, id) {
  await page.goto(`${ORIGIN}/d/${id}`);
  await page.locator('.editor-page .cm-content').waitFor();
  await page.locator('.sync-veil').waitFor({ state: 'detached' });
}

const docText = (page, id) => page.evaluate((i) => fetch(`/api/docs/${i}/export.md`).then((r) => r.text()), id);
const editorText = (page) => page.evaluate(() => document.querySelector('.editor-page .cm-content').innerText);

/** Select `text` inside the editor through a DOM range (CodeMirror reads it). */
async function selectInEditor(page, text) {
  await page.evaluate((needle) => {
    const root = document.querySelector('.editor-page .cm-content');
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(needle);
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i); r.setEnd(n, i + needle.length);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        return;
      }
    }
    throw new Error(`text not in editor: ${needle}`);
  }, text);
  await sleep(120);
}

async function shot(page, name, opts = {}) {
  await sleep(opts.settle ?? 350);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false, ...opts.shot });
}

// ------------------------------------------------------------------ run

const server = await startServer();
const browser = await chromium.launch({ headless: !process.env.SMOKE_HEADED });
const viewport = { width: 1440, height: 900 };
const aliceCtx = await browser.newContext({ viewport, colorScheme: 'light' });
const bobCtx = await browser.newContext({ viewport, colorScheme: 'light' });
const alice = await aliceCtx.newPage();
const bob = await bobCtx.newPage();
watch(alice, 'alice'); watch(bob, 'bob');
let docId = '';

try {
  await step('sign-in page renders (dev issuer)', async () => {
    const p = await browser.newPage({ viewport });
    await p.goto(`${ORIGIN}/`);
    await p.getByLabel('Your name').waitFor();
    await shot(p, '01-signin-light');
    await p.close();
  });

  await step('two people sign in via the dev form', async () => {
    await signIn(bob, 'Bob Rivera');
    await signIn(alice, 'Alice Chen', true);
    await shot(alice, '02-home-empty-light');
  });

  await step('Alice creates a document from the New document dialog', async () => {
    await alice.getByRole('button', { name: 'New document' }).first().click();
    await alice.getByLabel('Title').fill('Q4 Launch Plan');
    await shot(alice, '03-new-doc-dialog');
    await alice.getByRole('button', { name: 'Create' }).click();
    await alice.waitForURL(/\/d\/[A-Za-z0-9]+$/);
    docId = new URL(alice.url()).pathname.split('/').pop();
    await alice.locator('.sync-veil').waitFor({ state: 'detached' });
    assert(await alice.locator('.doc-title').inputValue() === 'Q4 Launch Plan', 'title shown in header');
  });

  await step('Alice writes markdown (headings, emphasis, lists, tasks)', async () => {
    await alice.locator('.editor-page .cm-content').click();
    await alice.keyboard.insertText([
      '# Q4 Launch Plan',
      '',
      'The launch moves the **Archipelago** beta to general availability. This plan covers *scope*, owners and the review cadence, and links the [runbook](https://example.com/runbook).',
      '',
      '## Goals',
      '',
      '- Ship the collaborative editor to every workspace',
      '- Cut median sync latency below 80 ms',
      '- [x] Finish the security review',
      '- [ ] Publish the agent integration guide',
      '',
      '> Agents and people edit the same text; comments are where decisions get made.',
      '',
      '## Timeline',
      '',
      'Dates below are targets, not commitments.',
      '',
    ].join('\n'));
    await alice.waitForFunction(() => document.querySelector('.cm-h1') && document.querySelector('.cm-task-checkbox'));
  });

  await step('Alice shares with Bob as editor (share dialog + people autocomplete)', async () => {
    await alice.locator('.share-btn').click();
    const dlg = alice.locator('dialog.share-dialog');
    await dlg.waitFor();
    await dlg.getByLabel('Add people or agents').fill('Bob');
    await dlg.locator('.picker-option', { hasText: 'Bob Rivera' }).click();
    await dlg.locator('.share-row', { hasText: 'Bob Rivera' }).waitFor();
    await shot(alice, '04-share-dialog-light');
    await dlg.getByRole('button', { name: 'Done' }).click();
  });

  await step('Bob opens the document and sees the content', async () => {
    await openDoc(bob, docId);
    await bob.waitForFunction(() => document.querySelector('.editor-page .cm-content')?.innerText.includes('general availability'));
  });

  await step('both edit concurrently and see each other’s text', async () => {
    await alice.locator('.editor-page .cm-content').click();
    await alice.keyboard.press('ControlOrMeta+End');
    await bob.locator('.cm-line', { hasText: 'Dates below are targets' }).click();
    await bob.keyboard.press('End');
    await Promise.all([
      alice.keyboard.type('Owners confirm dates in the review on Thursday.', { delay: 12 }),
      bob.keyboard.type(' Bob checks these with finance.', { delay: 14 }),
    ]);
    for (const p of [alice, bob]) {
      await p.waitForFunction(() => {
        const t = document.querySelector('.editor-page .cm-content').innerText;
        return t.includes('Owners confirm dates in the review on Thursday.') && t.includes('Bob checks these with finance.');
      }, null, { timeout: 8000 });
    }
    const server = await docText(alice, docId);
    assert(server.includes('Bob checks these with finance.') && server.includes('review on Thursday'), 'server has both edits');
  });

  await step('remote cursors are visible on both sides', async () => {
    await alice.locator('.cm-remote-caret').first().waitFor({ timeout: 5000 });
    await bob.locator('.cm-remote-caret').first().waitFor({ timeout: 5000 });
    const flag = await alice.locator('.cm-remote-flag').first().innerText();
    assert(flag.includes('Bob Rivera'), `Alice sees Bob's cursor flag (got ${flag})`);
    await alice.locator('.presence-btn').first().waitFor();
    await shot(alice, '05-concurrent-editing-light', { settle: 50 });
  });

  await step('Alice inserts a table (toolbar) that renders as a table off-cursor', async () => {
    await alice.keyboard.press('ControlOrMeta+End');
    await alice.keyboard.press('Enter');
    await alice.getByRole('button', { name: 'Insert table' }).click();
    await alice.keyboard.type('Milestone');
    await alice.keyboard.press('ControlOrMeta+End');
    // Fill the template through the source while the cursor is inside it.
    const text = await docText(alice, docId);
    assert(text.includes('| Milestone | Column 2 | Column 3 |'), 'table template inserted with typed header');
    await alice.keyboard.insertText('\nThe beta cohort grows each week until launch.\n');
    await alice.locator('.cm-table-widget table').waitFor();
    await bob.locator('.cm-table-widget table').waitFor();
    const headers = await alice.locator('.cm-table-widget th').allInnerTexts();
    assert(headers[0] === 'Milestone' && headers.length === 3, `table header rendered (${headers})`);
  });

  await step('Alice uploads an image; both see it inline', async () => {
    await alice.keyboard.press('ControlOrMeta+End');
    await alice.locator('input.image-file-input').setInputFiles({ name: 'archipelago-map.png', mimeType: 'image/png', buffer: makePng() });
    for (const p of [alice, bob]) {
      await p.waitForFunction(() => [...document.querySelectorAll('.cm-image-figure img')].some((i) => i.complete && i.naturalWidth > 0), null, { timeout: 8000 });
    }
    const text = await docText(alice, docId);
    assert(/!\[archipelago-map\]\(\/media\/[0-9a-f]{32}\.png\)/.test(text), 'image markdown inserted');
  });

  await step('Alice comments on selected text with an @mention of Bob', async () => {
    await alice.locator('.editor-page .cm-content').click();
    await selectInEditor(alice, 'general availability');
    await alice.locator('.comment-fab:not([hidden])').click();
    const draft = alice.locator('.thread-card.draft textarea');
    await draft.waitFor();
    await draft.type('@Bob', { delay: 30 });
    await alice.locator('.mention-option', { hasText: 'Bob Rivera' }).waitFor();
    await shot(alice, '06-comment-mention-autocomplete');
    await alice.keyboard.press('Enter');
    await draft.type('can you confirm GA is still the week of Nov 18?');
    assert((await draft.inputValue()).startsWith('@Bob Rivera '), `mention inserted (${await draft.inputValue()})`);
    await alice.keyboard.press('ControlOrMeta+Enter');
    await alice.locator('.thread-card:not(.draft)').first().waitFor();
    await alice.locator('.cm-comment-hl').first().waitFor();
    await alice.locator('.thread-card .mention', { hasText: '@Bob Rivera' }).waitFor();
  });

  await step('Bob is notified, replies and resolves', async () => {
    await bob.locator('.toast-mention', { hasText: 'mentioned you' }).waitFor({ timeout: 6000 });
    await bob.locator('.cm-comment-hl').first().waitFor();
    await shot(bob, '07-bob-mentioned-toast');
    await bob.locator('.thread-card').first().click();
    const reply = bob.locator('.thread-card.active textarea.reply');
    await reply.waitFor();
    await reply.fill('Confirmed with finance: GA is Nov 18. @Alice Chen');
    await bob.keyboard.press('ControlOrMeta+Enter');
    await alice.locator('.thread-card .comment.reply', { hasText: 'Confirmed with finance' }).waitFor();
    await alice.locator('.thread-card').first().click();
    await shot(alice, '08-thread-with-reply-light');
    await bob.locator('.thread-card.active .resolve-btn').click();
    await alice.waitForFunction(() => !document.querySelector('.comment-rail.margin .thread-card') && !document.querySelector('.cm-comment-hl'), null, { timeout: 6000 });
    await alice.locator('.comments-btn').click();
    await alice.locator('.rail-filter .seg-btn', { hasText: 'Resolved' }).click();
    await alice.locator('.comment-rail.drawer.open .thread-card.resolved', { hasText: 'Resolved by Bob Rivera' }).waitFor();
    await shot(alice, '09-comments-drawer-resolved');
    await alice.locator('.rail-close').click();
  });

  await step('an agent edits and comments; it shows with an agent badge', async () => {
    const mint = await fetch(`${ORIGIN}/dev/token`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ name: 'Quill', kind: 'agent' }) }).then((r) => r.json());
    const op = (name, args) => fetch(`${ORIGIN}/api/operations/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${mint.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) }).then(async (r) => ({ ok: r.ok, body: await r.json() }));
    const who = await op('whoami', {});
    assert(who.ok, `agent whoami: ${JSON.stringify(who.body)}`);
    const shared = await alice.evaluate((id) => fetch(`/api/docs/${id}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ who: '@Quill', role: 'editor' }) }).then((r) => r.ok), docId);
    assert(shared, 'shared with agent');
    const edit = await op('edit_document', { document: docId, edits: [{ insert_after: 'Dates below are targets, not commitments. Bob checks these with finance.', text: '\n\nRisks: the p95 sync latency under load is still unmeasured.' }] });
    assert(edit.ok, `agent edit: ${JSON.stringify(edit.body)}`);
    const c = await op('add_comment', { document: docId, quote: 'Cut median sync latency below 80 ms', text: '@Alice Chen p50 is on track (62 ms in staging). I added a risk line for p95 under the timeline.' });
    assert(c.ok, `agent comment: ${JSON.stringify(c.body)}`);
    await alice.waitForFunction(() => document.querySelector('.editor-page .cm-content').innerText.includes('p95 sync latency under load'));
    await alice.locator('.toast-mention', { hasText: 'Quill' }).waitFor();
    await alice.locator('.thread-card .kind-agent').first().waitFor();
    await alice.locator('.presence-btn .avatar.is-agent').waitFor({ timeout: 5000 });
    await alice.locator('.editor-page .cm-content').click();
    await alice.keyboard.press('ControlOrMeta+Home');
    await sleep(300);
    // Live preview: the line with the cursor shows its markdown; other lines hide it.
    const line1 = await alice.evaluate(() => document.querySelector('.cm-line')?.textContent);
    assert(line1 === '# Q4 Launch Plan', `active heading line shows its # mark (got ${JSON.stringify(line1)})`);
    assert(!(await editorText(alice)).includes('## Goals'), 'inactive heading lines hide their marks');
    await shot(alice, '10-editor-agent-light', { settle: 400 });
  });

  await step('Alice downgrades Bob to commenter; Bob can’t type but can comment', async () => {
    await alice.locator('.share-btn').click();
    const dlg = alice.locator('dialog.share-dialog');
    await dlg.getByLabel('Access for Bob Rivera').selectOption('commenter');
    await alice.waitForFunction(() => [...document.querySelectorAll('dialog.share-dialog .share-row')].some((r) => r.textContent.includes('Bob Rivera') && r.querySelector('select')?.value === 'commenter'));
    await dlg.getByRole('button', { name: 'Done' }).click();
    await bob.locator('.role-pill', { hasText: 'Commenting' }).waitFor({ timeout: 5000 });
    await bob.locator('.toast', { hasText: 'Your access changed' }).waitFor();
    const before = await docText(bob, docId);
    // Lines off-screen aren't rendered (CodeMirror virtualizes): navigate there first.
    await bob.locator('.cm-line', { hasText: 'Dates below are targets' }).click();
    await bob.keyboard.press('ControlOrMeta+End');
    await bob.locator('.cm-line', { hasText: 'The beta cohort grows' }).click();
    await bob.keyboard.type('SHOULD NOT APPEAR');
    await bob.keyboard.press('Enter');
    await sleep(500);
    const after = await docText(bob, docId);
    assert(after === before && !(await editorText(bob)).includes('SHOULD NOT APPEAR'), 'commenter edit was blocked');
    assert(await bob.locator('.edit-tools').isHidden(), 'formatting toolbar hidden for commenter');
    await selectInEditor(bob, 'The beta cohort grows each week');
    await bob.locator('.comment-fab:not([hidden])').click();
    await bob.locator('.thread-card.draft textarea').fill('Should we cap the cohort size the week before launch?');
    await bob.keyboard.press('ControlOrMeta+Enter');
    await alice.locator('.thread-card', { hasText: 'cap the cohort size' }).waitFor({ timeout: 6000 });
    await shot(bob, '11-commenter-view-light');
  });

  await step('preview renders the table, task list and image', async () => {
    await alice.getByRole('radio', { name: 'Preview mode' }).click();
    await alice.locator('.preview-body table tbody tr').first().waitFor();
    const th = await alice.locator('.preview-body table th').first().innerText();
    assert(th === 'Milestone', `preview table header (${th})`);
    await alice.locator('.preview-body .task-checkbox').first().waitFor();
    await alice.waitForFunction(() => [...document.querySelectorAll('.preview-body img')].some((i) => i.complete && i.naturalWidth > 0));
    await shot(alice, '12-preview-light');
    await alice.getByRole('radio', { name: 'Split view' }).click();
    await alice.locator('.preview-pane').waitFor();
    await shot(alice, '13-split-light');
    await alice.getByRole('radio', { name: 'Edit mode' }).click();
  });

  await step('version history: name a version, view it; activity panel', async () => {
    await alice.getByRole('button', { name: 'More document actions' }).click();
    await alice.getByRole('menuitem', { name: 'Version history' }).click();
    await alice.getByLabel('Version name').fill('Ready for review');
    await alice.getByRole('button', { name: 'Save', exact: true }).click();
    await alice.locator('.version-item', { hasText: 'Ready for review' }).waitFor();
    await shot(alice, '14-version-history');
    await alice.locator('.version-item', { hasText: 'Ready for review' }).getByRole('button', { name: 'View' }).click();
    await alice.locator('dialog.version-dialog .prose table').waitFor();
    await shot(alice, '15-version-view');
    await alice.locator('dialog.version-dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await alice.getByRole('button', { name: 'More document actions' }).click();
    await alice.getByRole('menuitem', { name: 'Activity' }).click();
    await alice.locator('.activity-person', { hasText: 'Quill' }).waitFor();
    await alice.locator('.activity-person', { hasText: 'Bob Rivera' }).waitFor();
    await shot(alice, '16-activity');
    await alice.getByRole('button', { name: 'Close panel' }).click();
  });

  await step('home list shows owner, comments and live presence; people & admin pages', async () => {
    await alice.goto(`${ORIGIN}/`);
    const row = alice.locator('.doc-row', { hasText: 'Q4 Launch Plan' });
    await row.waitFor();
    await row.locator('.comment-count').waitFor();
    await alice.waitForFunction(() => document.querySelector('.doc-row .row-presence'), null, { timeout: 20000 });
    await shot(alice, '17-home-light');
    await alice.goto(`${ORIGIN}/people`);
    await alice.locator('.person-card', { hasText: 'Quill' }).locator('.kind-agent').waitFor();
    await shot(alice, '18-people-light');
    await alice.goto(`${ORIGIN}/admin`);
    await alice.locator('.admin-table tr', { hasText: 'Bob Rivera' }).waitFor();
    await shot(alice, '19-admin-light');
  });

  await step('dark mode: home, editor with comments, share dialog', async () => {
    const dark = await browser.newContext({ viewport, colorScheme: 'dark' });
    await dark.addCookies(await aliceCtx.cookies());
    const p = await dark.newPage();
    watch(p, 'alice-dark');
    await p.goto(`${ORIGIN}/`);
    await p.locator('.doc-row', { hasText: 'Q4 Launch Plan' }).waitFor();
    await shot(p, '20-home-dark');
    await openDoc(p, docId);
    await p.locator('.comment-rail.margin .thread-card').first().waitFor();
    await p.locator('.thread-card', { hasText: 'p50 is on track' }).click();
    await shot(p, '21-editor-dark');
    await p.locator('.share-btn').click();
    await p.locator('dialog.share-dialog .share-row').nth(1).waitFor();
    await shot(p, '22-share-dark');
    await p.keyboard.press('Escape');
    await p.getByRole('radio', { name: 'Preview mode' }).click();
    await p.locator('.preview-body table').waitFor();
    await shot(p, '23-preview-dark');
    await p.getByRole('radio', { name: 'Edit mode' }).click();
    const sp = await dark.newPage();
    await sp.goto(`${ORIGIN}/`);
    await sp.close();
    await dark.close();
  });

  await step('narrow window: comments collapse into a drawer', async () => {
    const narrow = await browser.newContext({ viewport: { width: 760, height: 1000 }, colorScheme: 'light' });
    await narrow.addCookies(await aliceCtx.cookies());
    const p = await narrow.newPage();
    watch(p, 'alice-narrow');
    await openDoc(p, docId);
    assert(await p.locator('.comment-rail.drawer').count() === 1, 'rail is a drawer when narrow');
    await shot(p, '24-narrow-editor');
    await p.locator('.comments-btn').click();
    await p.locator('.comment-rail.drawer.open .thread-card').first().waitFor();
    await shot(p, '25-narrow-drawer');
    await p.goto(`${ORIGIN}/`);
    await p.locator('.doc-row', { hasText: 'Q4 Launch Plan' }).waitFor();
    await shot(p, '26-narrow-home');
    await narrow.close();
  });

  await step('a deleted document sends open readers home (ws 4004)', async () => {
    const scratch = await alice.evaluate(async () => {
      const d = await fetch('/api/docs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Scratch notes', content: '# Scratch\n\nTemporary.' }) }).then((r) => r.json());
      await fetch(`/api/docs/${d.id}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ who: '@Bob Rivera', role: 'viewer' }) });
      return d.id;
    });
    await openDoc(bob, scratch);
    await bob.locator('.role-pill', { hasText: 'Viewing' }).waitFor();
    assert(await bob.locator('.tb-comment').isHidden(), 'viewer has no comment button');
    await alice.evaluate((id) => fetch(`/api/docs/${id}`, { method: 'DELETE' }), scratch);
    await bob.waitForURL(`${ORIGIN}/`);
    await bob.locator('.toast', { hasText: 'was deleted' }).waitFor();
  });

  await step('signing out elsewhere ends the live session (ws 4001 → sign-in)', async () => {
    await openDoc(bob, docId);
    const other = await bobCtx.newPage();
    await other.goto(`${ORIGIN}/`);
    await other.evaluate(() => fetch('/auth/logout', { method: 'POST' }));
    await bob.getByLabel('Your name').waitFor({ timeout: 8000 });
    await other.close();
  });

  // ---------------------------------------------------------------- share links & guests

  let anyoneUrl = '';
  let membersUrl = '';
  let guestCtx = null;
  let guest = null;

  await step('owner creates an “anyone” commenter link in the share dialog (copied on create)', async () => {
    await aliceCtx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
    await openDoc(alice, docId);
    assert(!(await alice.locator('.share-btn').getAttribute('class')).includes('public'), 'no public link yet');
    await alice.locator('.share-btn').click();
    const dlg = alice.locator('dialog.share-dialog');
    await dlg.locator('.share-links .link-empty').waitFor();
    await dlg.getByRole('button', { name: 'Create link' }).click();
    const form = dlg.locator('.link-form');
    await form.getByRole('radio', { name: 'Anyone with the link' }).click();
    await form.getByLabel('Link access').selectOption('commenter');
    await form.getByLabel('Link label').fill('Launch reviewers');
    await shot(alice, '30-share-link-form-light');
    await form.getByRole('button', { name: 'Create link' }).click();
    const row = dlg.locator('.link-row[data-who="anyone"]');
    await row.waitFor();
    const rowText = await row.innerText();
    assert(rowText.includes('Anyone with the link') && rowText.includes('can comment') && rowText.includes('Launch reviewers') && rowText.includes('Not opened yet'), `link row (${rowText})`);
    await alice.locator('.toast', { hasText: 'Link created and copied' }).waitFor();
    anyoneUrl = await alice.evaluate(() => navigator.clipboard.readText());
    assert(new RegExp(`^${ORIGIN}/l/[A-Za-z0-9_-]{20,40}$`).test(anyoneUrl), `copied link url (${anyoneUrl})`);
    const { links } = await alice.evaluate((id) => fetch(`/api/docs/${id}/links`).then((r) => r.json()), docId);
    assert(links.some((l) => l.url === anyoneUrl && l.role === 'commenter' && l.who === 'anyone'), 'server has the link');
    await shot(alice, '31-share-dialog-link-light');
    await dlg.getByRole('button', { name: 'Done' }).click();
    await alice.locator('.share-btn.public').waitFor();
    assert((await alice.locator('.share-btn').getAttribute('data-tip')).includes('Anyone with a link can open this'), 'share button tip');
  });

  await step('a signed-out visitor opens the link and continues as a guest', async () => {
    guestCtx = await browser.newContext({ viewport, colorScheme: 'light' });
    guest = await guestCtx.newPage();
    watch(guest, 'guest');
    await guest.goto(anyoneUrl);
    await guest.locator('.link-card .link-doc-title', { hasText: 'Q4 Launch Plan' }).waitFor();
    assert((await guest.locator('.link-card').innerText()).includes('Anyone with the link can comment'), 'landing says what the link allows');
    await guest.getByRole('button', { name: 'Sign in with Archipelago' }).waitFor();
    await shot(guest, '32-link-landing-light');
    await guest.getByRole('button', { name: 'Continue as guest' }).click();
    await guest.waitForURL(`${ORIGIN}/d/${docId}`);
    await guest.locator('.sync-veil').waitFor({ state: 'detached' });
    await guest.locator('.role-pill', { hasText: 'Commenting' }).waitFor();
    const who = await guest.locator('.user-chip').getAttribute('aria-label');
    assert(/^Account: Anonymous .+ \(guest\)$/.test(who), `guest identity shown (${who})`);
    assert(await guest.locator('.share-btn').count() === 0, 'no share button for guests');
    await guest.locator('.doc-header .guest-signin').waitFor();
  });

  await step('the guest can’t type but can comment; the owner sees the guest’s comment', async () => {
    const before = await docText(guest, docId);
    await guest.locator('.cm-line', { hasText: 'Dates below are targets' }).click();
    await guest.keyboard.type('GUEST SHOULD NOT TYPE');
    await guest.keyboard.press('Enter');
    await sleep(500);
    assert((await docText(guest, docId)) === before && !(await editorText(guest)).includes('GUEST SHOULD NOT TYPE'), 'guest typing was blocked');
    assert(await guest.locator('.edit-tools').isHidden(), 'formatting toolbar hidden for a commenting guest');
    await selectInEditor(guest, 'Dates below are targets');
    await guest.locator('.comment-fab:not([hidden])').click();
    const draft = guest.locator('.thread-card.draft textarea');
    await draft.waitFor();
    // Mentions degrade quietly: no directory lookup, only people already seen in this document.
    const peopleCalls = [];
    guest.on('request', (r) => { if (new URL(r.url()).pathname === '/api/people') peopleCalls.push(r.url()); });
    await draft.type('@Al', { delay: 20 });
    await guest.locator('.mention-option', { hasText: 'Alice Chen' }).waitFor();
    await guest.keyboard.press('Escape');
    assert(peopleCalls.length === 0, `guests don't query the directory (${peopleCalls})`);
    await draft.fill('Guest here: are these dates final for the press release?');
    await guest.keyboard.press('ControlOrMeta+Enter');
    await guest.locator('.thread-card:not(.draft)', { hasText: 'press release' }).waitFor();
    const card = alice.locator('.thread-card', { hasText: 'press release' });
    await card.waitFor({ timeout: 6000 });
    await card.locator('.kind-guest').waitFor();
    await card.click();
    await guest.locator('.thread-card', { hasText: 'press release' }).click();
    const menu = guest.locator('.thread-card.active .comment.root').getByRole('button', { name: 'More comment actions' });
    await menu.click();
    assert(await guest.getByRole('menuitem', { name: /Assign/ }).count() === 0, 'guests can’t assign comments');
    await guest.keyboard.press('Escape');
    await shot(alice, '33-owner-sees-guest-comment');
    await shot(guest, '34-guest-editor-light');
  });

  await step('the guest renames themselves; the owner sees the new name', async () => {
    await guest.locator('.user-chip').click();
    await guest.getByRole('menuitem', { name: 'Change your name…' }).click();
    await guest.getByLabel('Your name').fill('Sam Lee');
    await shot(guest, '35-guest-rename-dialog');
    await guest.getByRole('button', { name: 'Save' }).click();
    await guest.locator('.toast', { hasText: 'Sam Lee (guest)' }).waitFor();
    assert((await guest.locator('.user-chip').getAttribute('aria-label')) === 'Account: Sam Lee (guest)', 'chip shows the new name');
    await alice.waitForFunction(() => [...document.querySelectorAll('.presence-btn')].some((b) => (b.getAttribute('data-tip') ?? '').includes('Sam Lee (guest)')), null, { timeout: 6000 });
  });

  await step('guest home lists linked documents; member-only pages and APIs are closed', async () => {
    await guest.goto(`${ORIGIN}/`);
    await guest.locator('.doc-row', { hasText: 'Q4 Launch Plan' }).waitFor();
    await guest.locator('.home-sub', { hasText: 'share links' }).waitFor();
    assert(await guest.getByRole('button', { name: 'New document' }).count() === 0, 'guests can’t create documents');
    assert(await guest.locator('.nav-link', { hasText: 'People' }).count() === 0, 'no People link for guests');
    await guest.locator('.topbar .guest-signin').waitFor();
    await shot(guest, '36-guest-home-light');
    await guest.goto(`${ORIGIN}/people`);
    await guest.locator('.empty-title', { hasText: 'Sign in to see this page' }).waitFor();
    await shot(guest, '36b-guest-members-only-page');
    const status = await guest.evaluate(() => fetch('/api/people').then((r) => r.status));
    assert(status === 403, `people API refuses guests (${status})`);
  });

  await step('a “members” link asks a signed-out visitor to sign in, then opens', async () => {
    await alice.locator('.share-btn').click();
    const dlg = alice.locator('dialog.share-dialog');
    await dlg.locator('.link-row').first().waitFor();
    await dlg.getByRole('button', { name: 'Create link' }).click();
    const form = dlg.locator('.link-form');
    assert((await form.getByRole('radio', { name: 'Archipelago members' }).getAttribute('aria-checked')) === 'true', 'members is the default');
    await form.getByLabel('Link access').selectOption('editor');
    await form.getByLabel('Link expiry').selectOption('7');
    await form.getByRole('button', { name: 'Create link' }).click();
    const row = dlg.locator('.link-row[data-who="members"]');
    await row.waitFor();
    assert(/Expires (in \d+ hours|[A-Z][a-z]{2} \d+)/.test(await row.innerText()), `expiry shown (${await row.innerText()})`);
    membersUrl = await alice.evaluate(() => navigator.clipboard.readText());
    assert(membersUrl !== anyoneUrl && /\/l\//.test(membersUrl), 'members link copied');
    assert((await dlg.locator('.link-row[data-who="anyone"]').innerText()).includes('Opened by 1 person'), 'opened count');
    await shot(alice, '37-share-dialog-two-links-light');
    await dlg.getByRole('button', { name: 'Done' }).click();

    const visitorCtx = await browser.newContext({ viewport, colorScheme: 'light' });
    const v = await visitorCtx.newPage();
    watch(v, 'visitor');
    await v.goto(membersUrl);
    await v.locator('.link-card h1', { hasText: 'Sign in with Archipelago to open this document' }).waitFor();
    assert(!(await v.locator('.link-card').innerText()).includes('Q4 Launch Plan'), 'members links don’t reveal the title');
    await shot(v, '38-link-members-signin-light');
    await v.getByRole('button', { name: 'Sign in with Archipelago' }).click();
    await v.getByLabel('Your name').fill('Carol Diaz');
    await v.getByRole('button', { name: 'Continue' }).click();
    await v.waitForURL(`${ORIGIN}/d/${docId}`);
    await v.locator('.role-pill', { hasText: 'Editing' }).waitFor();
    // An editor (not the owner) sees only their own links and can't make "anyone" links.
    await v.locator('.share-btn').click();
    const vdlg = v.locator('dialog.share-dialog');
    await vdlg.locator('.share-links .link-empty').waitFor();
    assert(await vdlg.locator('.link-row').count() === 0, 'non-owners see only links they made');
    await vdlg.getByRole('button', { name: 'Create link' }).click();
    const anyoneOpt = vdlg.locator('.link-form').getByRole('radio', { name: 'Anyone with the link' });
    assert((await anyoneOpt.getAttribute('aria-disabled')) === 'true', '“Anyone” is owner-only');
    assert((await anyoneOpt.getAttribute('data-tip')).includes('Only the owner'), 'explains why');
    await anyoneOpt.click({ force: true }); // aria-disabled: a click only nudges the explanation
    assert((await vdlg.locator('.link-form').getByRole('radio', { name: 'Archipelago members' }).getAttribute('aria-checked')) === 'true', 'stays on members');
    await shot(v, '38b-share-links-editor');
    await visitorCtx.close();
    // A guest can't use a members link.
    await guest.goto(membersUrl);
    await guest.locator('.link-card h1', { hasText: 'Sign in with Archipelago' }).waitFor();
    assert((await guest.locator('.link-card').innerText()).includes('Sam Lee (guest)'), 'tells the guest who they are');
  });

  await step('revoking the “anyone” link ends the guest’s access at once', async () => {
    await openDoc(guest, docId);
    await guest.locator('.role-pill', { hasText: 'Commenting' }).waitFor();
    await alice.locator('.share-btn').click();
    const dlg = alice.locator('dialog.share-dialog');
    const row = dlg.locator('.link-row[data-who="anyone"]');
    await row.waitFor();
    await row.getByRole('button', { name: /^Revoke link/ }).click();
    await alice.locator('dialog', { hasText: 'Turn off this link?' }).waitFor();
    await shot(alice, '39-revoke-confirm');
    await alice.getByRole('button', { name: 'Turn off', exact: true }).click();
    await row.waitFor({ state: 'detached' });
    await alice.locator('.toast', { hasText: 'Link turned off' }).waitFor();
    await guest.locator('.overlay-card', { hasText: 'This link was turned off' }).waitFor({ timeout: 6000 });
    await shot(guest, '40-guest-access-removed');
    await dlg.getByRole('button', { name: 'Done' }).click();
    await alice.waitForFunction(() => !document.querySelector('.share-btn.public'));
    await guest.goto(anyoneUrl);
    await guest.locator('.link-card h1', { hasText: 'This link no longer works' }).waitFor();
    await shot(guest, '41-link-dead');
    await guest.goto(`${ORIGIN}/d/${docId}`);
    await guest.locator('.empty-title', { hasText: 'isn’t available' }).waitFor();
  });

  await step('admins can show guests (to block one)', async () => {
    await alice.goto(`${ORIGIN}/admin`);
    await alice.locator('.admin-table tr', { hasText: 'Bob Rivera' }).waitFor();
    assert(await alice.locator('.admin-table tr.guest').count() === 0, 'guests hidden by default');
    await alice.getByLabel('Show guests').check();
    await alice.locator('.admin-table tr.guest', { hasText: 'Sam Lee' }).waitFor();
    await shot(alice, '42-admin-guests');
  });

  await step('share links in dark mode and on a phone', async () => {
    const dark = await browser.newContext({ viewport, colorScheme: 'dark' });
    await dark.addCookies(await aliceCtx.cookies());
    const p = await dark.newPage();
    watch(p, 'alice-dark-links');
    await openDoc(p, docId);
    const link = await p.evaluate((id) => fetch(`/api/docs/${id}/links`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ who: 'anyone', role: 'viewer', label: 'Press kit' }) }).then((r) => r.json()), docId);
    await p.locator('.share-btn').click();
    await p.locator('dialog.share-dialog .link-row[data-who="anyone"]').waitFor();
    await p.getByRole('button', { name: 'Create link' }).click();
    await shot(p, '43-share-links-dark');
    await p.keyboard.press('Escape');
    await p.keyboard.press('Escape');
    await p.goto(`${ORIGIN}/`);
    await p.locator('.doc-row', { hasText: 'Q4 Launch Plan' }).locator('.access-chip.public').waitFor();
    await shot(p, '48-home-public-link-dark');
    await dark.close();
    const phone = { width: 390, height: 844 };
    for (const [name, editorShot, ctxOpts] of [
      ['44-link-landing-dark', '46-guest-editor-dark', { viewport, colorScheme: 'dark' }],
      ['45-link-landing-phone', '47-guest-editor-phone', { viewport: phone, colorScheme: 'light' }],
    ]) {
      const c = await browser.newContext(ctxOpts);
      const v = await c.newPage();
      watch(v, name);
      await v.goto(link.url);
      await v.locator('.link-card .link-doc-title').waitFor();
      await v.getByLabel('Your name (optional)').fill('Rae');
      await shot(v, name);
      const sideways = () => v.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      if (name.endsWith('phone')) assert(!(await sideways()), 'no sideways scroll on a phone (landing)');
      // ...and the document as that guest (a viewer link): read-only, no share button.
      await v.getByRole('button', { name: 'Continue as guest' }).click();
      await v.waitForURL(`${ORIGIN}/d/${docId}`);
      await v.locator('.sync-veil').waitFor({ state: 'detached' });
      await v.locator('.role-pill', { hasText: 'Viewing' }).waitFor();
      assert((await v.locator('.user-chip').getAttribute('aria-label')) === 'Account: Rae (guest)', 'guest chose their name on the way in');
      await shot(v, editorShot);
      if (name.endsWith('phone')) assert(!(await sideways()), 'no sideways scroll on a phone (editor)');
      await c.close();
    }
    const phoneCtx = await browser.newContext({ viewport: phone, colorScheme: 'light' });
    await phoneCtx.addCookies(await aliceCtx.cookies());
    const ph = await phoneCtx.newPage();
    watch(ph, 'alice-phone');
    await openDoc(ph, docId);
    await ph.locator('.share-btn').click();
    await ph.locator('dialog.share-dialog .link-row').first().waitFor();
    await ph.getByRole('button', { name: 'Create link' }).click();
    await ph.locator('dialog.share-dialog .link-form').scrollIntoViewIfNeeded();
    await shot(ph, '49-share-links-phone');
    assert(await ph.evaluate(() => { const c = document.querySelector('dialog.share-dialog .dialog-body'); return c.scrollWidth <= c.clientWidth; }), 'share dialog fits a phone');
    await phoneCtx.close();
    await guestCtx.close();
  });

  await step('no uncaught errors in any page', async () => {
    assert(consoleErrors.length === 0, `errors:\n${consoleErrors.join('\n')}`);
  });
} catch {
  try { await alice.screenshot({ path: join(SHOTS, 'FAIL-alice.png') }); await bob.screenshot({ path: join(SHOTS, 'FAIL-bob.png') }); } catch { /* ignore */ }
  if (consoleErrors.length) console.error(`page errors:\n${consoleErrors.slice(0, 12).join('\n')}`);
  console.error(`server exit code: ${server.proc.exitCode}; server log tail:\n${server.log().split('\n').slice(-40).join('\n')}`);
} finally {
  await browser.close().catch(() => undefined);
  server.proc.kill('SIGTERM');
  await sleep(300);
  if (server.proc.exitCode === null) server.proc.kill('SIGKILL');
  if (!process.env.SMOKE_DATA) rmSync(DATA, { recursive: true, force: true });
  writeFileSync(join(SHOTS, 'RESULT.txt'), `${failed ? 'FAILED' : 'PASSED'}\n${results.join('\n')}\n`);
  console.log(`\n${failed ? 'FAILED' : 'PASSED'} — ${results.length} steps; screenshots in ${SHOTS}`);
  process.exit(failed ? 1 : 0);
}
