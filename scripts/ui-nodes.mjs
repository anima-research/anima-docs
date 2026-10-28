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
  try { if ((await fetch(`${ORIGIN}/health`)).ok) throw new Error(`something is already listening on ${ORIGIN}; kill it first (lsof -ti :${PORT})`); } catch (e) { if (!(e instanceof TypeError)) throw e; }
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
  await page.locator('.editor-page .cm-content').waitFor({ state: 'attached' }); // an HTML page opens in Preview: the editor exists but is not shown
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
    // The view still reads as one document (plus the paper's own empty line after the section).
    assert((await viewText(alice)) === '# Paper\n\nIntro paragraph here.\n\n## Method\n\nWe flatten the tree.\n\n## Results\n\nAll good.\n\n', `view changed: ${JSON.stringify(await viewText(alice))}`);
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
    await alice.locator('.doc-nav .nav-space-acts .nav-act.make-space').click();
    await alice.locator('.dialog button.btn.primary', { hasText: 'Make it a space' }).click();
    await alice.locator('.doc-nav .nav-row', { hasText: 'Method' }).waitFor({ timeout: 8000 });
    // + subpage on the root: a placed page that is not mounted inline.
    await alice.locator('.doc-nav .nav-row').first().hover();
    await alice.locator('.doc-nav .nav-row').first().locator('.nav-act', { hasText: '+' }).click();
    const inp = alice.locator('.dialog input.input');
    await inp.waitFor(); await inp.fill('Plan');
    await alice.locator('.dialog button.btn.primary').click();
    const navEl = await alice.evaluateHandle(() => document.querySelector('.doc-nav'));
    await alice.waitForURL(/\/d\/d[A-Za-z0-9]+\?tree=/);
    await alice.locator('.editor-page .cm-content').waitFor();
    assert(await alice.evaluate((el) => el.isConnected && el === document.querySelector('.doc-nav'), navEl), 'the nav panel was rebuilt instead of kept');
    await alice.locator('.doc-crumbs .crumb', { hasText: 'Paper' }).waitFor({ timeout: 8000 });
    await openDoc(alice, docId, docId);
    await alice.locator('.editor-page .subpages a', { hasText: 'Plan' }).waitFor({ timeout: 8000 });
    assert(!(await viewText(alice)).includes('Plan'), 'Plan leaked into the body');
    await alice.screenshot({ path: join(SHOTS, 'tree.png') });
  });

  await step('pages are arranged in the left panel: drag Plan onto Method nests it; Move to… puts it back; right-click renames', async () => {
    await openDoc(alice, docId, docId);
    const row = (t) => alice.locator('.doc-nav .nav-pages .nav-row', { hasText: t });
    await row('Plan').waitFor({ timeout: 8000 });
    assert((await row('Plan').getAttribute('aria-level')) === '2', 'Plan should start as a child of the space');
    await row('Plan').dragTo(row('Method'));
    await alice.waitForFunction(() => [...document.querySelectorAll('.doc-nav .nav-pages .nav-row')].some((r) => r.textContent.includes('Plan') && r.getAttribute('aria-level') === '3'), null, { timeout: 8000 });
    const view = (await api(alice, 'GET', `/api/trees/${docId}`)).json;
    const method = view.nodes.find((n) => n.title === 'Method'), plan = view.nodes.find((n) => n.title === 'Plan');
    assert(view.placements.some((p) => p.parent === method.id && p.child === plan.id), 'Plan not placed under Method on the server');
    // Back under the space through the context menu.
    await row('Plan').click({ button: 'right' });
    await alice.getByRole('menuitem', { name: 'Move to…' }).click();
    await alice.locator('dialog.dialog .pick-row', { hasText: 'Paper' }).click();
    await alice.waitForFunction(() => [...document.querySelectorAll('.doc-nav .nav-pages .nav-row')].some((r) => r.textContent.includes('Plan') && r.getAttribute('aria-level') === '2'), null, { timeout: 8000 });
    // Rename from the menu, and back.
    for (const [from, to] of [['Plan', 'Plan 1'], ['Plan 1', 'Plan']]) {
      await row(from).hover();
      await row(from).locator('.nav-more').click();
      await alice.getByRole('menuitem', { name: 'Rename…' }).click();
      const inp = alice.locator('dialog.dialog input.input');
      await inp.waitFor(); await inp.fill(to);
      await alice.locator('dialog.dialog button.btn.primary').click();
      await row(to).waitFor({ timeout: 8000 });
    }
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

  await step('{{ completes a document to mount inline; [[ completes a link to one', async () => {
    const plan = (await api(alice, 'GET', '/api/docs')).json.docs.find((d) => d.title === 'Plan');
    assert(plan, 'no Plan document');
    await openDoc(alice, docId, docId);
    const t = await viewText(alice);
    await setCursor(alice, t.length);
    await alice.keyboard.type('\n{{Pla');
    await alice.locator('.cm-tooltip-autocomplete li', { hasText: 'Plan' }).first().waitFor({ timeout: 8000 });
    await sleep(200); // CodeMirror ignores Enter within 75 ms of the list appearing
    await alice.keyboard.press('Enter');
    await alice.locator('.editor-page .node-band .band-name', { hasText: 'Plan' }).waitFor({ timeout: 8000 });
    const paper = (await api(alice, 'POST', '/api/operations/read_document', { document: docId, sections: 'markers' })).json.content[0].text;
    assert(paper.includes(`\n{{node:${plan.id}}}`), 'marker not on its own line');
    // The mounted-inline page is no longer in the Subpages footer.
    await alice.waitForFunction(() => !document.querySelector('.editor-page .subpages a[data-open]'), null, { timeout: 8000 }).catch(() => {});
    // A link.
    const t2 = await viewText(alice);
    await setCursor(alice, t2.indexOf('Intro'));
    await alice.keyboard.type('See [[Pla');
    await alice.locator('.cm-tooltip-autocomplete li', { hasText: 'Plan' }).first().waitFor({ timeout: 8000 });
    await sleep(200);
    await alice.keyboard.press('Enter');
    await alice.waitForFunction((id) => window.__anima.view.state.doc.toString().includes(`[Plan](/d/${id})`), plan.id, { timeout: 8000 });
    await alice.screenshot({ path: join(SHOTS, 'complete.png') });
  });

  await step('renaming a page by its title renames it in the tree, for the editor and for someone else in the tree', async () => {
    await openDoc(bob, docId, docId);
    await bob.locator('.doc-nav .nav-pages .nav-row', { hasText: 'Plan' }).waitFor({ timeout: 8000 });
    const plan = (await api(alice, 'GET', '/api/docs')).json.docs.find((d) => d.title === 'Plan');
    await openDoc(alice, plan.id, docId);
    await alice.locator('.doc-title').fill('Plan B');
    await alice.locator('.doc-title').press('Enter');
    await alice.locator('.doc-nav .nav-pages .nav-row', { hasText: 'Plan B' }).waitFor({ timeout: 8000 });
    await bob.locator('.doc-nav .nav-pages .nav-row', { hasText: 'Plan B' }).waitFor({ timeout: 8000 });
  });

  await step('publish the tree as a public wiki: a stranger reads it, with the aside as an infobox and an Edit link back', async () => {
    // An aside: a Facts node mounted with |aside in the paper.
    const facts = (await api(alice, 'POST', '/api/docs', { title: 'Facts', content: '| Started | 2026 |\n|---|---|\n| Status | draft |\n' })).json;
    await api(alice, 'POST', `/api/docs/${docId}/mount`, { child: facts.id, at: 0 });
    await api(alice, 'POST', '/api/operations/edit_document', { document: docId, edits: [{ old_text: `{{node:${facts.id}}}`, new_text: `{{node:${facts.id}|aside}}` }] });
    await openDoc(alice, docId, docId);
    await alice.locator('.editor-page .node-band.is-aside').waitFor({ timeout: 8000 });
    // Publish from the nav.
    await alice.locator('.doc-nav .nav-wiki button', { hasText: 'Publish' }).click();
    const dlg = alice.locator('dialog.dialog');
    await dlg.waitFor();
    await dlg.locator('input[name=pub][value=public]').check();
    await dlg.locator('input[placeholder^="address"]').fill('paper-wiki');
    await dlg.locator('input[placeholder="📘"]').fill('📘');
    await dlg.locator('input[placeholder^="A short line"]').fill('Notes on folding trees');
    await dlg.locator('button.btn.primary', { hasText: 'Save' }).click();
    await alice.locator('.doc-nav .nav-wiki a', { hasText: 'View wiki' }).waitFor({ timeout: 8000 });
    // A stranger.
    const anon = await browser.newContext({ viewport });
    const visitor = await anon.newPage();
    const r = await visitor.goto(`${ORIGIN}/w/paper-wiki/`);
    assert(r.status() === 200, `wiki status ${r.status()}`);
    await visitor.locator('.asides.desktop .panel.infobox', { hasText: 'Facts' }).waitFor();
    assert(await visitor.locator('.asides.desktop .panel.infobox td', { hasText: 'draft' }).count() === 1, 'infobox table');
    assert(await visitor.locator('.side .nav-list a', { hasText: 'Plan B' }).count() === 1, 'nav lists the subpage');
    assert(!(await visitor.locator('body').textContent()).includes('{{node:'), 'markers leaked');
    const edit = await visitor.locator('a.edit').getAttribute('href');
    assert(edit.startsWith(`${ORIGIN}/d/${docId}`), `edit link: ${edit}`);
    await visitor.screenshot({ path: join(SHOTS, 'wiki.png'), fullPage: true });
    // The subpage, via the nav.
    await visitor.locator('.side .nav-list a', { hasText: 'Plan B' }).click();
    await visitor.waitForURL(/\/w\/paper-wiki\/plan-b$/);
    await visitor.locator('h1', { hasText: 'Plan B' }).waitFor();
    await anon.close();
  });

  await step('an image resizes by dragging its grip; the size lands in the markdown; the preview and wiki honour it', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAKklEQVR4nO3BMQEAAADCoPVPbQhfoAAAAAAAAAAAAAAAAAAAAAAAAAAAAOA3Z0AAAbgRvTkAAAAASUVORK5CYII=', 'base64');
    const info = await alice.evaluate(async ([id, b64]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const r = await fetch(`/api/media?doc=${id}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: bytes });
      return r.json();
    }, [docId, png.toString('base64')]);
    await openDoc(alice, docId, docId);
    const t = await viewText(alice);
    await setCursor(alice, t.indexOf('All good.') + 'All good.'.length);
    await sleep(150);
    await alice.keyboard.type(`\n\n![a square|60](${info.url})\n`);
    const fig = alice.locator('.editor-page .cm-image-figure img');
    await fig.first().waitFor({ timeout: 8000 });
    await alice.waitForFunction(() => (document.querySelector('.editor-page .cm-image-figure img')?.style.width) === '60px');
    // Drag the grip 40px to the right.
    await alice.locator('.editor-page .cm-image-figure').first().hover();
    const grip = alice.locator('.editor-page .cm-image-grip').first();
    const box = await grip.boundingBox();
    await alice.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await alice.mouse.down();
    await alice.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 6 });
    await alice.mouse.up();
    await alice.waitForFunction(() => /!\[a square\s*\|\s*1\d\d\]/.test(window.__anima.view.state.doc.toString()), null, { timeout: 8000 });
    const w = /!\[a square\s*\|\s*(\d+)\]/.exec(await viewText(alice))[1];
    assert(Number(w) >= 90 && Number(w) <= 110, `width after drag: ${w}`);
    // The wiki renders the width attribute.
    const wiki = await (await fetch(`${ORIGIN}/w/paper-wiki/`)).text();
    assert(wiki.includes(`alt="a square" width="${w}"`), 'wiki lacks the width');
  });

  await step('Insert menu: a gallery from uploaded images, and a new sidebar panel', async () => {
    await openDoc(alice, docId, docId);
    const t = await viewText(alice);
    await setCursor(alice, t.indexOf('All good.') + 'All good.'.length);
    await sleep(150);
    // Gallery: two files through the hidden input.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    await alice.locator('.insert-btn').click();
    const chooser = alice.waitForEvent('filechooser');
    await alice.getByRole('menuitem', { name: 'Gallery from images…' }).click();
    await (await chooser).setFiles([{ name: 'one.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }, { name: 'two.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }]);
    await alice.waitForFunction(() => /```gallery\n!\[one\]\(\/media\/[^)]+\)\n!\[two\]\(\/media\/[^)]+\)\n```/.test(window.__anima.view.state.doc.toString()), null, { timeout: 15000 });
    // A new sidebar panel by name.
    await alice.locator('.insert-btn').click();
    await alice.getByRole('menuitem', { name: 'Sidebar panel: new…' }).click();
    const inp = alice.locator('dialog.dialog input.input');
    await inp.waitFor(); await inp.fill('Key facts');
    await alice.locator('dialog.dialog button.btn.primary').click();
    await alice.locator('.editor-page .node-band.is-aside .band-name', { hasText: 'Key facts' }).waitFor({ timeout: 8000 });
    // Rendered: the wiki shows the gallery grid and the new panel.
    const wiki = await (await fetch(`${ORIGIN}/w/paper-wiki/`)).text();
    assert(wiki.includes('class="md-gallery"') && wiki.includes('Key facts'), 'wiki lacks gallery or panel');
    assert(!wiki.includes('In this section'), 'duplicate page list still there');
  });

  await step('tables are edited in place: type in a cell, Tab adds a row, the toolbar adds a column; the markdown follows', async () => {
    await openDoc(alice, docId, docId);
    const t = await viewText(alice);
    await setCursor(alice, t.indexOf('All good.') + 'All good.'.length);
    await sleep(150);
    await alice.locator('.tb-btn[aria-label="Insert table"]').click();
    await alice.waitForFunction(() => window.__anima.view.state.doc.toString().includes('| Column 1 | Column 2 | Column 3 |'));
    // Leave the table: it renders as a widget.
    await setCursor(alice, 0);
    const widget = alice.locator('.cm-table-widget.editable', { hasText: 'Column 1' }); // the aside tables are widgets too
    const cell = widget.locator('td').first();
    await cell.waitFor({ timeout: 8000 });
    await cell.click();
    await alice.keyboard.press('Meta+a');
    await alice.keyboard.type('Rewritten');
    await alice.keyboard.press('Tab');
    await alice.waitForFunction(() => /\| Rewritten\s+\| Cell/.test(window.__anima.view.state.doc.toString()), null, { timeout: 8000 });
    // The rebuilt widget takes the focus back a frame later: wait for the caret before counting Tabs.
    await alice.waitForFunction(() => !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.cm-table-widget td')), null, { timeout: 5000 });
    // The focus moved on to the next cell in the rebuilt widget; Tab through to the end adds a row.
    // Each Tab rebuilds the widget: wait for the focus to land in another cell before the next one.
    // (No string evaluation here: the app's CSP has no unsafe-eval.)
    const cellAt = () => { const a = document.activeElement; const td = a && a.closest ? a.closest('td,th') : null; if (!td) return null; const tr = td.parentElement; const rows = [...td.closest('table').querySelectorAll('tr')]; return `${rows.indexOf(tr)}:${[...tr.children].indexOf(td)}`; };
    for (let i = 0; i < 5; i++) {
      const before = await alice.evaluate(cellAt);
      await alice.keyboard.press('Tab');
      await alice.waitForFunction((b) => { const a = document.activeElement; const td = a && a.closest ? a.closest('td,th') : null; if (!td) return false; const tr = td.parentElement; const rows = [...td.closest('table').querySelectorAll('tr')]; return `${rows.indexOf(tr)}:${[...tr.children].indexOf(td)}` !== b; }, before, { timeout: 5000 });
    }
    // This table (not the aside ones) has three body rows now.
    await alice.waitForFunction(() => /\| Column 1[^\n]*\n\|[-| :]+\n(?:\|[^\n]*\n){3}/.test(window.__anima.view.state.doc.toString() + '\n'), null, { timeout: 8000 });
    // Toolbar: a column.
    await alice.locator('.cm-table-widget.editable', { hasText: 'Column 1' }).hover();
    await alice.locator('.cm-table-widget.editable', { hasText: 'Column 1' }).locator('.cm-table-bar button', { hasText: '+ col' }).click();
    await alice.waitForFunction(() => /\| Column 1\s+\|\s+\| Column 2/.test(window.__anima.view.state.doc.toString()), null, { timeout: 8000 });
    // Drag the first column's edge: the separator grows into a width. (Let the rewritten widget settle first.)
    await alice.waitForFunction(() => document.querySelectorAll('.cm-table-widget.editable')[0] && [...document.querySelectorAll('.cm-table-widget.editable')].some((w) => w.textContent.includes('Column 1') && w.querySelectorAll('th').length === 4), null, { timeout: 8000 });
    await sleep(300);
    const th = alice.locator('.cm-table-widget.editable', { hasText: 'Column 1' }).locator('th').first();
    const grip = th.locator('.cm-col-grip');
    const gb = await grip.boundingBox();
    await alice.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
    await alice.mouse.down();
    await alice.mouse.move(gb.x + gb.width / 2 + 120, gb.y + gb.height / 2, { steps: 6 });
    await alice.mouse.up();
    try {
      await alice.waitForFunction(() => /\| -{20,} \|/.test(window.__anima.view.state.doc.toString()), null, { timeout: 8000 });
    } catch (e) { throw new Error(`no width written; doc around the table: ${JSON.stringify((await viewText(alice)).match(/\| Column 1[\s\S]{0,400}/)?.[0])}`); }
    await alice.waitForFunction(() => [...document.querySelectorAll('.cm-table-widget.editable th')].some((th) => /ch$/.test(th.style.width)), null, { timeout: 8000 });
    await alice.screenshot({ path: join(SHOTS, 'table.png') });
  });

  await step('nested numbered lists: Tab nests under the item above with the parent’s marker width and restarts at 1; Shift-Tab returns', async () => {
    await openDoc(alice, docId, docId);
    const text = await viewText(alice);
    await setCursor(alice, text.length);
    await alice.keyboard.press('Enter'); await alice.keyboard.press('Enter');
    await alice.keyboard.type('1. first');
    await alice.keyboard.press('Enter');
    await alice.keyboard.type('second');
    await alice.keyboard.press('Tab');
    await alice.waitForFunction(() => window.__anima.view.state.doc.toString().endsWith('1. first\n   1. second'), null, { timeout: 5000 });
    await alice.keyboard.press('Enter');
    await alice.keyboard.type('third');
    await alice.waitForFunction(() => window.__anima.view.state.doc.toString().endsWith('1. first\n   1. second\n   2. third'), null, { timeout: 5000 });
    await alice.keyboard.press('Shift+Tab');
    await alice.waitForFunction(() => window.__anima.view.state.doc.toString().endsWith('1. first\n   1. second\n2. third'), null, { timeout: 5000 });
  });

  await step('an empty section needs no dialog; math renders in the preview', async () => {
    await alice.keyboard.press('Enter'); await alice.keyboard.press('Enter');
    await alice.keyboard.type('Energy $E = mc^2$ here.');
    await alice.keyboard.press('Enter'); await alice.keyboard.press('Enter');
    const bands = await alice.locator('.editor-page .node-band').count();
    await alice.locator('.insert-btn').click();
    await alice.getByRole('menuitem', { name: 'New empty section' }).click();
    await alice.waitForFunction((n) => document.querySelectorAll('.editor-page .node-band').length === n + 1, bands, { timeout: 8000 });
    assert((await alice.locator('dialog.dialog').count()) === 0, 'a dialog opened for an empty section');
    assert((await alice.locator('.editor-page .node-band-end').count()) === 0, '"end of" bands are back');
    await alice.locator('.seg-btn[data-mode=split]').click();
    await alice.locator('.preview-body .math-inline .katex').first().waitFor({ timeout: 8000 });
    await alice.locator('.seg-btn[data-mode=edit]').click();
  });

  await step('media: a YouTube address embeds a frame; an uploaded audio file becomes a player; a PDF becomes a file link', async () => {
    await alice.locator('.seg-btn[data-mode=edit]').click();
    await alice.keyboard.press('Enter'); await alice.keyboard.press('Enter');
    await alice.locator('.insert-btn').click();
    await alice.getByRole('menuitem', { name: 'YouTube or Vimeo video…' }).click();
    const inp = alice.locator('dialog.dialog input.input');
    await inp.waitFor(); await inp.fill('https://youtu.be/dQw4w9WgXcQ');
    await alice.locator('dialog.dialog button.btn.primary').click();
    await waitText(alice, '![](https://youtu.be/dQw4w9WgXcQ)');
    await alice.locator('.editor-page .cm-image-figure.embed-youtube iframe').waitFor({ timeout: 8000 });
    // Audio and a PDF through the Insert menu's file choosers.
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(500, 1)]);
    await alice.locator('.insert-btn').click();
    let chooser = alice.waitForEvent('filechooser');
    await alice.getByRole('menuitem', { name: 'Audio or video file…' }).click();
    await (await chooser).setFiles([{ name: 'talk.mp3', mimeType: 'audio/mpeg', buffer: mp3 }]);
    await alice.waitForFunction(() => /!\[talk\]\(\/media\/[0-9a-f]{32}\.mp3\)/.test(window.__anima.view.state.doc.toString()), null, { timeout: 15000 });
    await alice.locator('.insert-btn').click();
    chooser = alice.waitForEvent('filechooser');
    await alice.getByRole('menuitem', { name: 'Any file…' }).click();
    await (await chooser).setFiles([{ name: 'paper.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 x') }]);
    await alice.waitForFunction(() => /\[paper\.pdf\]\(\/media\/[0-9a-f]{32}\.pdf\)/.test(window.__anima.view.state.doc.toString()), null, { timeout: 15000 });
    await alice.locator('.seg-btn[data-mode=split]').click();
    await alice.locator('.preview-body .md-frame iframe[src^="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"]').waitFor({ timeout: 8000 });
    await alice.locator('.preview-body .md-audio audio').waitFor({ timeout: 8000 });
    await alice.locator('.preview-body a.md-file', { hasText: 'paper.pdf' }).waitFor({ timeout: 8000 });
    await alice.locator('.seg-btn[data-mode=edit]').click();
  });

  await step('an HTML page: the source edits with HTML highlighting, the page renders in a sandboxed frame, scripts run', async () => {
    const page = (await api(alice, 'POST', '/api/docs', { title: 'Widget', type: 'html', content: '<!doctype html><title>Widget</title><body><h1 id="h">Hello</h1><script>document.getElementById("h").textContent = "Hello from JS"</script></body>' })).json;
    await openDoc(alice, page.id);
    await alice.waitForFunction(() => document.querySelector('.doc-app')?.classList.contains('html-doc'), null, { timeout: 8000 });
    assert(await alice.locator('.doc-header-right .open-page').isVisible(), 'no Open page link');
    // An HTML page opens as the page (preview), whatever mode the person last used for documents.
    await alice.waitForFunction(() => document.querySelector('.doc-app')?.dataset.mode === 'preview', null, { timeout: 8000 });
    await alice.locator('.seg-btn[data-mode=split]').click();
    const frame = alice.locator('.preview-pane iframe.page-frame');
    await frame.waitFor({ timeout: 8000 });
    assert((await frame.getAttribute('sandbox') ?? '').includes('allow-scripts') && !(await frame.getAttribute('sandbox') ?? '').includes('allow-same-origin'), 'frame sandbox');
    // The page's own address shows the app around it for a person: the header (share, more) and the framed page.
    await alice.goto(`${ORIGIN}/p/${page.id}`);
    await alice.waitForFunction(() => document.querySelector('.doc-app')?.classList.contains('html-doc') && document.querySelector('.doc-app')?.dataset.mode === 'preview', null, { timeout: 8000 });
    assert(alice.url().endsWith(`/p/${page.id}`), `address changed to ${alice.url()}`);
    assert((await alice.locator('.doc-header-right .btn', { hasText: 'Share' }).count()) === 1, 'no Share control at /p/');
    await alice.frameLocator('.preview-pane iframe.page-frame').locator('#h', { hasText: 'Hello from JS' }).waitFor({ timeout: 8000 });
    await alice.locator('.seg-btn[data-mode=split]').click();
    // Playwright can look inside the (opaque-origin) frame: the page rendered and its script ran.
    await alice.frameLocator('.preview-pane iframe.page-frame').locator('#h', { hasText: 'Hello from JS' }).waitFor({ timeout: 8000 });
    // The page itself says what it is.
    const served = await alice.evaluate(async (id) => { const r = await fetch(`/p/${id}`); return { status: r.status, csp: r.headers.get('content-security-policy'), text: await r.text() }; }, page.id);
    assert(served.status === 200 && served.csp.startsWith('sandbox allow-scripts') && served.text.includes('Hello from JS'), `served: ${JSON.stringify(served).slice(0, 200)}`);
    // A real browser runs it: open the page top-level in a fresh tab and read the DOM.
    const tab = await alice.context().newPage();
    await tab.goto(`${ORIGIN}/p/${page.id}?raw=1`); // the bare page (a person without ?raw gets the app around it)
    await tab.waitForFunction(() => document.getElementById('h')?.textContent === 'Hello from JS', null, { timeout: 8000 });
    assert(await tab.evaluate(() => { try { return window.origin === 'null' && document.cookie === ''; } catch { return true; } }), 'page is not isolated');
    await tab.close();
    // Editing the source updates the page (after it settles).
    await alice.locator('.editor-page .cm-content').click();
    await alice.keyboard.press('Meta+a');
    await alice.keyboard.type('<!doctype html><title>Widget</title><body><h1 id="h">Second</h1></body>');
    await alice.waitForFunction((id) => fetch(`/p/${id}`).then((r) => r.text()).then((t) => t.includes('Second')), page.id, { timeout: 8000 });
    await alice.frameLocator('.preview-pane iframe.page-frame').locator('#h', { hasText: 'Second' }).waitFor({ timeout: 8000 });
    await alice.locator('.seg-btn[data-mode=edit]').click();
  });

  await step('an HTML page is placed in a space from its ⋯ menu; that shares it with the space’s readers, who get the rendered page', async () => {
    const page = (await api(alice, 'POST', '/api/docs', { title: 'Dashboard', type: 'html', content: '<!doctype html><title>Dashboard</title><body><h1 id="h">Numbers</h1></body>' })).json;
    // Bob can open the space (editor of Paper) but not this private page. (Checked from here, so the expected 404 is no console error in his page.)
    const bobCookie = (await bob.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
    assert((await fetch(`${ORIGIN}/api/docs/${page.id}`, { headers: { Cookie: bobCookie } })).status === 404, 'Bob should not see the page yet');
    await openDoc(alice, page.id);
    // The left panel: choosing a space shows its pages without leaving this document, and offers to add the document to it.
    if (!(await alice.evaluate(() => document.querySelector('.doc-app').classList.contains('nav-open')))) await alice.locator('.nav-btn').click();
    await alice.locator('.doc-nav .nav-space-btn').click();
    await alice.locator('.nav-space-pop .nav-space-item', { hasText: 'Paper' }).click();
    await alice.locator('.doc-nav .nav-add-here button', { hasText: 'Add it here' }).waitFor({ timeout: 8000 });
    assert(alice.url().includes(`/d/${page.id}`), 'choosing a space navigated away');
    await alice.locator('.doc-nav .nav-add-here button', { hasText: 'Add it here' }).click();
    await alice.locator('.doc-nav .nav-pages .nav-row', { hasText: 'Dashboard' }).waitFor({ timeout: 8000 });
    assert((await alice.locator('.doc-nav .nav-pages .nav-row', { hasText: 'Dashboard' }).locator('.type-chip').textContent()) === 'HTML', 'no HTML chip in the tree');
    // Placement shared it: Bob can read it and gets the page as itself.
    assert((await fetch(`${ORIGIN}/api/docs/${page.id}`, { headers: { Cookie: bobCookie } })).status === 200, 'placement did not share the page');
    const served = await bob.evaluate(async (id) => { const r = await fetch(`/p/${id}`); return { status: r.status, text: await r.text() }; }, page.id);
    assert(served.status === 200 && served.text.includes('Numbers'), `Bob /p: ${served.status}`);
    await openDoc(bob, page.id, docId);
    // Through the placement Bob is an editor (derived access caps there), so he keeps his mode; Split shows the page.
    await bob.waitForFunction(() => document.querySelector('.doc-app')?.dataset.mode === 'preview', null, { timeout: 8000 });
    await bob.frameLocator('.preview-pane iframe.page-frame').locator('#h', { hasText: 'Numbers' }).waitFor({ timeout: 8000 });
  });

  await step('attached files: uploaded in the Files dialog, loaded by the page through its signed path, listed for agents', async () => {
    const page = (await api(alice, 'POST', '/api/docs', { title: 'Chart', type: 'html', content: '<!doctype html><title>Chart</title><body><p id="out">loading</p><script>fetch("data/sim.json").then((r) => r.json()).then((d) => { document.getElementById("out").textContent = "n=" + d.n; }).catch((e) => { document.getElementById("out").textContent = "failed: " + e; });</script></body>' })).json;
    // The data file over the API first (so the page never asks for a file that is not there), then the page reads it through its signed path.
    const put = await alice.evaluate(async (id) => (await fetch(`/api/docs/${id}/files/data/sim.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ n: 42 }) })).status, page.id);
    assert(put === 201, `put ${put}`);
    await openDoc(alice, page.id);
    await alice.frameLocator('.preview-pane iframe.page-frame').locator('#out', { hasText: 'n=42' }).waitFor({ timeout: 10000 });
    // A second file through the dialog.
    await alice.locator('.doc-header-right .icon-btn[aria-label="More document actions"]').click();
    await alice.getByRole('menuitem', { name: 'Attached files…' }).click();
    const dlg = alice.locator('dialog.dialog', { hasText: 'Attached files' });
    await dlg.waitFor();
    await dlg.locator('.file-row .file-path', { hasText: 'data/sim.json' }).waitFor({ timeout: 8000 });
    const chooser = alice.waitForEvent('filechooser');
    await dlg.locator('button', { hasText: 'Upload files…' }).click();
    await (await chooser).setFiles([{ name: 'index.md', mimeType: 'text/markdown', buffer: Buffer.from('# Chart\n\nReads data/sim.json.') }]);
    await dlg.locator('.file-row .file-path', { hasText: 'index.md' }).waitFor({ timeout: 8000 });
    await dlg.locator('button', { hasText: 'Close' }).click();
    const files = (await api(alice, 'GET', `/api/docs/${page.id}/files`)).json.files.map((f) => f.path);
    assert(files.join() === 'data/sim.json,index.md', files.join());
  });

  await step('annotating a page: select text in the rendered page → comment on it; the comment highlights in the page; double-click edits the text', async () => {
    const page = (await api(alice, 'POST', '/api/docs', { title: 'Memo', type: 'html', content: '<!doctype html><title>Memo</title><body><h1>Memo</h1><p id="p1">We ship the thing in March.</p><p id="p2">Budget is &amp; stays flat.</p></body>' })).json;
    await openDoc(alice, page.id);
    const frame = alice.frameLocator('.preview-pane iframe.page-frame');
    await frame.locator('#p1').waitFor({ timeout: 8000 });
    // Select "the thing" inside the page and use its Comment button.
    await frame.locator('#p1').evaluate((p) => { const t = p.firstChild; const r = document.createRange(); r.setStart(t, 8); r.setEnd(t, 17); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
    await frame.locator('.anima-bar button', { hasText: 'Comment' }).click();
    // The app's composer opened on that text; type and send.
    const composer = alice.locator('textarea.comment-input').first();
    await composer.waitFor({ timeout: 8000 });
    await composer.fill('Is it really March?');
    await composer.press('Meta+Enter');
    await alice.waitForFunction(() => window.__anima.nodes.allThreads().some((t) => t.quote === 'the thing' && t.comments[0]?.body === 'Is it really March?'), null, { timeout: 8000 });
    // The page highlights it.
    await frame.locator('mark.anima-mark[data-thread]', { hasText: 'the thing' }).waitFor({ timeout: 8000 });
    // Double-click a text run, edit it, confirm: the source changes.
    await frame.locator('#p2').dblclick();
    const edit = frame.locator('.anima-edit');
    await edit.waitFor({ timeout: 5000 });
    await alice.keyboard.press('Meta+a'); await alice.keyboard.type('Budget is & grows.'); await alice.keyboard.press('Enter');
    await alice.locator('dialog.dialog button.btn.primary', { hasText: 'Replace' }).click();
    await alice.waitForFunction(() => window.__anima.view.state.doc.toString().includes('<p id="p2">Budget is & grows.</p>'), null, { timeout: 8000 });
  });

  await step('annotating a markdown document in Preview: select rendered text → comment; the comment highlights; double-click edits the text', async () => {
    const d = (await api(alice, 'POST', '/api/docs', { title: 'Plan', content: '# Plan\n\nWe ship **the thing** in March.\n\nBudget stays flat.\n' })).json;
    await openDoc(alice, d.id);
    await alice.locator('.seg-btn[data-mode=preview]').click();
    const body = alice.locator('.preview-body');
    await body.locator('p', { hasText: 'We ship' }).waitFor({ timeout: 8000 });
    // Select "ship the thing" across the <strong> and use the Comment bar.
    await body.locator('p', { hasText: 'We ship' }).evaluate((p) => { const r = document.createRange(); r.setStart(p.firstChild, 3); r.setEnd(p.querySelector('strong').firstChild, 9); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
    await alice.locator('.anima-bar button', { hasText: 'Comment' }).click();
    const composer = alice.locator('textarea.comment-input').first();
    await composer.waitFor({ timeout: 8000 });
    await composer.fill('Which thing?');
    await composer.press('Meta+Enter');
    await alice.waitForFunction(() => window.__anima.nodes.allThreads().some((t) => t.quote === 'ship **the thing' && t.comments[0]?.body === 'Which thing?'), null, { timeout: 8000 });
    await body.locator('mark.anima-mark[data-thread]').first().waitFor({ timeout: 8000 });
    // Double-click the second paragraph, edit, confirm: the markdown source changes.
    await body.locator('p', { hasText: 'Budget' }).dblclick();
    const edit = body.locator('.anima-edit');
    await edit.waitFor({ timeout: 5000 });
    await alice.keyboard.press('Meta+a'); await alice.keyboard.type('Budget grows.'); await alice.keyboard.press('Enter');
    await alice.locator('dialog.dialog button.btn.primary', { hasText: 'Replace' }).click();
    await alice.waitForFunction(() => window.__anima.view.state.doc.toString().includes('\nBudget grows.\n'), null, { timeout: 8000 });
    await alice.locator('.seg-btn[data-mode=edit]').click();
  });

  await step('clicking a comment brings its anchor into view: far down a long document in the editor, and the highlight in Preview', async () => {
    const paras = Array.from({ length: 160 }, (_, i) => `Paragraph ${i + 1} of the long report, with enough words to take a line or two on screen.`);
    const d = (await api(alice, 'POST', '/api/docs', { title: 'Long report', content: `# Long report\n\n${paras.join('\n\n')}\n` })).json;
    await openDoc(alice, d.id);
    await alice.locator('.seg-btn[data-mode=edit]').click();
    // Comment on the last paragraph (selection set in the editor; the rail's composer).
    await alice.evaluate(() => { const { view, rail } = window.__anima; const t = view.state.doc.toString(); const i = t.indexOf('Paragraph 160'); view.dispatch({ selection: { anchor: i, head: i + 13 }, scrollIntoView: true }); rail.startDraft(); });
    const composer = alice.locator('textarea.comment-input').first();
    await composer.waitFor({ timeout: 8000 });
    await composer.fill('Last one.');
    await composer.press('Meta+Enter');
    await alice.waitForFunction(() => window.__anima.nodes.allThreads().some((t) => t.quote === 'Paragraph 160'), null, { timeout: 8000 });
    const onScreen = () => alice.evaluate(() => { const v = window.__anima.view; const i = v.state.doc.toString().indexOf('Paragraph 160'); const c = v.coordsAtPos(i); if (!c) return false; const s = document.querySelector('.edit-pane').getBoundingClientRect(); return c.top >= s.top && c.bottom <= s.bottom; });
    // Scroll to the top, open the list of comments and click the card: the anchor comes back on screen.
    await alice.evaluate(() => { document.querySelector('.edit-pane').scrollTop = 0; window.__anima.view.dispatch({ selection: { anchor: 0 } }); });
    await alice.waitForFunction(() => document.querySelector('.edit-pane').scrollTop === 0);
    assert(!(await onScreen()), 'the anchor should be off screen after scrolling to the top');
    await alice.locator('button.comments-btn').click();
    await alice.locator('.comment-rail.drawer .thread-card', { hasText: 'Last one.' }).click();
    await alice.waitForFunction(() => { const v = window.__anima.view; const i = v.state.doc.toString().indexOf('Paragraph 160'); const c = v.coordsAtPos(i); if (!c) return false; const s = document.querySelector('.edit-pane').getBoundingClientRect(); return c.top >= s.top && c.bottom <= s.bottom; }, null, { timeout: 8000 });
    // In Preview the highlight is what scrolls into view.
    await alice.locator('.seg-btn[data-mode=preview]').click();
    await alice.locator('.preview-body mark.anima-mark[data-thread]').waitFor({ timeout: 8000 });
    await alice.evaluate(() => { document.querySelector('.preview-pane').scrollTop = 0; });
    await alice.locator('.comment-rail.drawer .thread-card', { hasText: 'Last one.' }).click();
    await alice.waitForFunction(() => { const m = document.querySelector('.preview-body mark.anima-mark[data-thread]'); const r = m.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; }, null, { timeout: 8000 });
    await alice.locator('button.comments-btn').click();
    await alice.locator('.seg-btn[data-mode=edit]').click();
  });

  await step('comment congestion: twenty threads on the first lines stack beside the text as closed cards; clicking a far-down card brings its anchor back on screen; the open card collapses again', async () => {
    const paras = Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1} of the busy report, with enough words to take a line or two on screen.`);
    const d = (await api(alice, 'POST', '/api/docs', { title: 'Busy report', content: `# Busy report\n\n${paras.join('\n\n')}\n` })).json;
    for (let i = 0; i < 20; i++) await api(alice, 'POST', '/api/operations/add_comment', { document: d.id, quote: `Paragraph ${(i % 3) + 1} of the busy`, text: `Thread ${i + 1}: a remark that runs on for a couple of lines so the card has some height to it, and then some more.` });
    await openDoc(alice, d.id);
    await alice.locator('.seg-btn[data-mode=edit]').click();
    await alice.locator('.comment-rail.margin .thread-card.placed').nth(19).waitFor({ timeout: 10000 });
    // Closed cards are small; replies are summarised. Scroll the pane to where the last cards sit.
    const closed = await alice.locator('.comment-rail.margin .thread-card.closed').count();
    assert(closed >= 19, `expected the cards to be closed, got ${closed}`);
    const lastCard = alice.locator('.comment-rail.margin .thread-card', { hasText: 'Thread 20:' });
    await alice.evaluate(() => { const pane = document.querySelector('.edit-pane'); pane.scrollTop = pane.scrollHeight; });
    await lastCard.scrollIntoViewIfNeeded();
    const anchorOnScreen = () => alice.evaluate(() => { const v = window.__anima.view; const i = v.state.doc.toString().indexOf('Paragraph 2 of'); const c = v.coordsAtPos(i); if (!c) return false; const s = document.querySelector('.edit-pane').getBoundingClientRect(); return c.top >= s.top && c.bottom <= s.bottom; });
    assert(!(await anchorOnScreen()), 'the anchor should be off screen before the click');
    await lastCard.click();
    await alice.waitForFunction(() => { const v = window.__anima.view; const i = v.state.doc.toString().indexOf('Paragraph 2 of'); const c = v.coordsAtPos(i); if (!c) return false; const s = document.querySelector('.edit-pane').getBoundingClientRect(); return c.top >= s.top && c.bottom <= s.bottom; }, null, { timeout: 8000 });
    // The clicked card is open (not closed) and has a collapse button; collapsing closes it again.
    await alice.locator('.comment-rail.margin .thread-card.active:not(.closed)', { hasText: 'Thread 20:' }).waitFor({ timeout: 5000 });
    await alice.locator('.thread-card.active .collapse-btn').click();
    await alice.locator('.comment-rail.margin .thread-card.closed', { hasText: 'Thread 20:' }).waitFor({ timeout: 5000 });
    assert((await alice.locator('.thread-card.active').count()) === 0, 'no card should be active after collapsing');
    // Search in the drawer: by text, then by something only a reply says.
    await api(alice, 'POST', '/api/operations/list_comments', { document: d.id }).then(async (r) => { const id = /\[(c\w+)\]/.exec(r.json.content[0].text)[1]; await api(alice, 'POST', '/api/operations/reply_comment', { comment: id, text: 'A reply mentioning the zebra budget.' }); });
    await alice.locator('button.comments-btn').click();
    const search = alice.locator('.comment-rail.drawer .rail-search-input');
    await search.click(); await alice.keyboard.type('Thread 20:'); // typed key by key: focus must survive every re-render
    assert((await search.inputValue()) === 'Thread 20:', `typing lost focus: ${await search.inputValue()}`);
    await alice.waitForFunction(() => document.querySelectorAll('.comment-rail.drawer .thread-card').length === 1, null, { timeout: 5000 });
    assert((await alice.locator('.comment-rail.drawer .thread-card').innerText()).includes('Thread 20:'), 'the matching card');
    await search.fill('zebra');
    await alice.waitForFunction(() => document.querySelectorAll('.comment-rail.drawer .thread-card').length === 1, null, { timeout: 5000 });
    await alice.locator('.comment-rail.drawer .thread-card .card-match mark', { hasText: 'zebra' }).waitFor({ timeout: 5000 });
    await search.fill('nothing like this');
    await alice.locator('.comment-rail.drawer .empty-state', { hasText: 'No comments match' }).waitFor({ timeout: 5000 });
    await search.press('Escape');
    await alice.waitForFunction(() => document.querySelectorAll('.comment-rail.drawer .thread-card').length === 20, null, { timeout: 5000 });
    await alice.locator('button.comments-btn').click();
  });

  await step('Preview shows open suggestions as applied: the insertion highlighted, the deletion struck; the bar hides and shows them', async () => {
    const d = (await api(alice, 'POST', '/api/docs', { title: 'Fruit', content: '# Fruit\n\nIntro about apples and figs.\n' })).json;
    const bobSub = (await api(bob, 'GET', '/api/me')).json.you.sub;
    assert((await api(alice, 'POST', `/api/docs/${d.id}/share`, { who: bobSub, role: 'commenter' })).status === 200, 'share with Bob');
    const s = await api(bob, 'POST', '/api/operations/suggest_edit', { document: d.id, edits: [{ old_text: 'apples', new_text: 'pears' }] });
    assert(!s.json.isError, `suggest_edit: ${JSON.stringify(s.json).slice(0, 200)}`);
    await openDoc(alice, d.id);
    await alice.locator('.seg-btn[data-mode=preview]').click();
    await alice.locator('.preview-body ins.sugg-ins', { hasText: 'pears' }).waitFor({ timeout: 8000 });
    await alice.locator('.preview-body del.sugg-del', { hasText: 'apples' }).waitFor({ timeout: 8000 });
    assert((await alice.locator('.preview-sugg-bar').innerText()).includes('1 open suggestion shown as applied'), 'the bar counts');
    await alice.locator('.preview-sugg-bar button', { hasText: 'Hide' }).click();
    await alice.locator('.preview-body ins.sugg-ins').waitFor({ state: 'detached', timeout: 5000 });
    assert((await alice.locator('.preview-body').innerText()).includes('Intro about apples and figs.'), 'the text as it is');
    await alice.locator('.preview-sugg-bar button', { hasText: 'Show as applied' }).click();
    await alice.locator('.preview-body ins.sugg-ins', { hasText: 'pears' }).waitFor({ timeout: 5000 });
    await alice.locator('.seg-btn[data-mode=edit]').click();
  });

  await step('a document with an anyone-with-the-link link shows that link as its address, and the link address reloads to the document', async () => {
    const d = (await api(alice, 'POST', '/api/docs', { title: 'Open notes', content: '# Open notes\n\nShared with the world.\n' })).json;
    const link = (await api(alice, 'POST', `/api/docs/${d.id}/links`, { role: 'viewer', who: 'anyone' })).json;
    const key = link.url.split('/l/')[1];
    await openDoc(alice, d.id);
    await alice.waitForFunction((k) => location.pathname === `/l/${k}`, key, { timeout: 8000 });
    await alice.locator('.editor-page .cm-content').waitFor({ state: 'attached' });
    // Reloading the shareable address lands on the document, address unchanged.
    await alice.goto(`${ORIGIN}/l/${key}`);
    await alice.locator('.editor-page .cm-content').waitFor({ state: 'attached', timeout: 10000 });
    await alice.waitForFunction((k) => location.pathname === `/l/${k}`, key, { timeout: 8000 });
    assert((await alice.locator('.doc-title').inputValue()) === 'Open notes', 'wrong document');
    // Without such a link the address stays the document's own.
    const priv = (await api(alice, 'POST', '/api/docs', { title: 'Private notes', content: 'x' })).json;
    await openDoc(alice, priv.id);
    await sleep(500);
    assert(alice.url().endsWith(`/d/${priv.id}`), `private doc address changed: ${alice.url()}`);
  });

  await step('⌘F opens the editor’s search even when the editor is not focused; a match far down is found and shown', async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `Line ${i} of the document${i === 70 ? ' with needle inside' : ''}.`);
    const d = (await api(alice, 'POST', '/api/docs', { title: 'Search me', content: `# Search me\n\n${lines.join('\n\n')}\n` })).json;
    await openDoc(alice, d.id);
    await alice.locator('.seg-btn[data-mode=edit]').click();
    await alice.locator('.doc-nav').click({ position: { x: 10, y: 400 } }).catch(() => {}); // focus away from the editor
    await alice.keyboard.press('Meta+f');
    const search = alice.locator('.cm-search input[name=search]');
    await search.waitFor({ timeout: 5000 });
    await search.fill('needle');
    await alice.keyboard.press('Enter'); await alice.keyboard.press('Enter');
    await alice.waitForFunction(() => { const s = window.__anima.view.state.selection.main; return window.__anima.view.state.doc.sliceString(s.from, s.to) === 'needle'; }, null, { timeout: 5000 });
    assert(await alice.locator('.cm-searchMatch-selected').isVisible(), 'match not scrolled into view');
    await alice.keyboard.press('Escape');
  });

  await step('groups: made on the Groups page, a member added by exact name, a document shared with the group from the share dialog; the member can open it', async () => {
    const d = (await api(alice, 'POST', '/api/docs', { title: 'Team notes', content: '# Team notes\n\nfor the team\n' })).json;
    const bobCookie = (await bob.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
    assert((await fetch(`${ORIGIN}/api/docs/${d.id}`, { headers: { Cookie: bobCookie } })).status === 404, 'Bob should not see it yet');
    await alice.goto(`${ORIGIN}/groups`);
    await alice.locator('button.btn.primary', { hasText: 'New group' }).click();
    const inp = alice.locator('dialog.dialog input.input');
    await inp.waitFor(); await inp.fill('Research team');
    await alice.locator('dialog.dialog button.btn.primary').click();
    await alice.locator('.group-detail h2', { hasText: 'Research team' }).waitFor({ timeout: 8000 });
    const add = alice.locator('.group-add input.picker-input');
    await add.click(); await alice.keyboard.type('Bob');
    await alice.locator('.picker-option .po-name', { hasText: 'Bob' }).first().click({ timeout: 5000 }).catch(async () => { await add.press('Enter'); });
    await alice.locator('.member-row .share-name', { hasText: 'Bob' }).waitFor({ timeout: 8000 });
    // Share the document with the group from its Share dialog.
    await openDoc(alice, d.id);
    await alice.locator('.doc-header-right .share-btn').click();
    // The group is one click away as a chip (no typing).
    await alice.locator('dialog.dialog .share-groups .group-chip', { hasText: 'Research team' }).click();
    await alice.locator('dialog.dialog .share-row .share-name', { hasText: 'Research team' }).waitFor({ timeout: 8000 });
    assert((await alice.locator('dialog.dialog .share-row', { hasText: 'Research team' }).locator('.kind-group').count()) === 1, 'no group badge in the ACL');
    await alice.keyboard.press('Escape');
    assert((await fetch(`${ORIGIN}/api/docs/${d.id}`, { headers: { Cookie: bobCookie } })).status === 200, 'the member cannot open the shared document');
  });

  await step('⌘-click on a link in the source follows it: a document address in place, an external one in a new tab', async () => {
    const target = (await api(alice, 'POST', '/api/docs', { title: 'Target', content: '# Target\n' })).json;
    const d = (await api(alice, 'POST', '/api/docs', { title: 'Linky', content: `# Linky\n\nSee [the target](/d/${target.id}) and https://example.com/page for more.\n` })).json;
    await openDoc(alice, d.id);
    await alice.locator('.seg-btn[data-mode=edit]').click();
    const text = await viewText(alice);
    const clickAt = async (pos) => { const r = await alice.evaluate((p) => { const v = window.__anima.view; const c = v.coordsAtPos(p); return c ? { x: c.left + 2, y: (c.top + c.bottom) / 2 } : null; }, pos); assert(r, 'no coords'); await alice.keyboard.down('Meta'); await alice.mouse.click(r.x, r.y); await alice.keyboard.up('Meta'); }; // mouse.click's `modifiers` doesn't set metaKey here
    // External: a new page opens.
    const popup = alice.context().waitForEvent('page', { timeout: 8000 });
    await clickAt(text.indexOf('example.com') + 3);
    const p = await popup; assert(p.url().startsWith('https://example.com/page'), `opened ${p.url()}`); await p.close();
    // Internal: navigates in place, without a reload.
    const navEl = await alice.evaluateHandle(() => document.querySelector('.doc-nav'));
    await clickAt(text.indexOf('the target') + 2);
    await alice.waitForFunction((id) => location.pathname === `/d/${id}`, target.id, { timeout: 8000 });
    assert(await alice.evaluate((el) => el.isConnected, navEl), 'page was reloaded instead of switched');
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
