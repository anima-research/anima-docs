// Published trees as wikis: slugs, asides, link rewriting, access, media, custom domains.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './server-harness.js';
import { marker } from '../src/nodes.js';

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer({ DOCS_ADMINS: 'human:test:root' }); });
after(async () => { await S.close(); });

const H = (extra: Record<string, string> = {}) => ({ 'Content-Type': 'application/json', Origin: S.base, ...extra });
async function signIn(name: string): Promise<string> {
  const token = S.iss.mint(name, 'human');
  const r = await fetch(`${S.base}/auth/exchange`, { method: 'POST', headers: H({ Cookie: 'docs_login=x' }), body: JSON.stringify({ token }) });
  const m = /docs_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '');
  return `docs_session=${m![1]}`;
}
const api = async (cookie: string | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${S.base}${path}`, { method, headers: H(cookie ? { Cookie: cookie } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, json, text, headers: r.headers };
};

test('a published tree renders pages with nav, article, asides, TOC and rewritten links; unpublished is private', async () => {
  const ann = await signIn('Ann');
  const facts = (await api(ann, 'POST', '/api/docs', { title: 'Facts', content: '| Born | 1990 |\n|---|---|\n| Home | Lisbon |\n' })).json;
  const method = (await api(ann, 'POST', '/api/docs', { title: 'Method', content: '# Method\n\n## Setup\n\nWe fold the tree.\n\n## Runs\n\nSee [the plan](/d/PLAN) and [the paper](/d/PAPER).\n' })).json;
  const plan = (await api(ann, 'POST', '/api/docs', { title: 'Plan & Goals', content: '# Plan & Goals\n\nThe plan links back to [Method](/d/' + method.id + ').\n' })).json;
  const secret = (await api(ann, 'POST', '/api/docs', { title: 'Secret', content: 'not in the wiki' })).json;
  const paper = (await api(ann, 'POST', '/api/docs', { title: 'Paper', content: `# Paper\n\nIntro text.\n\n${marker(facts.id, 'aside')}\n\n${marker(method.id)}\n` })).json;
  // Fix the placeholder links now that ids are known.
  await api(ann, 'POST', `/api/operations/edit_document`, { document: method.id, edits: [{ old_text: '/d/PLAN', new_text: `/d/${plan.id}` }, { old_text: '/d/PAPER', new_text: `/d/${paper.id}` }] });
  const tree = (await api(ann, 'POST', '/api/trees', { root: paper.id })).json;
  assert.ok(tree.placements.some((p: any) => p.child === method.id), 'Method derived as a subpage');
  assert.ok(!tree.placements.some((p: any) => p.child === facts.id), 'an aside is a panel, not a subpage');
  await api(ann, 'POST', `/api/trees/${paper.id}/place`, { parent: paper.id, child: plan.id });
  // Not published: no page for strangers, a preview for the owner.
  const nothing = await api(null, 'GET', `/w/paper/`);
  assert.equal(nothing.status, 404);
  const pub = await api(ann, 'PATCH', `/api/trees/${paper.id}/publish`, { published: 'public', theme: { name: 'The Paper Wiki', emoji: '📘', accent: '#137a52', footer: 'CC BY' } });
  assert.equal(pub.status, 200, pub.text);
  assert.equal(pub.json.slug, 'paper');
  assert.equal(pub.json.url, `${S.base}/w/paper/`);
  // Home page: the paper, with the aside as an infobox, the nav with pages, and the inline section in the article.
  const home = await api(null, 'GET', '/w/paper/');
  assert.equal(home.status, 200);
  assert.ok(home.text.includes('<title>The Paper Wiki</title>'));
  assert.ok(home.text.includes('Intro text.'));
  assert.ok(home.text.includes('We fold the tree.'), 'inline section in the article');
  assert.ok(/class="panel infobox"[\s\S]*Facts[\s\S]*Lisbon/.test(home.text), 'aside rendered as an infobox');
  assert.ok(!home.text.includes('{{node:'), 'no markers in the output');
  assert.ok(home.text.includes('href="/w/paper/method"') && home.text.includes('href="/w/paper/plan-goals"'), 'nav links by slug');
  assert.ok(home.text.includes('--accent: #137a52') && home.text.includes('CC BY') && home.text.includes('📘'));
  assert.ok(home.text.includes(`href="${S.base}/d/${paper.id}?tree=${paper.id}"`), 'edit link back to the editor');
  // A subpage: TOC, rewritten links, Related (the plan links here), breadcrumb.
  const m = await api(null, 'GET', '/w/paper/method');
  assert.equal(m.status, 200);
  assert.ok(m.text.includes('href="#setup"') && m.text.includes('href="#runs"'), 'contents panel');
  assert.ok(m.text.includes('href="/w/paper/plan-goals"'), 'link to a wiki page rewritten');
  assert.ok(m.text.includes('href="/w/paper/"'), 'link to the root rewritten');
  assert.ok(/Related[\s\S]*plan-goals/.test(m.text), 'related panel lists the page that links here');
  assert.ok(m.text.includes('class="crumbs"'), 'breadcrumb');
  // The page's own H1 is not repeated.
  assert.equal((m.text.match(/<h1>Method<\/h1>/g) ?? []).length, 1);
  assert.ok(!m.text.includes('<h1 id="method">'), 'leading # heading dropped');
  // Something outside the tree stays private: not linked into the wiki, not served.
  const sec = await api(null, 'GET', '/w/paper/secret');
  assert.equal(sec.status, 404);
  // Search and sitemap.
  const s = await api(null, 'GET', '/w/paper/search?q=fold');
  assert.ok(s.text.includes('/w/paper/method'));
  const sm = await api(null, 'GET', '/w/paper/sitemap.xml');
  assert.ok(sm.text.includes(`${S.base}/w/paper/plan-goals`));
  // Caching: an ETag that changes with the text.
  const e1 = m.headers.get('etag')!;
  const again = await fetch(`${S.base}/w/paper/method`, { headers: { 'If-None-Match': e1 } });
  assert.equal(again.status, 304);
  await api(ann, 'POST', '/api/operations/edit_document', { document: method.id, edits: [{ append: '\nMore.\n' }] });
  const m2 = await api(null, 'GET', '/w/paper/method');
  assert.notEqual(m2.headers.get('etag'), e1);
  // Members-only: strangers get a sign-in page, members read.
  await api(ann, 'PATCH', `/api/trees/${paper.id}/publish`, { published: 'members' });
  assert.equal((await api(null, 'GET', '/w/paper/')).status, 401);
  const bob = await signIn('Bob');
  assert.equal((await api(bob, 'GET', '/w/paper/')).status, 200);
  // Off again: gone for Bob, preview for Ann.
  await api(ann, 'PATCH', `/api/trees/${paper.id}/publish`, { published: 'off' });
  assert.equal((await api(bob, 'GET', '/w/paper/')).status, 404);
  assert.equal((await api(ann, 'GET', '/w/paper/')).status, 200);
  // Slugs: validated and unique.
  assert.equal((await api(ann, 'PATCH', `/api/trees/${paper.id}/publish`, { slug: 'Bad Slug!' })).status, 400);
  const other = (await api(ann, 'POST', '/api/docs', { title: 'Other', content: 'x' })).json;
  await api(ann, 'POST', '/api/trees', { root: other.id });
  assert.equal((await api(ann, 'PATCH', `/api/trees/${other.id}/publish`, { slug: 'paper' })).status, 409);
  // Only the owner publishes (a stranger can't even see the tree; an editor is refused).
  assert.equal((await api(bob, 'PATCH', `/api/trees/${paper.id}/publish`, { published: 'public' })).status, 404);
  await api(ann, 'POST', `/api/docs/${paper.id}/share`, { who: 'human:test:bob', role: 'editor' });
  assert.equal((await api(bob, 'PATCH', `/api/trees/${paper.id}/publish`, { published: 'public' })).status, 403);
  void secret;
});

