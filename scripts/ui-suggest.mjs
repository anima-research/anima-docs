#!/usr/bin/env node
// End-to-end test of suggestions in a real headless browser.
//
// Alice owns a document; Bob is a commenter, so he types in Suggesting mode.
// His edits become suggestions (never document text) that Alice sees as
// tracked changes with cards, while both keep typing concurrently. Alice
// accepts one, rejects one; Bob is told. Bob reloads and keeps editing his
// open suggestion in place; undo withdraws it. Alice, an editor, switches to
// Suggesting and back. An agent suggests over the operations API, and Alice
// accepts everything from the toolbar. Screenshots go to SUGGEST_SHOTS.
//
//   npm run build:web && node scripts/ui-suggest.mjs
//   env: SUGGEST_PORT (7367), SUGGEST_SHOTS ($TMPDIR/anima-docs-suggest-shots), SMOKE_HEADED=1

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SUGGEST_PORT ?? 7367);
const ORIGIN = `http://localhost:${PORT}`;
const SHOTS = process.env.SUGGEST_SHOTS ?? join(tmpdir(), 'anima-docs-suggest-shots');
const DATA = mkdtempSync(join(tmpdir(), 'docs-suggest-'));
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
const aliceCtx = await browser.newContext({ viewport, colorScheme: 'light' });
const bobCtx = await browser.newContext({ viewport, colorScheme: 'light' });
const alice = await aliceCtx.newPage();
const bob = await bobCtx.newPage();
watch(alice, 'alice'); watch(bob, 'bob');
let docId = '';

const START = [
  '# Launch notes',
  '',
  'The beta opens to every workspace in October.',
  '',
  'Support hours are nine to five on weekdays.',
  '',
  'We will review the rollout every Friday.',
  '',
].join('\n');

