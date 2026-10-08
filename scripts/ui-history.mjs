#!/usr/bin/env node
// End-to-end test of recorded history in a real headless browser.
//
// Alice types in stretches (the server runs with short checkpoint timings),
// so the Activity panel lists several changes. She opens one and sees its
// diff, undoes a single change while later ones stay, compares a range, and
// restores the document to before it. Then she pings a connected agent about
// the selected text. Screenshots go to HISTORY_SHOTS.
//
//   npm run build:web && node scripts/ui-history.mjs
//   env: HISTORY_PORT (7369), HISTORY_SHOTS ($TMPDIR/anima-docs-history-shots), SMOKE_HEADED=1

import { chromium } from 'playwright';
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.HISTORY_PORT ?? 7369);
const ORIGIN = `http://localhost:${PORT}`;
const SHOTS = process.env.HISTORY_SHOTS ?? join(tmpdir(), 'anima-docs-history-shots');
const DATA = mkdtempSync(join(tmpdir(), 'docs-history-'));
mkdirSync(SHOTS, { recursive: true });

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`  ✓ ${name} (${Date.now() - t0} ms)`);
    console.log(`✓ ${name}`);
  } catch (e) {
    results.push(`  ✗ ${name}: ${e.message.split('\n')[0]}`);
    console.error(`✗ ${name}\n${e.stack ?? e}`);
    throw e;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function startServer() {
  const busy = await fetch(`${ORIGIN}/health`).then(() => true, () => false);
  if (busy) throw new Error(`Something is already listening on port ${PORT}.`);
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), DOCS_ORIGIN: ORIGIN, DOCS_DATA_DIR: DATA, DOCS_DEV_ISSUER: 'dev.local', DOCS_ISSUERS: '',
      DOCS_HISTORY_IDLE_MS: '900', DOCS_HISTORY_AGENT_IDLE_MS: '500', DOCS_HISTORY_MAX_MS: '2500' },
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
  page.on('console', (m) => { if ((m.type() === 'error' && !/Failed to load resource/.test(m.text())) || /\[suggest\]/.test(m.text())) consoleErrors.push(`[${who}] console: ${m.text()}`); });
}