test('image sizes, galleries and custom CSS render in the wiki', async () => {
  const ann = await signIn('Ann');
  const md = '# Gallery page\n\n![a cat|240](https://example.org/cat.png)\n\n![tall|200x300](https://example.org/tall.png)\n\n```gallery\n![First](https://example.org/1.png)\nhttps://example.org/2.png | Second one\n![Third|300](https://example.org/3.png) | Third\n```\n';
  const g = (await api(ann, 'POST', '/api/docs', { title: 'Gallery page', content: md })).json;
  await api(ann, 'POST', '/api/trees', { root: g.id });
  const r = await api(ann, 'PATCH', `/api/trees/${g.id}/publish`, { published: 'public', slug: 'gallery', theme: { css: '.prose { font-family: monospace } /* custom */ </style><script>x</script>' } });
  assert.equal(r.status, 200, r.text);
  const page = await api(null, 'GET', '/w/gallery/');
  assert.ok(page.text.includes('<img src="https://example.org/cat.png" alt="a cat" width="240"'), 'width from |240');
  assert.ok(page.text.includes('alt="tall" width="200" height="300"'), 'width and height from |200x300');
  const gal = /<div class="md-gallery">([\s\S]*?)<\/div>/.exec(page.text)?.[1] ?? '';
  assert.equal((gal.match(/md-gallery-item/g) ?? []).length, 3, 'three gallery items');
  assert.ok(gal.includes('data-caption="Second one"') && gal.includes('href="https://example.org/3.png"'), 'captions and full-size links');
  assert.ok(page.text.includes('<style class="custom">.prose { font-family: monospace } /* custom */ <\\/style>'), 'custom CSS appended with a closing tag defused');
  assert.ok(!/<\/style><script>/.test(page.text), 'no script injection through CSS');
  assert.ok(page.text.includes('dialog class="lightbox"'), 'lightbox present');
  assert.equal((await api(ann, 'PATCH', `/api/trees/${g.id}/publish`, { theme: { css: 'x'.repeat(60_000) } })).status, 413);
});

