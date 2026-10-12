#!/usr/bin/env node
// End-to-end test of the node model in a real browser: sections, bands,
// typing at seams, collapse, naming, navigation trees, comments across
// sections, split/merge/detach/undo, two people, and an agent.
//
//   npm run build:web && node scripts/ui-nodes.mjs
//   env: SMOKE_PORT (7367), SMOKE_SHOTS, SMOKE_HEADED=1

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT ?? 7367);
const ORIGIN = `http://localhost:${PORT}`;
const SHOTS = process.env.SMOKE_SHOTS ?? join(tmpdir(), 'anima-docs-nodes-shots');
const DATA = mkdtempSync(join(tmpdir(), 'docs-nodes-'));
mkdirSync(SHOTS, { recursive: true });

let failed = 0, n = 0;
let alice, bob;
async function step(name, fn) {
  n++;
  try { await fn(); console.log(`ok ${n} - ${name}`); }
  catch (e) {
    failed++; console.log(`not ok ${n} - ${name}\n  ${String(e.stack ?? e).split('\n').slice(0, 7).join('\n  ')}`);
    try { await alice?.screenshot({ path: join(SHOTS, `fail-${n}-alice.png`) }); await bob?.screenshot({ path: join(SHOTS, `fail-${n}-bob.png`) }); } catch { /* ignore */ }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };

async function startServer() {
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: root, env: { ...process.env, PORT: String(PORT), DOCS_ORIGIN: ORIGIN, DOCS_DATA_DIR: DATA, DOCS_DEV_ISSUER: 'dev.local', DOCS_ISSUERS: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(`server exited:\n${log}`);
    try { const r = await fetch(`${ORIGIN}/health`); if (r.ok) return { proc, log: () => log }; } catch { /* not yet */ }
    await sleep(150);
  }
  proc.kill(); throw new Error(`server did not start:\n${log}`);
}

async function signIn(page, name) {
  await page.goto(`${ORIGIN}/`);
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('main.home h1', { hasText: 'Documents' }).waitFor();
}
async function openDoc(page, id, tree) {
  await page.goto(`${ORIGIN}/d/${id}${tree ? `?tree=${tree}` : ''}`);
  await page.locator('.editor-page .cm-content').waitFor();
  await page.locator('.sync-veil').waitFor({ state: 'detached' });
  await sleep(200);
}
const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(p, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, json: j };
}, [method, path, body ?? null]);
const viewText = (page) => page.evaluate(() => window.__anima.view.state.doc.toString());
const nodeText = (page, id) => api(page, 'GET', `/api/docs/${id}/export.md`).then((r) => r.json);
const setCursor = (page, pos) => page.evaluate((p) => { const v = window.__anima.view; v.dispatch({ selection: { anchor: p }, scrollIntoView: true }); v.focus(); }, pos);
const select = (page, a, b) => page.evaluate(([x, y]) => { const v = window.__anima.view; v.dispatch({ selection: { anchor: x, head: y } }); v.focus(); }, [a, b]);
const layout = (page) => page.evaluate(() => { const L = window.__anima.binding.current; return { text: L.text, mounts: L.mounts.map((m) => ({ ...m })) }; });
const typeAt = async (page, pos, text) => { await setCursor(page, pos); await page.keyboard.type(text); };
const waitText = (page, needle, present = true) => page.waitForFunction(([s, p]) => window.__anima.view.state.doc.toString().includes(s) === p, [needle, present], { timeout: 8000 });

const server = await startServer();
const browser = await chromium.launch({ headless: !process.env.SMOKE_HEADED });
const viewport = { width: 1500, height: 960 };
const aliceCtx = await browser.newContext({ viewport });
const bobCtx = await browser.newContext({ viewport });
alice = await aliceCtx.newPage();
bob = await bobCtx.newPage();
const errors = [];
for (const p of [alice, bob]) { p.on('pageerror', (e) => errors.push(`${p === alice ? 'alice' : 'bob'}: ${e.message}`)); p.on('console', (m) => { if (m.type() === 'error') errors.push(`${p === alice ? 'alice' : 'bob'} console: ${m.text()}`); }); }