async function signIn(page, name) {
  await page.goto(`${ORIGIN}/`);
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('main.home h1', { hasText: 'Documents' }).waitFor();
}
async function openDoc(page, id) {
  await page.goto(`${ORIGIN}/d/${id}`);
  await page.locator('.editor-page .cm-content').waitFor();
  await page.locator('.sync-veil').waitFor({ state: 'detached' });
}
const docText = (page, id) => page.evaluate((i) => fetch(`/api/docs/${i}/export.md`).then((r) => r.text()), id);
/** The editor's own text (CodeMirror state), which differs from the document while suggesting. */
const viewText = (page) => page.evaluate(() => document.querySelector('.editor-page .cm-content').cmTile.root.view.state.doc.toString());
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
/** Put the caret right after `text` in the editor. */
async function caretAfter(page, text) {
  await page.evaluate((needle) => {
    const view = document.querySelector('.editor-page .cm-content').cmTile.root.view;
    const doc = view.state.doc.toString();
    const i = doc.indexOf(needle);
    if (i < 0) throw new Error(`text not in editor: ${needle}`);
    view.focus();
    view.dispatch({ selection: { anchor: i + needle.length } });
  }, text);
  await sleep(60);
}
async function shot(page, name) { await sleep(350); await page.screenshot({ path: join(SHOTS, `${name}.png`) }); }
const threads = (page) => page.evaluate((id) => new Promise((resolve) => {
  // Ask the server over a fresh socket for the authoritative thread list.
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?doc=${id}`);
  ws.onmessage = (e) => { if (typeof e.data === 'string') { const m = JSON.parse(e.data); if (m.type === 'threads') { ws.close(); resolve(m.threads); } } };
}), docIdGlobal);
let docIdGlobal = '';

const server = await startServer();
const browser = await chromium.launch({ headless: !process.env.SMOKE_HEADED });
const viewport = { width: 1440, height: 900 };
const ctx = await browser.newContext({ viewport, colorScheme: 'light' });
const alice = await ctx.newPage();
watch(alice, 'alice');
let docId = '';

async function openActivity() {
  await alice.getByRole('button', { name: 'More document actions' }).click();
  await alice.getByRole('menuitem', { name: 'Activity' }).click();
  await alice.locator('.side-panel.open .change-list, .side-panel.open .empty-state').first().waitFor();
}
const rows = () => alice.locator('.side-panel.open .change-row');

try {
  await step('Alice creates a document and types in three stretches', async () => {
    await signIn(alice, 'Alice Chen');
    const d = await alice.evaluate(() => fetch('/api/docs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Field notes', content: '# Field notes\n\nThe river was high.\n' }) }).then((r) => r.json()));
    docId = docIdGlobal = d.id;
    await openDoc(alice, docId);
    await sleep(1200); // the creation stretch closes
    await caretAfter(alice, 'The river was high.');
    await alice.keyboard.type('\n\nWe counted forty herons.');
    await sleep(1200); // a pause: checkpoint
    await caretAfter(alice, 'forty herons.');
    await alice.keyboard.press('Enter');
    await alice.keyboard.press('Enter');
    // Continuous typing longer than the longest stretch: split into more than one change.
    for (const w of 'The water was brown and fast, carrying branches past the old mill all afternoon.'.split(/(?<= )/)) { await alice.keyboard.type(w); await sleep(260); }
    await sleep(1200);
  });

  await step('the Activity panel lists the changes, newest first', async () => {
    await openActivity();
    const n = await rows().count();
    assert(n >= 4, `expected at least 4 changes, got ${n}`);
    await alice.locator('.side-panel.open .change-start').waitFor();
    await shot(alice, '01-activity-changes');
  });

  await step('opening a change shows its diff with the changed words marked', async () => {
    // The herons stretch: the second-oldest change (the oldest is the creation).
    const herons = rows().nth((await rows().count()) - 2);
    await herons.click();
    const dlg = alice.locator('dialog.diff-dialog');
    await dlg.locator('.diff-view .dl.add').first().waitFor();
    const text = await dlg.locator('.diff-view').innerText();
    assert(text.includes('We counted forty herons.'), `diff shows the added sentence: ${text.slice(0, 300)}`);
    assert(!text.includes('carrying branches'), 'and not later changes');
    await shot(alice, '02-single-diff');
    await dlg.getByRole('button', { name: 'Close' }).last().click();
  });

  await step('undo one change: the herons go, the later sentence stays', async () => {
    await rows().nth((await rows().count()) - 2).click();
    const dlg = alice.locator('dialog.diff-dialog');
    await dlg.locator('.diff-view').waitFor();
    await dlg.getByRole('button', { name: 'Undo this change' }).click();
    await alice.locator('dialog').getByRole('button', { name: 'Undo change' }).click();
    await alice.locator('.toast', { hasText: 'Change undone' }).waitFor();
    const t = await docText(alice, docId);
    assert(!t.includes('forty herons') && t.includes('carrying branches'), `after undo: ${JSON.stringify(t)}`);
  });

  await step('compare a range of changes', async () => {
    await sleep(1200);
    await alice.locator('.side-panel.open').getByRole('button', { name: 'Refresh' }).click();
    await rows().first().waitFor();
    await alice.locator('.side-panel.open').getByRole('button', { name: 'Compare' }).click();
    const count = await rows().count();
    await rows().nth(count - 1).click(); // the oldest (creation)
    await rows().nth(1).click();         // a recent one
    await alice.locator('.side-panel.open').getByRole('button', { name: 'Compare', exact: true }).click();
    const dlg = alice.locator('dialog.diff-dialog');
    await dlg.locator('.diff-view').waitFor();
    assert((await dlg.locator('.dialog-title, h2').first().innerText()).match(/\d+ changes/), 'range title');
    await shot(alice, '03-range-diff');
    await dlg.getByRole('button', { name: 'Close' }).last().click();
  });

  await step('restore to before a change: the document goes back', async () => {
    const count = await rows().count();
    await rows().nth(count - 2).click(); // the herons stretch (second oldest)
    const dlg = alice.locator('dialog.diff-dialog');
    await dlg.locator('.diff-view').waitFor();
    await dlg.getByRole('button', { name: 'Restore to before' }).click();
    await alice.locator('dialog').getByRole('button', { name: 'Restore', exact: true }).click();
    await alice.locator('.toast', { hasText: 'Restored' }).waitFor();
    const t = await docText(alice, docId);
    assert(t === '# Field notes\n\nThe river was high.\n', `restored: ${JSON.stringify(t)}`);
    await alice.waitForFunction(() => !document.querySelector('.editor-page .cm-content').innerText.includes('branches'));
  });

  await step('the restore is itself a change, labelled, and By person still sums up editing', async () => {
    await sleep(300);
    await alice.locator('.side-panel.open').getByRole('button', { name: 'Refresh' }).click();
    await alice.locator('.side-panel.open .change-label', { hasText: /Restored to just before the change at/ }).waitFor();
    await alice.locator('.side-panel.open .change-label', { hasText: /Undid the change at/ }).waitFor();
    await alice.locator('.side-panel.open').getByRole('tab', { name: 'By person' }).click();
    await alice.locator('.side-panel.open .activity-person', { hasText: 'Alice Chen' }).waitFor();
    await shot(alice, '04-after-restore');
  });

  await step('Alice pings a connected agent about the selected text; it arrives as an addressed event', async () => {
    const mint = await fetch(`${ORIGIN}/dev/token`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ name: 'Quill', kind: 'agent' }) }).then((r) => r.json());
    // A minimal MCPL host for the agent, so it is online and receives pushes.
    const ws = new WebSocket(`ws://localhost:${PORT}/mcpl?token=${encodeURIComponent(mint.token)}`);
    const pushes = []; const wait = new Map(); let id = 0;
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.method === 'push/event') { pushes.push(m.params); ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { accepted: true } })); return; }
      if (wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
    });
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    const call = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method, params })); });
    try {
      await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'ui', version: '0' }, capabilities: { experimental: { mcpl: { version: '0.5', pushEvents: true } } } });
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      await call('featureSets/update', { effectiveCapabilities: ['tools', 'pushEvents'] });
      const shared = await alice.evaluate((i) => fetch(`/api/docs/${i}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ who: '@Quill', role: 'viewer' }) }).then((r) => r.ok), docId);
      assert(shared, 'shared with Quill');
      await selectInEditor(alice, 'The river was high.');
      await alice.locator('.ping-btn').click();
      const dlg = alice.locator('dialog.ping-dialog');
      const row = dlg.locator('.ping-agent', { hasText: 'Quill' });
      await row.locator('.ping-state.online').waitFor();
      await row.click();
      await dlg.getByLabel('Message').fill('Can you check the river line?');
      await shot(alice, '05-ping-dialog');
      await dlg.getByRole('button', { name: 'Ping', exact: true }).click();
      await alice.locator('.toast', { hasText: 'Pinged Quill' }).waitFor();
      for (let i = 0; i < 100 && !pushes.some((p) => p.tags.includes('docs:ping')); i++) await sleep(30);
      const p = pushes.find((x) => x.tags.includes('docs:ping'));
      assert(p, `ping push arrived: ${JSON.stringify(pushes.map((x) => x.tags))}`);
      const text = p.payload.content[0].text;
      assert(/Alice Chen.* pinged you about “Field notes”/.test(text) && text.includes('Can you check the river line?') && text.includes('about line 3: “The river was high.”'), text);
      assert(p.tags.includes('docs:wake'), 'it wakes the agent');
    } finally { ws.close(); }
  });

  await step('no uncaught errors in any page', async () => {
    assert(!consoleErrors.length, `errors:\n${consoleErrors.join('\n')}`);
  });
} catch {
  process.exitCode = 1;
} finally {
  console.log(`\n${results.join('\n')}\nScreenshots: ${SHOTS}`);
  if (process.exitCode) console.log(`\nServer log tail:\n${server.log().split('\n').slice(-30).join('\n')}`);
  await browser.close();
  server.proc.kill();
  rmSync(DATA, { recursive: true, force: true });
}