test('a separator longer than the content is a column width; padding is not', async () => {
  const ann = await signIn('Ann');
  const md = '# W\n\n| Name | Description |\n| ------------------------ | ----------- |\n| a | b |\n\n| X | Y |\n| --- | --- |\n| 1 | 2 |\n';
  const d = (await api(ann, 'POST', '/api/docs', { title: 'W', content: md })).json;
  await api(ann, 'POST', '/api/trees', { root: d.id });
  await api(ann, 'PATCH', `/api/trees/${d.id}/publish`, { published: 'public', slug: 'widths' });
  const page = await api(null, 'GET', '/w/widths/');
  assert.ok(page.text.includes('<th style="width:24ch">Name</th>'), 'width from a long separator');
  assert.ok(!page.text.includes('width:11ch'), 'a separator equal to the content is padding');
  assert.ok(!/<th style="width:3ch">/.test(page.text), 'three dashes are nothing');
});

test('a layout template replaces the page structure; scripts are stripped; {{content}} is required; no duplicate page list', async () => {
  const ann = await signIn('Ann');
  const home = (await api(ann, 'POST', '/api/docs', { title: 'Templated', content: '# Templated\n\nBody text.\n\n## Part\n\nMore.\n' })).json;
  const kid = (await api(ann, 'POST', '/api/docs', { title: 'Kid', content: 'kid' })).json;
  await api(ann, 'POST', '/api/trees', { root: home.id });
  await api(ann, 'POST', `/api/trees/${home.id}/place`, { parent: home.id, child: kid.id });
  const def = (await api(ann, 'GET', '/api/wiki/template')).json;
  assert.ok(def.template.includes('{{content}}') && def.slots.includes('asides'));
  const tpl = '<!doctype html><html><head>{{head}}</head><body><div class="tabs"><a href="#">Article</a><a href="{{editurl}}">Edit</a></div><div id="mw"><div class="l">{{nav}}</div><div class="c"><h1>{{title}}</h1>{{content}}</div><div class="r">{{contents}}</div></div><script>alert(1)</script><img src=x onerror="alert(2)"><p onclick="x()">hi</p></body></html>';
  const r = await api(ann, 'PATCH', `/api/trees/${home.id}/publish`, { published: 'public', slug: 'templated', theme: { template: tpl } });
  assert.equal(r.status, 200, r.text);
  const page = await api(null, 'GET', '/w/templated/');
  assert.ok(page.text.includes('<div class="tabs">') && page.text.includes('<div id="mw">'), 'owner structure used');
  assert.ok(page.text.includes('Body text.') && page.text.includes('href="#part"'), 'content and contents filled');
  assert.ok(page.text.includes(`href="${S.base}/d/${home.id}?tree=${home.id}"`), 'editurl slot');
  assert.ok(!page.text.includes('<script>alert') && !page.text.includes('onerror') && !page.text.includes('onclick'), 'scripts and handlers stripped');
  assert.ok(page.text.includes('<p>hi</p>'), 'harmless markup kept');
  assert.ok(!page.text.includes('In this section'), 'no duplicate page list');
  assert.equal((await api(ann, 'PATCH', `/api/trees/${home.id}/publish`, { theme: { template: '<html><body>no slot</body></html>' } })).status, 400);
  // Back to the standard layout: nav, panels and all.
  await api(ann, 'PATCH', `/api/trees/${home.id}/publish`, { theme: {} });
  const std = await api(null, 'GET', '/w/templated/');
  assert.ok(std.text.includes('class="layout"') && std.text.includes('href="/w/templated/kid"'));
  assert.ok(!std.text.includes('In this section'));
});

