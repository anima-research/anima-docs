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