try {
  await step('Alice and Bob sign in; Alice creates a document and makes Bob a commenter', async () => {
    await signIn(alice, 'Alice Chen');
    await signIn(bob, 'Bob Rivera');
    const d = await alice.evaluate((content) => fetch('/api/docs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Launch notes', content }) }).then((r) => r.json()), START);
    docId = docIdGlobal = d.id;
    const ok = await alice.evaluate((id) => fetch(`/api/docs/${id}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ who: '@Bob Rivera', role: 'commenter' }) }).then((r) => r.ok), docId);
    assert(ok, 'shared with Bob');
    await openDoc(alice, docId);
    await openDoc(bob, docId);
  });

  await step('Bob, a commenter, is in Suggesting mode and can type', async () => {
    await bob.locator('.write-mode', { hasText: 'Suggesting' }).waitFor();
    assert(await bob.locator('.write-mode').isDisabled(), 'commenters can’t switch to editing');
    assert(!(await bob.locator('.edit-tools').isHidden()), 'formatting tools available while suggesting');
    assert(await bob.locator('.cm-content[contenteditable="true"]').count() === 1, 'editor is editable');
    await alice.locator('.write-mode', { hasText: 'Editing' }).waitFor();
  });

  await step('Bob replaces a word: it shows as a pending change, the document text is untouched', async () => {
    await selectInEditor(bob, 'October');
    await bob.keyboard.type('September');
    await bob.locator('.cm-sugg-ins.mine', { hasText: 'September' }).waitFor();
    await bob.locator('.cm-sugg-del-widget', { hasText: 'October' }).waitFor();
    assert((await viewText(bob)).includes('in September.'), 'Bob’s editor shows his version');
    assert((await docText(bob, docId)).includes('in October.'), 'the document still says October');
  });

  await step('it is saved as a suggestion: Alice sees the tracked change and a card with Accept / Reject', async () => {
    await bob.locator('.cm-sugg-ins.mine:not(.pending)', { hasText: 'September' }).waitFor({ timeout: 6000 });
    await alice.locator('.cm-sugg-del', { hasText: 'October' }).waitFor({ timeout: 6000 });
    await alice.locator('.cm-sugg-ins-widget', { hasText: 'September' }).waitFor();
    const card = alice.locator('.thread-card.suggestion', { hasText: 'September' });
    await card.waitFor();
    await card.locator('.accept-btn').waitFor();
    await card.locator('.reject-btn').waitFor();
    assert((await alice.locator('.review-btn').textContent()).includes('1 suggestion'), 'toolbar counts it');
    await shot(alice, '01-owner-sees-suggestion');
    await shot(bob, '02-suggester-view');
  });

  await step('both type at once: Alice edits above while Bob suggests below; nobody’s text is lost', async () => {
    await caretAfter(bob, 'nine to five');
    await caretAfter(alice, '# Launch notes');
    await Promise.all([
      (async () => { for (const ch of ' (draft)') { await alice.keyboard.type(ch); await sleep(15); } })(),
      (async () => { for (const ch of ', Monday to Thursday,') { await bob.keyboard.type(ch); await sleep(12); } })(),
    ]);
    await bob.locator('.cm-sugg-ins.mine:not(.pending)', { hasText: 'Monday to Thursday' }).waitFor({ timeout: 6000 });
    const shared = await docText(alice, docId);
    assert(shared.startsWith('# Launch notes (draft)'), `Alice’s edit is in the document: ${JSON.stringify(shared.slice(0, 40))}`);
    assert(!shared.includes('Monday'), 'Bob’s typing is not');
    const bv = await viewText(bob);
    assert(bv.startsWith('# Launch notes (draft)') && bv.includes('nine to five, Monday to Thursday, on weekdays'), `Bob sees both: ${JSON.stringify(bv)}`);
    await alice.locator('.cm-sugg-ins-widget', { hasText: 'Monday to Thursday' }).waitFor({ timeout: 6000 });
  });

  await step('Bob deletes a sentence: a deletion suggestion', async () => {
    await selectInEditor(bob, 'We will review the rollout every Friday.');
    await bob.keyboard.press('Backspace');
    await bob.locator('.cm-sugg-del-widget', { hasText: 'every Friday' }).waitFor();
    await alice.locator('.cm-sugg-del', { hasText: 'every Friday' }).waitFor({ timeout: 6000 });
    assert((await docText(alice, docId)).includes('every Friday'), 'still in the document');
    const t = await threads(alice);
    assert(t.filter((x) => x.suggestion?.status === 'open').length === 3, `three open suggestions: ${JSON.stringify(t.map((x) => x.suggestion))}`);
  });

  await step('Alice accepts one and rejects another; Bob is told and his view follows', async () => {
    await alice.locator('.thread-card.suggestion', { hasText: 'September' }).locator('.accept-btn').click();
    await alice.waitForFunction(() => document.querySelector('.editor-page .cm-content').innerText.includes('opens to every workspace in September'));
    assert((await docText(alice, docId)).includes('in September.'), 'accepted text is in the document');
    await bob.locator('.toast', { hasText: 'accepted your suggestion' }).waitFor({ timeout: 6000 });
    await alice.locator('.thread-card.suggestion', { hasText: 'Monday to Thursday' }).locator('.reject-btn').click();
    await bob.waitForFunction(() => !document.querySelector('.editor-page .cm-content').cmTile.root.view.state.doc.toString().includes('Monday'));
    const bv = await viewText(bob);
    assert(bv.includes('in September.') && !bv.includes('SeptemberSeptember') && !bv.includes('October'), `no duplicate or stale text: ${JSON.stringify(bv)}`);
    assert(bv.includes('nine to five on weekdays'), 'rejected suggestion gone from Bob’s view');
    await shot(bob, '03-after-decisions');
  });

  await step('Bob reloads: his open deletion is back in place, and he can revise it by typing', async () => {
    await openDoc(bob, docId);
    await bob.locator('.cm-sugg-del-widget', { hasText: 'every Friday' }).waitFor({ timeout: 6000 });
    // Typing where the deleted sentence was turns the deletion into a replacement (same suggestion).
    const before = (await threads(bob)).filter((x) => x.suggestion?.status === 'open').map((x) => x.id);
    await bob.evaluate(() => {
      const view = document.querySelector('.editor-page .cm-content').cmTile.root.view;
      const w = view.contentDOM.querySelector('.cm-sugg-del-widget');
      view.focus();
      view.dispatch({ selection: { anchor: view.posAtDOM(w) } });
    });
    await bob.keyboard.type('We review it every Monday.');
    await bob.locator('.cm-sugg-ins.mine:not(.pending)', { hasText: 'every Monday' }).waitFor({ timeout: 6000 });
    const after = (await threads(bob)).filter((x) => x.suggestion?.status === 'open');
    assert(after.length === 1 && after[0].id === before[0], `revised in place, not a new suggestion: ${JSON.stringify(after.map((x) => [x.id, x.suggestion]))}`);
    assert(after[0].suggestion.original.includes('every Friday') && after[0].suggestion.text.includes('every Monday'), 'revision carries the new text');
    // Alice sees it word by word: "every" is unchanged, "Monday" is new.
    await alice.locator('.cm-sugg-ins-widget', { hasText: 'Monday' }).waitFor({ timeout: 6000 });
  });

  await step('undo takes Bob’s typing back: a revised suggestion reverts, a fresh one is withdrawn', async () => {
    const view = () => document.querySelector('.editor-page .cm-content').cmTile.root.view.state.doc.toString();
    for (let i = 0; i < 3; i++) await bob.keyboard.press('ControlOrMeta+z');
    await bob.waitForFunction((f) => !eval(`(${f})`)().includes('every Monday'), view.toString());
    await caretAfter(bob, 'nine to five');
    await bob.keyboard.type(' sharp');
    await bob.locator('.cm-sugg-ins.mine:not(.pending)', { hasText: 'sharp' }).waitFor({ timeout: 6000 });
    assert((await threads(bob)).some((x) => x.suggestion?.status === 'open' && x.suggestion.text.includes('sharp')), 'saved first');
    await bob.keyboard.press('ControlOrMeta+z');
    await bob.waitForFunction((f) => !eval(`(${f})`)().includes('sharp'), view.toString());
    await sleep(1800);
    const open = (await threads(bob)).filter((x) => x.suggestion?.status === 'open');
    assert(!open.some((x) => x.suggestion.text.includes('sharp')), `the undone suggestion was withdrawn: ${JSON.stringify(open.map((x) => x.suggestion))}`);
    const del = open.find((x) => x.suggestion.original.includes('every Friday'));
    assert(del && del.suggestion.text === '', `the revised one is a plain deletion again: ${JSON.stringify(open.map((x) => x.suggestion))}`);
  });

  await step('Alice switches to Suggesting, suggests, and switches back: her suggestion stays a suggestion', async () => {
    await alice.locator('.write-mode').click();
    await alice.getByRole('menuitemradio', { name: /Suggesting/ }).click();
    await alice.locator('.write-mode', { hasText: 'Suggesting' }).waitFor();
    await caretAfter(alice, 'Support hours');
    await alice.keyboard.type(' for customers');
    await alice.locator('.cm-sugg-ins.mine:not(.pending)', { hasText: 'for customers' }).waitFor({ timeout: 6000 });
    await shot(alice, '04-owner-suggesting');
    await alice.locator('.write-mode').click();
    await alice.getByRole('menuitemradio', { name: /Editing/ }).click();
    await alice.locator('.write-mode', { hasText: 'Editing' }).waitFor();
    await alice.locator('.cm-sugg-ins-widget', { hasText: 'for customers' }).waitFor({ timeout: 6000 });
    assert(!(await docText(alice, docId)).includes('for customers'), 'not in the document');
    assert(!(await viewText(alice)).includes('for customers'), 'Alice’s editor shows the shared text again');
    await bob.locator('.cm-sugg-ins-widget', { hasText: 'for customers' }).waitFor({ timeout: 6000 });
  });

  await step('an agent suggests over the operations API; it shows with an agent badge', async () => {
    const mint = await fetch(`${ORIGIN}/dev/token`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ name: 'Quill', kind: 'agent' }) }).then((r) => r.json());
    const op = (name, args) => fetch(`${ORIGIN}/api/operations/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${mint.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) }).then(async (r) => ({ ok: r.ok, body: await r.json() }));
    await op('whoami', {});
    const shared = await alice.evaluate((id) => fetch(`/api/docs/${id}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ who: '@Quill', role: 'commenter' }) }).then((r) => r.ok), docId);
    assert(shared, 'shared with the agent');
    const r = await op('suggest_edit', { document: docId, note: 'Clearer heading.', edits: [{ old_text: '# Launch notes (draft)', new_text: '# Beta launch notes' }] });
    assert(r.ok, `suggest_edit: ${JSON.stringify(r.body)}`);
    const card = alice.locator('.thread-card.suggestion', { hasText: 'Clearer heading' });
    await card.waitFor({ timeout: 6000 });
    await card.locator('.kind-agent').waitFor();
    await alice.locator('.cm-sugg-ins-widget', { hasText: 'Beta' }).waitFor();
    await shot(alice, '05-agent-suggestion');
  });

  await step('Alice accepts everything from the toolbar', async () => {
    const before = await docText(alice, docId);
    await alice.locator('.review-btn').click();
    await alice.getByRole('menuitem', { name: 'Accept all' }).click();
    await alice.locator('dialog').getByRole('button', { name: 'Accept all' }).click();
    await alice.locator('.toast', { hasText: /Accepted \d/ }).waitFor({ timeout: 6000 });
    const after = await docText(alice, docId);
    assert(after.includes('# Beta launch notes') && after.includes('Support hours for customers'), `accepted text in the document: ${JSON.stringify(after)}`);
    assert(before !== after, 'changed');
    await alice.locator('.review-btn').waitFor({ state: 'hidden' });
    await bob.waitForFunction(() => document.querySelector('.editor-page .cm-content').cmTile.root.view.state.doc.toString().includes('# Beta launch notes'));
    const bv = await viewText(bob);
    assert(!bv.includes('for customers for customers'), `no duplicates in Bob’s view: ${JSON.stringify(bv)}`);
    await shot(alice, '06-after-accept-all');
  });

  await step('dark mode and narrow window', async () => {
    const dark = await browser.newContext({ viewport, colorScheme: 'dark', storageState: await bobCtx.storageState() });
    const p = await dark.newPage();
    watch(p, 'bob-dark');
    await openDoc(p, docId);
    await caretAfter(p, 'Support hours for customers');
    await p.keyboard.type(' and partners');
    await p.locator('.cm-sugg-ins.mine:not(.pending)', { hasText: 'and partners' }).waitFor({ timeout: 6000 });
    await shot(p, '07-dark-suggesting');
    await p.setViewportSize({ width: 820, height: 900 });
    await p.locator('.comments-btn').click();
    await p.locator('.thread-card.suggestion', { hasText: 'and partners' }).waitFor();
    await shot(p, '08-narrow-drawer');
    await dark.close();
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