test('raw HTML is sanitized unless scripts are allowed, and scripts only run on the wiki host', async () => {
  const ann = await signIn('Ann');
  const md = '# Scripty\n\n<b>bold html</b> <span style="color:red" onclick="x()">span</span>\n\n<script>window.ran = 1</script>\n\n<iframe src="https://example.org"></iframe>\n';
  const d = (await api(ann, 'POST', '/api/docs', { title: 'Scripty', content: md })).json;
  await api(ann, 'POST', '/api/trees', { root: d.id });
  await api(ann, 'PATCH', `/api/trees/${d.id}/publish`, { published: 'public', slug: 'scripty' });
  const safe = await api(null, 'GET', '/w/scripty/');
  assert.ok(safe.text.includes('<b>bold html</b>'), 'harmless HTML kept');
  assert.ok(safe.text.includes('<span style="color:red">span</span>'), 'style kept, handler dropped');
  assert.ok(!safe.text.includes('window.ran') && !safe.text.includes('<iframe'), 'script and frame removed');
  // Members-only wikis cannot allow scripts.
  await api(ann, 'PATCH', `/api/trees/${d.id}/publish`, { published: 'members' });
  assert.equal((await api(ann, 'PATCH', `/api/trees/${d.id}/publish`, { scripts: true })).status, 400);
  await api(ann, 'PATCH', `/api/trees/${d.id}/publish`, { published: 'public' });
  const r = await api(ann, 'PATCH', `/api/trees/${d.id}/publish`, { scripts: true, theme: { template: '<!doctype html><html><body><script>window.tpl = 1</script>{{content}}</body></html>' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.scripts, true);
  // On the app's origin (no wiki host configured here): still stripped, with a note.
  const here = await api(null, 'GET', '/w/scripty/');
  assert.ok(!here.text.includes('window.ran') && !here.text.includes('window.tpl'), 'no scripts on the app origin');
  assert.ok(here.text.includes('scripts-note'), 'the page says where scripts run');
  // A second server with a wiki host: requests to that host get everything raw; /w/ on the origin redirects there.
  const S2 = await startServer({ DOCS_WIKI_HOST: 'wiki.test' });
  try {
    const token = S2.iss.mint('Ann', 'human');
    const ex = await fetch(`${S2.base}/auth/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: S2.base, Cookie: 'docs_login=x' }, body: JSON.stringify({ token }) });
    const cookie = `docs_session=${/docs_session=([^;]+)/.exec(ex.headers.get('set-cookie') ?? '')![1]}`;
    const H2 = { 'Content-Type': 'application/json', Origin: S2.base, Cookie: cookie };
    const d2 = await (await fetch(`${S2.base}/api/docs`, { method: 'POST', headers: H2, body: JSON.stringify({ title: 'Scripty', content: md }) })).json();
    await fetch(`${S2.base}/api/trees`, { method: 'POST', headers: H2, body: JSON.stringify({ root: d2.id }) });
    const pub = await (await fetch(`${S2.base}/api/trees/${d2.id}/publish`, { method: 'PATCH', headers: H2, body: JSON.stringify({ published: 'public', slug: 'scripty', scripts: true, theme: { template: '<!doctype html><html><body><script>window.tpl = 1</script>{{content}}</body></html>' } }) })).json();
    assert.equal(pub.url, 'https://wiki.test/scripty/');
    const { request } = await import('node:http');
    const get = (path: string, host: string) => new Promise<{ status: number; body: string; location: string | undefined }>((resolve, reject) => {
      const u = new URL(S2.base);
      const rq = request({ host: u.hostname, port: u.port, path, method: 'GET', headers: { Host: host } }, (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body, location: res.headers.location })); });
      rq.on('error', reject); rq.end();
    });
    const onHost = await get('/scripty/', 'wiki.test');
    assert.equal(onHost.status, 200, onHost.body.slice(0, 200));
    assert.ok(onHost.body.includes('<script>window.ran = 1</script>') && onHost.body.includes('window.tpl = 1'), 'scripts intact on the wiki host');
    assert.ok(onHost.body.includes('<iframe src="https://example.org"></iframe>'), 'frames intact too');
    const onOrigin = await get('/w/scripty/', new URL(S2.base).host);
    assert.equal(onOrigin.status, 302);
    assert.equal(onOrigin.location, 'https://wiki.test/scripty/');
    // The wiki host never hands out the app (no sessions there): an API call on that host is not the app's API.
    const unknown = await get('/nope/', 'wiki.test');
    assert.equal(unknown.status, 404);
  } finally { await S2.close(); }
});

test('a custom domain serves the wiki at the root of that host; media of public pages is readable without signing in', async () => {
  const ann = await signIn('Ann');
  const home = (await api(ann, 'POST', '/api/docs', { title: 'Handbook', content: '# Handbook\n\nWelcome.\n' })).json;
  await api(ann, 'POST', '/api/trees', { root: home.id });
  const r = await api(ann, 'PATCH', `/api/trees/${home.id}/publish`, { published: 'public', slug: 'handbook', domain: 'wiki.example.org' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.url, 'https://wiki.example.org/');
  // The harness origin is http (no canonical host), so domain routing is exercised through the model only here.
  assert.equal(S.app.trees.rootByDomain('WIKI.example.org'), home.id);
  assert.ok(S.app.trees.isWikiDomain('wiki.example.org'));
  assert.equal((await api(ann, 'PATCH', `/api/trees/${home.id}/publish`, { domain: 'not a domain' })).status, 400);
  // A page's image: uploaded into the page, then fetched without a session.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const up = await fetch(`${S.base}/api/media?doc=${home.id}`, { method: 'POST', headers: { Cookie: ann, Origin: S.base, 'Content-Type': 'image/png' }, body: png });
  assert.equal(up.status, 201, await up.clone().text());
  const info = await up.json();
  assert.equal((await fetch(`${S.base}${info.url}`)).status, 200, 'public: readable without a session');
  await api(ann, 'PATCH', `/api/trees/${home.id}/publish`, { published: 'off' });
  assert.equal((await fetch(`${S.base}${info.url}`)).status, 401, 'unpublished: sign in again');
});

test('math renders with KaTeX; latex and text nodes are wrapped by type; the stylesheet is linked only on pages with math', async () => {
  const ann = await signIn('Ann');
  const formula = (await api(ann, 'POST', '/api/docs', { title: 'Formula', content: 'E = mc^2\n\n\\int_0^1 x\\,dx', type: 'latex' })).json;
  const raw = (await api(ann, 'POST', '/api/docs', { title: 'Raw', content: 'keep <b>this</b> as *is*\n', type: 'text' })).json;
  const page = (await api(ann, 'POST', '/api/docs', { title: 'Math', content: `# Math\n\nInline $x^2$ costs $5 and $6.\n\n$$\n\\sum_{i=1}^n i\n$$\n\n${marker(formula.id)}\n\n${marker(raw.id)}\n` })).json;
  const plain = (await api(ann, 'POST', '/api/docs', { title: 'Plain', content: '# Plain\n\nNo math here.\n' })).json;
  await api(ann, 'POST', '/api/trees', { root: page.id });
  await api(ann, 'POST', `/api/trees/${page.id}/place`, { parent: page.id, child: plain.id });
  const pub = await api(ann, 'PATCH', `/api/trees/${page.id}/publish`, { published: 'public', slug: 'math' });
  assert.equal(pub.status, 200, pub.text);
  const home = await api(null, 'GET', '/w/math/');
  assert.equal(home.status, 200);
  assert.ok(home.text.includes('class="math math-inline"><span class="katex">'), 'inline math');
  assert.ok(home.text.includes('costs $5 and $6.'), 'dollar amounts stay text');
  assert.ok(home.text.includes('class="math math-block"><span class="katex-display">'), 'display math');
  assert.equal((home.text.match(/class="math math-block"/g) ?? []).length, 3, 'the $$ block plus one per latex paragraph');
  assert.ok(home.text.includes('<pre><code class="language-text">keep &lt;b&gt;this&lt;/b&gt; as *is*'), 'text node verbatim');
  assert.ok(home.text.includes('<link rel="stylesheet" href="/katex/katex.min.css">'), 'KaTeX stylesheet on a page with math');
  const other = await api(null, 'GET', '/w/math/plain');
  assert.equal(other.status, 200);
  assert.ok(!other.text.includes('katex.min.css'), 'no stylesheet without math');
});