let docId, sectionId, childText;
try {
  await step('two people sign in', async () => { await signIn(alice, 'Alice'); await signIn(bob, 'Bob'); });

  await step('a document with three paragraphs; splitting at the second makes a section with a band', async () => {
    const d = await api(alice, 'POST', '/api/docs', { title: 'Paper', content: '# Paper\n\nIntro paragraph here.\n\n## Method\n\nWe flatten the tree.\n\n## Results\n\nAll good.\n' });
    assert(d.status === 201, `create ${d.status}`);
    docId = d.json.id;
    await openDoc(alice, docId);
    const t = await viewText(alice);
    const at = t.indexOf('## Method');
    await setCursor(alice, at);
    await alice.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await alice.locator('.editor-page .node-band').waitFor({ timeout: 8000 });
    await sleep(400);
    const tree = (await api(alice, 'GET', `/api/docs/${docId}/tree`)).json;
    assert(tree.nodes.length === 2, `tree nodes ${tree.nodes.length}`);
    sectionId = tree.nodes[1].id;
    assert(tree.nodes[1].section === true, 'new node is a section');
    const own = await nodeText(alice, sectionId);
    assert(own.startsWith('## Method'), `section text: ${JSON.stringify(own.slice(0, 20))}`);
    // The view still reads as one document.
    assert((await viewText(alice)) === '# Paper\n\nIntro paragraph here.\n\n## Method\n\nWe flatten the tree.\n\n## Results\n\nAll good.\n', 'view changed');
    await alice.screenshot({ path: join(SHOTS, 'split.png') });
  });

  await step('typing at the section’s first line goes into the section; the intro stays in the paper', async () => {
    const L = await layout(alice);
    const m = L.mounts[0];
    await typeAt(alice, m.from, 'XX ');
    await sleep(600);
    assert((await nodeText(alice, sectionId)).startsWith('XX ## Method'), 'section did not get the text');
    const paper = (await api(alice, 'GET', `/api/docs/${docId}/tree`)).json;
    void paper;
    const own = await api(alice, 'POST', '/api/operations/read_document', { document: docId, sections: 'markers' });
    assert(own.json.content[0].text.includes(`{{node:${sectionId}}}`), 'paper lacks the marker line');
    await typeAt(alice, m.from - 1, ' YY');
    await sleep(600);
    // The position just before the seam is the end of the paper's own text (after its blank line).
    const paperNow = (await api(alice, 'POST', '/api/operations/read_document', { document: docId, sections: 'markers' })).json.content[0].text;
    assert(paperNow.includes(' YY\n{{node:'), `paper did not get the text: ${JSON.stringify(paperNow.slice(0, 120))}`);
  });

  await step('Bob, shared as editor, sees the section and edits inside it; Alice sees his edit', async () => {
    const me = await api(bob, 'GET', '/api/me');
    const bobSub = me.json.you.sub;
    assert((await api(alice, 'POST', `/api/docs/${docId}/share`, { who: bobSub, role: 'editor' })).status === 200, 'share');
    await openDoc(bob, docId);
    await bob.locator('.editor-page .node-band').waitFor();
    await bob.waitForFunction(() => window.__anima.view.state.doc.toString().includes('XX ## Method'));
    const L = await layout(bob);
    await typeAt(bob, L.mounts[0].from + 3, 'BOB ');
    await waitText(alice, 'XX BOB ## Method');
    // Bob's access to the section is derived through the paper.
    const r = await api(bob, 'GET', `/api/docs/${sectionId}`);
    assert(r.status === 200 && r.json.role === 'editor', `bob role on section: ${r.status} ${r.json.role}`);
  });

  await step('a comment spanning the seam highlights across it for both', async () => {
    const t = await viewText(alice);
    const a = t.indexOf('here.'), b = t.indexOf('BOB') + 3;
    await select(alice, a, b);
    await alice.locator('.tb-comment').click();
    await alice.locator('.thread-card.draft textarea').fill('spans the seam');
    await alice.locator('.thread-card.draft button.btn.primary').click();
    await alice.locator('.thread-card:not(.draft)').waitFor();
    await alice.waitForFunction(() => document.querySelectorAll('.editor-page .cm-comment-hl').length > 0);
    await bob.waitForFunction(() => document.querySelectorAll('.editor-page .cm-comment-hl').length > 0);
    const marked = await alice.evaluate(() => [...document.querySelectorAll('.editor-page .cm-comment-hl')].map((e) => e.textContent).join('|'));
    assert(marked.includes('here.') && marked.includes('BOB'), `marks: ${marked}`);
    const threads = (await api(alice, 'POST', '/api/operations/list_comments', { document: docId })).json.content[0].text;
    assert(threads.includes('spans the seam'), 'agent view lacks the thread');
    await alice.screenshot({ path: join(SHOTS, 'comment-span.png') });
  });

  await step('collapsing the section removes its text from the view; expanding brings it back', async () => {
    await alice.locator('.editor-page .node-band .band-tri').first().click();
    await waitText(alice, '## Method', false);
    assert((await alice.locator('.editor-page .node-band.collapsed').count()) === 1, 'band not collapsed');
    await alice.locator('.editor-page .node-band .band-tri').first().click();
    await waitText(alice, '## Method', true);
  });

  await step('naming the section makes it a document; the band and the nav show the name', async () => {
    alice.once('dialog', (d) => d.accept('Method'));
    await alice.locator('.editor-page .node-band .band-act', { hasText: 'Name' }).click();
    const dlg = alice.locator('.dialog input.input');
    await dlg.waitFor();
    await dlg.fill('Method');
    await alice.locator('.dialog button.btn.primary').click();
    await alice.waitForFunction(() => document.querySelector('.editor-page .node-band .band-name')?.textContent === 'Method');
    const list = (await api(alice, 'GET', '/api/docs')).json.docs.map((d) => d.title);
    assert(list.includes('Method'), `documents: ${list}`);
  });

  await step('a navigation tree: the paper becomes a root, Method is its subpage by itself; a placed-only subpage shows in the footer', async () => {
    if (!(await alice.evaluate(() => document.querySelector('.doc-app').classList.contains('nav-open')))) await alice.locator('.nav-btn').click();
    await alice.locator('.doc-nav .nav-tree-chip.new').click();
    await alice.locator('.doc-nav .nav-row', { hasText: 'Method' }).waitFor({ timeout: 8000 });
    // + subpage on the root: a placed page that is not mounted inline.
    await alice.locator('.doc-nav .nav-row').first().hover();
    await alice.locator('.doc-nav .nav-row').first().locator('.nav-act', { hasText: '+' }).click();
    const inp = alice.locator('.dialog input.input');
    await inp.waitFor(); await inp.fill('Plan');
    await alice.locator('.dialog button.btn.primary').click();
    await alice.waitForURL(/\/d\/d[A-Za-z0-9]+\?tree=/);
    await alice.locator('.editor-page .cm-content').waitFor();
    await alice.locator('.doc-crumbs .crumb', { hasText: 'Paper' }).waitFor({ timeout: 8000 });
    await openDoc(alice, docId, docId);
    await alice.locator('.editor-page .subpages a', { hasText: 'Plan' }).waitFor({ timeout: 8000 });
    assert(!(await viewText(alice)).includes('Plan'), 'Plan leaked into the body');
    await alice.screenshot({ path: join(SHOTS, 'tree.png') });
  });

  await step('an agent reads the paper with the section inline, edits the section by id, and sees the tree', async () => {
    const tok = (await api(alice, 'POST', '/dev/token', { name: 'Scribe', kind: 'agent' })).json.token;
    const op = async (name, args) => {
      const r = await fetch(`${ORIGIN}/api/operations/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify(args) });
      return (await r.json()).content?.[0]?.text ?? JSON.stringify(await r.text());
    };
    const sub = (await (await fetch(`${ORIGIN}/api/me`, { headers: { Authorization: `Bearer ${tok}` } })).json()).you.sub;
    await api(alice, 'POST', `/api/docs/${docId}/share`, { who: sub, role: 'editor' });
    const read = await op('read_document', { document: docId });
    assert(read.includes(`[section ${sectionId} “Method” begins]`) && read.includes('We flatten the tree.'), `read: ${read.slice(0, 300)}`);
    const edit = await op('edit_document', { document: sectionId, edits: [{ old_text: 'We flatten the tree.', new_text: 'We flatten the tree, line by line.' }] });
    assert(edit.startsWith('Applied'), `edit: ${edit}`);
    await waitText(alice, 'line by line.');
    const tree = await op('tree', { document: docId });
    assert(tree.includes('“Method”') && tree.includes('In navigation trees'), `tree: ${tree}`);
    // Editing text that lives in a section, through the paper's id, gets a hint.
    const wrong = await op('edit_document', { document: docId, edits: [{ old_text: 'line by line', new_text: 'x' }] });
    assert(wrong.includes('edit it with its id'), `hint: ${wrong}`);
  });

  await step('Bob as a commenter suggests inside the section; it is saved to the section; Alice accepts it', async () => {
    const bobSub = (await api(bob, 'GET', '/api/me')).json.you.sub;
    await api(alice, 'POST', `/api/docs/${docId}/share`, { who: bobSub, role: 'commenter' });
    await openDoc(bob, docId);
    await bob.waitForFunction(() => document.querySelector('.doc-app')?.classList.contains('suggesting'), null, { timeout: 8000 });
    await bob.locator('.editor-page .node-band').waitFor();
    await bob.waitForFunction(() => window.__anima.view.state.doc.toString().includes('line by line'));
    const t = await viewText(bob);
    const a = t.indexOf('flatten');
    await select(bob, a, a + 'flatten'.length);
    await bob.keyboard.type('fold');
    await bob.locator('.cm-sugg-ins.mine', { hasText: 'fold' }).waitFor();
    await bob.locator('.cm-sugg-ins.mine:not(.pending)', { hasText: 'fold' }).waitFor({ timeout: 8000 });
    // Saved on the section node, not the paper.
    const onSection = (await api(alice, 'POST', '/api/operations/list_comments', { document: sectionId })).json.content[0].text;
    assert(onSection.includes('fold'), `section suggestions: ${onSection}`);
    assert((await nodeText(alice, sectionId)).includes('We flatten'), 'the section text changed before acceptance');
    // Alice sees it in place and accepts.
    await alice.locator('.editor-page .cm-sugg-del', { hasText: 'flatten' }).waitFor({ timeout: 8000 });
    await alice.locator('.thread-card', { hasText: 'fold' }).locator('.accept-btn').first().click();
    await waitText(alice, 'We fold the tree');
    assert((await nodeText(alice, sectionId)).includes('We fold the tree'), 'acceptance did not reach the section');
    await waitText(bob, 'We fold the tree');
    await bob.screenshot({ path: join(SHOTS, 'suggest-section.png') });
  });

  await step('a suggestion in the paper itself and one typed across the seam (split around it)', async () => {
    let t = await viewText(bob);
    const i = t.indexOf('Intro');
    await typeAt(bob, i, 'Opening: ');
    await bob.locator('.cm-sugg-ins.mine:not(.pending)', { hasText: 'Opening:' }).waitFor({ timeout: 8000 });
    const onPaper = (await api(alice, 'POST', '/api/operations/list_comments', { document: docId })).json.content[0].text;
    assert(onPaper.includes('Opening:'), `paper suggestions: ${onPaper}`);
    // Across the seam: the deletion is split, the boundary stays.
    t = await viewText(bob);
    const L = await layout(bob);
    const m = L.mounts[0];
    const from = Math.max(0, m.from - 3), to = Math.min(t.length, m.from + 4);
    await select(bob, from, to);
    await bob.keyboard.type('Z');
    await sleep(300);
    assert((await bob.locator('.editor-page .node-band').count()) >= 1, 'the band vanished');
    const after = await viewText(bob);
    assert(after.includes('\n'), 'seam gone');
    // Alice rejects everything Bob has open on the paper.
    await alice.locator('.thread-card', { hasText: 'Opening:' }).locator('.reject-btn').first().click();
    await alice.locator('.thread-card', { hasText: 'Opening:' }).waitFor({ state: 'detached', timeout: 8000 });
  });

  await step('Bob is an editor again and sees the live text', async () => {
    const bobSub = (await api(bob, 'GET', '/api/me')).json.you.sub;
    await api(alice, 'POST', `/api/docs/${docId}/share`, { who: bobSub, role: 'editor' });
    await openDoc(bob, docId);
    await waitText(bob, 'We fold the tree');
  });

  await step('a selection covering the whole section and its seams detaches it; undo puts it back', async () => {
    const L = await layout(alice);
    const m = L.mounts[0];
    await select(alice, Math.max(0, m.from - 1), Math.min(m.to + 1, L.text.length));
    await alice.keyboard.press('Backspace');
    await alice.waitForFunction(() => window.__anima.binding.current.mounts.length === 0, null, { timeout: 8000 });
    await sleep(500);
    assert((await nodeText(alice, sectionId)).includes('We fold the tree'), 'section text was gutted');
    await alice.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await alice.waitForFunction(() => window.__anima.binding.current.mounts.length === 1, null, { timeout: 8000 });
    await waitText(bob, 'We fold the tree', true);
  });

  await step('Backspace at the section’s first line offers a merge; merging inlines it', async () => {
    const L = await layout(alice);
    await setCursor(alice, L.mounts[0].from);
    await alice.keyboard.press('Backspace');
    await alice.locator('.dialog button.btn.primary', { hasText: 'Merge' }).click();
    await alice.waitForFunction(() => window.__anima.binding.current.mounts.length === 0, null, { timeout: 8000 });
    const own = await nodeText(alice, docId);
    assert(own.includes('## Method') && !own.includes('{{node:'), `paper after merge: ${JSON.stringify(own.slice(0, 80))}`);
    await bob.waitForFunction(() => document.querySelectorAll('.editor-page .node-band').length === 0);
  });

  await step('home lists the tree', async () => {
    await alice.goto(`${ORIGIN}/`);
    await alice.locator('.home-trees a.tree-card', { hasText: 'Paper' }).waitFor({ timeout: 8000 });
  });
} finally {
  console.log(`\n${n - failed}/${n} passed; page errors: ${errors.length}`);
  for (const e of errors.slice(0, 10)) console.log('  ' + e);
  if (failed) console.log(server.log().split('\n').slice(-30).join('\n'));
  await browser.close();
  server.proc.kill();
  rmSync(DATA, { recursive: true, force: true });
  process.exit(failed || errors.length ? 1 : 0);
}
