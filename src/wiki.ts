// A published tree as a public wiki: server-rendered pages with the tree as
// the left nav, the page's flattened text as the article, and aside mounts
// (`{{node:<id>|aside}}`) as sidebar panels, plus automatic Contents,
// "In this section" and "Related" panels. Edit links lead back to the editor.

import { createHash } from 'node:crypto';
import MarkdownIt from 'markdown-it';
import type { StateCore } from 'markdown-it';
type MD = InstanceType<typeof MarkdownIt>;
import type { App } from './app.js';
import { Fault } from './auth.js';
import { outline } from './markdown.js';
import { scanMounts, MAX_DEPTH } from './nodes.js';
import { slugify, type PublishSettings } from './trees.js';

export interface WikiPage { id: string; title: string; slug: string; parent: string | null; depth: number }
interface Assembled { body: string; asides: { id: string; title: string; body: string }[]; nodes: Set<string> }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export class Wiki {
  private md: MD;

  constructor(private app: App) {
    this.md = new MarkdownIt({ html: false, linkify: true, typographer: true });
    this.md.core.ruler.after('inline', 'wiki-task-lists', (state: StateCore) => {
      const tokens = state.tokens;
      for (let i = 2; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
        const first = t.children?.[0];
        const m = first && first.type === 'text' ? /^\[([ xX])\][ \t]/.exec(first.content) : null;
        if (!m || !first) continue;
        first.content = first.content.slice(m[0].length);
        const cb = new state.Token('html_inline', '', 0);
        cb.content = `<input type="checkbox" disabled${m[1] !== ' ' ? ' checked' : ''}> `;
        t.children!.unshift(cb);
      }
      return false;
    });
  }

  // ------------------------------------------------------------------ the tree as pages

  /** Pages of a published tree in nav order, with unique slugs (the root is ''). */
  pages(root: string): WikiPage[] {
    const out: WikiPage[] = [];
    const used = new Set<string>(['']);
    const seen = new Set<string>();
    const add = (id: string, parent: string | null, depth: number) => {
      const d = this.app.docs.get(id);
      if (!d || seen.has(id)) return;
      seen.add(id);
      let slug = depth === 0 ? '' : slugify(d.title || 'page');
      if (depth > 0) { let i = 1; const base = slug; while (used.has(slug)) slug = `${base}-${++i}`; }
      used.add(slug);
      out.push({ id, title: d.title || 'Untitled', slug, parent, depth });
      for (const p of this.app.trees.children(root, id)) add(p.child, id, depth + 1);
    };
    add(root, null, 0);
    return out;
  }

  pageBySlug(root: string, slug: string): WikiPage | null {
    return this.pages(root).find((p) => p.slug === slug) ?? null;
  }

  /** Every node a page is made of: itself and whatever it mounts (any role, recursively). */
  private nodesOf(id: string, acc = new Set<string>()): Set<string> {
    if (acc.has(id) || acc.size > 500) return acc;
    acc.add(id);
    for (const m of this.app.nodes.childrenOf(id)) this.nodesOf(m.child, acc);
    return acc;
  }

  /** Nodes readable through a published tree: its pages and everything they mount. */
  members(root: string): Set<string> {
    const set = new Set<string>();
    for (const p of this.pages(root)) this.nodesOf(p.id, set);
    return set;
  }

  /** Is this media readable without signing in? (It belongs to a page of a public tree.) */
  mediaPublic(mediaId: string): boolean {
    const r = this.app.db.prepare('SELECT doc_id FROM media WHERE id = ?').get(mediaId) as { doc_id: string | null } | undefined;
    if (!r?.doc_id) return false;
    const roots = this.app.db.prepare("SELECT root_id FROM trees WHERE published = 'public'").all() as { root_id: string }[];
    return roots.some((t) => this.members(t.root_id).has(r.doc_id!));
  }

  // ------------------------------------------------------------------ assembling a page

  /** The page's text with inline mounts in place; aside mounts collected as panels. */
  assemble(id: string): Assembled {
    const nodes = new Set<string>();
    const asides: Assembled['asides'] = [];
    const inline = (node: string, path: Set<string>, depth: number, collect: boolean): string => {
      nodes.add(node);
      let text: string;
      try { text = this.app.docs.text(node); } catch { return ''; }
      if (depth >= MAX_DEPTH) return text;
      const found = scanMounts(text);
      if (!found.length) return text;
      let out = '', at = 0;
      for (const m of found) {
        const d = this.app.docs.get(m.child);
        if (!d || path.has(m.child) || m.child === node) continue;
        const next = new Set(path); next.add(node);
        out += text.slice(at, m.from);
        if (m.role === 'aside') {
          if (collect) asides.push({ id: m.child, title: d.title, body: inline(m.child, next, depth + 1, false) });
          // The marker line goes (with its newline) from the article.
          at = m.to < text.length && text[m.to] === '\n' ? m.to + 1 : m.to;
          continue;
        }
        out += inline(m.child, next, depth + 1, collect);
        at = m.to;
      }
      return out + text.slice(at);
    };
    const body = inline(id, new Set(), 0, true);
    return { body, asides, nodes };
  }

  /** Markdown → HTML with heading ids, document links rewritten to wiki paths, images pointing at this host. */
  render(markdown: string, ctx: { base: string; pages: WikiPage[]; headings?: { id: string; text: string; level: number }[] }): string {
    const byId = new Map(ctx.pages.map((p) => [p.id, p]));
    const usedIds = new Set<string>();
    const env = {};
    const tokens = this.md.parse(markdown, env);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === 'heading_open') {
        const text = tokens[i + 1]?.content ?? '';
        let hid = slugify(text) || 'section';
        let n = 1; const base = hid;
        while (usedIds.has(hid)) hid = `${base}-${++n}`;
        usedIds.add(hid);
        t.attrSet('id', hid);
        ctx.headings?.push({ id: hid, text, level: Number(t.tag.slice(1)) });
      }
      const walk = (list: typeof tokens) => {
        for (const c of list) {
          if (c.type === 'link_open') {
            const href = String(c.attrGet('href') ?? '');
            const m = /^\/d\/([A-Za-z0-9]+)(?:\?[^#]*)?(#.*)?$/.exec(href);
            if (m) {
              const p = byId.get(m[1]);
              if (p) c.attrSet('href', `${ctx.base}/${p.slug}${m[2] ?? ''}`);
              else { c.attrSet('href', `${this.app.config.origin}${href}`); c.attrJoin('class', 'wiki-private'); c.attrSet('title', 'Not part of this wiki'); }
            } else if (/^https?:/i.test(href)) { c.attrSet('target', '_blank'); c.attrSet('rel', 'noopener noreferrer'); }
          }
          if (c.type === 'image') { const src = String(c.attrGet('src') ?? ''); if (src.startsWith('/media/')) c.attrSet('loading', 'lazy'); }
          if (c.children) walk(c.children);
        }
      };
      if (t.children) walk(t.children);
    }
    return this.md.renderer.render(tokens, this.md.options, env);
  }

  // ------------------------------------------------------------------ pages

  etag(root: string, page: WikiPage, nodes: Set<string>): string {
    const h = createHash('sha256');
    const ps = this.app.trees.publishSettings(root);
    h.update(JSON.stringify(ps)).update('\0');
    for (const id of [...nodes].sort()) h.update(`${id}:${this.app.docs.get(id)?.rev ?? 0}:${this.app.docs.get(id)?.title ?? ''}\0`);
    for (const p of this.pages(root)) h.update(`${p.id}=${p.slug}:${p.title}\0`);
    h.update(page.id);
    return `"${h.digest('base64url').slice(0, 24)}"`;
  }

  pageHtml(root: string, page: WikiPage, base: string, opts: { canEdit: boolean }): { html: string; etag: string } {
    const pages = this.pages(root);
    const ps = this.app.trees.publishSettings(root)!;
    const theme = ps.theme;
    const rootDoc = this.app.docs.get(root)!;
    const name = theme.name || rootDoc.title || 'Wiki';
    const a = this.assemble(page.id);
    const headings: { id: string; text: string; level: number }[] = [];
    // The page title is the H1 of the article; a leading "# Title" in the body that repeats it is dropped.
    let body = a.body;
    const first = outline(body)[0];
    if (first && first.level === 1 && first.line === 1 && first.text.trim() === page.title.trim()) body = body.split('\n').slice(1).join('\n');
    const article = this.render(body, { base, pages, headings });
    const asides = a.asides.map((x) => ({ ...x, html: this.render(x.body, { base, pages }) }));
    const etag = this.etag(root, page, a.nodes);
    const byId = new Map(pages.map((p) => [p.id, p]));
    const href = (p: WikiPage) => (p.depth === 0 ? `${base}/` : `${base}/${p.slug}`);

    // Nav: the whole tree, current page marked, with collapsible branches (details/summary).
    const navTree = (parent: string | null, depth: number): string => {
      const kids = pages.filter((p) => p.parent === parent);
      if (!kids.length) return '';
      return `<ul class="nav-list depth-${Math.min(depth, 5)}">${kids.map((p) => {
        const sub = navTree(p.id, depth + 1);
        const cur = p.id === page.id;
        const onPath = isAncestor(p.id, page.id, byId);
        const link = `<a href="${esc(href(p))}"${cur ? ' class="current" aria-current="page"' : ''}>${esc(p.title)}</a>`;
        return sub ? `<li><details${cur || onPath ? ' open' : ''}><summary>${link}</summary>${sub}</details></li>` : `<li>${link}</li>`;
      }).join('')}</ul>`;
    };
    const crumbs: WikiPage[] = [];
    for (let p: WikiPage | undefined = page; p; p = p.parent ? byId.get(p.parent) : undefined) crumbs.unshift(p);
    const siblings = pages.filter((p) => p.parent === page.parent && p.id !== page.id && page.parent);
    const children = pages.filter((p) => p.parent === page.id);
    const related = pages.filter((p) => p.id !== page.id && this.linksTo(p.id, page.id));
    const toc = headings.filter((h) => h.level >= 2 && h.level <= 3);
    const panel = (title: string, inner: string, cls = '') => `<section class="panel ${cls}"><h3>${esc(title)}</h3>${inner}</section>`;
    const list = (ps2: WikiPage[]) => `<ul class="plain">${ps2.map((p) => `<li><a href="${esc(href(p))}">${esc(p.title)}</a></li>`).join('')}</ul>`;
    const editUrl = `${this.app.config.origin}/d/${page.id}?tree=${encodeURIComponent(root)}`;
    const last = this.app.history.list(page.id, { limit: 1 })[0];
    const lastBy = last && !last.baseline ? last.authors.map((s) => this.app.principals.get(s)?.name ?? 'someone').join(', ') : null;
    const updated = new Date(this.app.docs.get(page.id)?.updatedAt ?? Date.now());

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.depth === 0 ? name : `${page.title} · ${name}`)}</title>
<meta property="og:title" content="${esc(page.title)}">
<meta property="og:site_name" content="${esc(name)}">
<meta name="description" content="${esc(excerpt(body))}">
<link rel="canonical" href="${esc(href(page))}">
<style>${CSS.replace('__ACCENT__', theme.accent || '#2459e0')}</style>
</head>
<body>
<header class="top">
  <a class="brand" href="${esc(base)}/">${theme.emoji ? `<span class="emoji">${esc(theme.emoji)}</span>` : ''}<span>${esc(name)}</span></a>
  ${theme.tagline ? `<span class="tagline">${esc(theme.tagline)}</span>` : ''}
  <form class="search" action="${esc(base)}/search" method="get"><input type="search" name="q" placeholder="Search ${esc(name)}" aria-label="Search"></form>
  <a class="edit" href="${esc(editUrl)}">${opts.canEdit ? 'Edit' : 'Open in editor'}</a>
</header>
<div class="layout">
  <nav class="side" aria-label="Pages"><a class="home-link" href="${esc(base)}/">${esc(rootDoc.title || name)}</a>${navTree(root, 1)}</nav>
  <main class="article">
    ${crumbs.length > 1 ? `<nav class="crumbs" aria-label="Breadcrumb">${crumbs.slice(0, -1).map((p) => `<a href="${esc(href(p))}">${esc(p.title)}</a>`).join('<span>›</span>')}</nav>` : ''}
    <h1>${esc(page.title)}</h1>
    <div class="asides mobile">${asides.map((x) => `<section class="panel infobox"><h3>${esc(x.title || 'About')}</h3><div class="panel-body">${x.html}</div></section>`).join('')}</div>
    <div class="prose">${article || '<p class="empty">This page is empty.</p>'}</div>
    ${children.length ? `<section class="subpages"><h2>Subpages</h2>${list(children)}</section>` : ''}
    <footer class="page-foot">
      <span>${lastBy ? `Last edited by ${esc(lastBy)} · ` : ''}${updated.toISOString().slice(0, 10)}</span>
      <a href="${esc(editUrl)}">${opts.canEdit ? 'Edit this page' : 'Open in the editor'}</a>
    </footer>
  </main>
  <aside class="asides desktop" aria-label="Page panels">
    ${asides.map((x) => `<section class="panel infobox"><h3>${esc(x.title || 'About')}</h3><div class="panel-body">${x.html}</div></section>`).join('')}
    ${toc.length ? panel('Contents', `<ol class="toc">${toc.map((h) => `<li class="l${h.level}"><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`).join('')}</ol>`, 'toc-panel') : ''}
    ${siblings.length || children.length ? panel('In this section', list([...children, ...siblings])) : ''}
    ${related.length ? panel('Related', list(related)) : ''}
  </aside>
</div>
<footer class="site-foot">${theme.footer ? `<span>${esc(theme.footer)}</span>` : ''}<span>Made with Anima Docs</span></footer>
</body>
</html>`;
    return { html, etag };
  }

  private linksTo(from: string, to: string): boolean {
    try { return this.app.docs.text(from).includes(`/d/${to}`); } catch { return false; }
  }

  searchHtml(root: string, base: string, q: string): string {
    const pages = this.pages(root);
    const ps = this.app.trees.publishSettings(root)!;
    const name = ps.theme.name || this.app.docs.get(root)?.title || 'Wiki';
    const needle = q.trim().toLowerCase();
    const hits: { p: WikiPage; snippet: string }[] = [];
    if (needle) {
      for (const p of pages) {
        const text = this.assemble(p.id).body;
        const i = text.toLowerCase().indexOf(needle);
        const inTitle = p.title.toLowerCase().includes(needle);
        if (i < 0 && !inTitle) continue;
        const snippet = i >= 0 ? text.slice(Math.max(0, i - 80), i + 120).replace(/\s+/g, ' ') : '';
        hits.push({ p, snippet });
        if (hits.length >= 50) break;
      }
    }
    const href = (p: WikiPage) => (p.depth === 0 ? `${base}/` : `${base}/${p.slug}`);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(q ? `“${q}” · ` : '')}Search · ${esc(name)}</title><style>${CSS.replace('__ACCENT__', ps.theme.accent || '#2459e0')}</style></head>
<body><header class="top"><a class="brand" href="${esc(base)}/">${ps.theme.emoji ? `<span class="emoji">${esc(ps.theme.emoji)}</span>` : ''}<span>${esc(name)}</span></a><form class="search" action="${esc(base)}/search" method="get"><input type="search" name="q" value="${esc(q)}" aria-label="Search"></form></header>
<div class="layout one"><main class="article"><h1>Search</h1>${needle ? (hits.length ? `<p>${hits.length} page${hits.length === 1 ? '' : 's'} match “${esc(q)}”.</p><ul class="results">${hits.map((h) => `<li><a href="${esc(href(h.p))}">${esc(h.p.title)}</a>${h.snippet ? `<p>…${esc(h.snippet)}…</p>` : ''}</li>`).join('')}</ul>` : `<p>Nothing matches “${esc(q)}”.</p>`) : '<p>Type something to search for.</p>'}</main></div></body></html>`;
  }

  sitemap(root: string, absoluteBase: string): string {
    const pages = this.pages(root);
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map((p) => `<url><loc>${esc(p.depth === 0 ? `${absoluteBase}/` : `${absoluteBase}/${p.slug}`)}</loc><lastmod>${new Date(this.app.docs.get(p.id)?.updatedAt ?? Date.now()).toISOString().slice(0, 10)}</lastmod></url>`).join('')}</urlset>`;
  }

  /** Where a tree's wiki lives, for links from the editor. */
  url(root: string): string | null {
    const ps = this.app.trees.publishSettings(root);
    if (!ps || !ps.slug) return null;
    if (ps.domain && ps.published === 'public') return `https://${ps.domain}/`;
    return `${this.app.config.origin}/w/${ps.slug}/`;
  }

  /** Access to a tree's wiki: public, members (signed-in members), or a preview for those who can open the root. */
  access(root: string, actor: { sub: string; admin: boolean; kind?: string } | null, ps: PublishSettings): 'ok' | 'signin' | 'none' {
    if (ps.published === 'public') return 'ok';
    if (ps.published === 'members') return actor && actor.kind !== 'guest' ? 'ok' : 'signin';
    return actor && this.app.docs.role(root, actor) ? 'ok' : 'none';
  }
}

function isAncestor(a: string, of: string, byId: Map<string, WikiPage>): boolean {
  for (let p = byId.get(of); p && p.parent; p = byId.get(p.parent)) if (p.parent === a) return true;
  return false;
}

function excerpt(md: string): string {
  return md.replace(/^#.*$/gm, '').replace(/[*_`>#[\]()!-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export class WikiFault extends Fault {}

// ------------------------------------------------------------------ the look: a quiet encyclopedia

const CSS = `
:root { --accent: __ACCENT__; --ink: #1b2230; --ink-2: #586173; --ink-3: #8a93a3; --rule: #e4e7ec; --paper: #ffffff; --panel: #f7f8fa; --panel-head: #eceff3; --bg: #fbfbfc; --serif: Georgia, "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif; --sans: "Inter", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
@media (prefers-color-scheme: dark) { :root { --ink: #e6e8ec; --ink-2: #aab2c0; --ink-3: #7c8595; --rule: #2a2f38; --paper: #15181d; --panel: #1b1f26; --panel-head: #242932; --bg: #101216; } }
* { box-sizing: border-box; }
html { background: var(--bg); color: var(--ink); font: 17px/1.6 var(--sans); -webkit-text-size-adjust: 100%; }
body { margin: 0; }
a { color: var(--accent); }
a.wiki-private { color: var(--ink-3); text-decoration: underline dotted; }
.top { display: flex; align-items: center; gap: 18px; padding: 10px 22px; border-bottom: 1px solid var(--rule); background: var(--paper); position: sticky; top: 0; z-index: 2; }
.brand { display: inline-flex; align-items: center; gap: 8px; font: 600 18px var(--sans); color: var(--ink); text-decoration: none; letter-spacing: -0.01em; }
.brand .emoji { font-size: 22px; }
.tagline { color: var(--ink-3); font-size: 13px; }
.search { margin-left: auto; }
.search input { font: 14px var(--sans); padding: 7px 12px; border: 1px solid var(--rule); border-radius: 999px; background: var(--panel); color: var(--ink); width: 260px; max-width: 40vw; }
.edit { font: 500 14px var(--sans); color: var(--accent); text-decoration: none; padding: 6px 12px; border: 1px solid var(--rule); border-radius: 8px; }
.edit:hover { background: var(--panel); }
.layout { display: grid; grid-template-columns: 250px minmax(0, 1fr) 320px; gap: 36px; max-width: 1380px; margin: 0 auto; padding: 22px 22px 60px; }
.layout.one { grid-template-columns: minmax(0, 1fr); max-width: 860px; }
.side { font: 14.5px/1.5 var(--sans); position: sticky; top: 64px; align-self: start; max-height: calc(100vh - 80px); overflow: auto; padding-right: 6px; }
.home-link { display: block; font-weight: 600; color: var(--ink); text-decoration: none; padding: 4px 8px; margin-bottom: 6px; }
.nav-list { list-style: none; margin: 0; padding: 0 0 0 10px; border-left: 1px solid var(--rule); }
.nav-list.depth-1 { padding-left: 0; border-left: 0; }
.nav-list li { margin: 1px 0; }
.nav-list a { display: block; color: var(--ink-2); text-decoration: none; padding: 3px 8px; border-radius: 6px; }
.nav-list a:hover { background: var(--panel); color: var(--ink); }
.nav-list a.current { color: var(--accent); font-weight: 600; background: color-mix(in srgb, var(--accent) 10%, transparent); }
.nav-list details > summary { list-style: none; cursor: pointer; display: flex; align-items: center; }
.nav-list details > summary::-webkit-details-marker { display: none; }
.nav-list details > summary::before { content: "▸"; color: var(--ink-3); font-size: 10px; width: 12px; flex: none; }
.nav-list details[open] > summary::before { content: "▾"; }
.nav-list details > summary a { flex: 1; }
.article { min-width: 0; background: var(--paper); border: 1px solid var(--rule); border-radius: 12px; padding: 34px 44px 26px; }
.crumbs { font: 13px var(--sans); color: var(--ink-3); display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.crumbs a { color: var(--ink-2); text-decoration: none; }
.crumbs a:hover { text-decoration: underline; }
.article h1 { font: 700 2.3em/1.15 var(--serif); letter-spacing: -0.015em; margin: 0 0 14px; padding-bottom: 10px; border-bottom: 1px solid var(--rule); }
.prose { font-family: var(--serif); font-size: 17.5px; }
.prose h2 { font: 600 1.55em/1.25 var(--serif); margin: 1.5em 0 0.5em; padding-bottom: 4px; border-bottom: 1px solid var(--rule); }
.prose h3 { font: 600 1.22em/1.3 var(--serif); margin: 1.3em 0 0.4em; }
.prose h4 { font: 600 1.05em/1.4 var(--sans); margin: 1.2em 0 0.3em; }
.prose p, .prose ul, .prose ol { margin: 0 0 1em; }
.prose li { margin: 0.25em 0; }
.prose blockquote { margin: 1em 0; padding: 4px 18px; border-left: 3px solid var(--rule); color: var(--ink-2); }
.prose code { font: 0.86em var(--mono); background: var(--panel); padding: 1px 5px; border-radius: 4px; }
.prose pre { background: var(--panel); border: 1px solid var(--rule); border-radius: 8px; padding: 14px 16px; overflow: auto; font: 14px/1.5 var(--mono); }
.prose pre code { background: none; padding: 0; font-size: inherit; }
.prose img { max-width: 100%; height: auto; border-radius: 6px; }
.prose table { border-collapse: collapse; width: 100%; margin: 1em 0; font-family: var(--sans); font-size: 15px; }
.prose th, .prose td { border: 1px solid var(--rule); padding: 7px 10px; vertical-align: top; text-align: left; }
.prose th { background: var(--panel-head); font-weight: 600; }
.prose hr { border: 0; border-top: 1px solid var(--rule); margin: 2em 0; }
.prose .empty { color: var(--ink-3); font-style: italic; }
.subpages { margin-top: 2.2em; padding-top: 1em; border-top: 1px solid var(--rule); }
.subpages h2 { font: 600 1.1em var(--sans); color: var(--ink-2); margin: 0 0 0.5em; }
ul.plain { list-style: none; margin: 0; padding: 0; }
ul.plain li { margin: 4px 0; }
.page-foot { display: flex; justify-content: space-between; gap: 12px; margin-top: 2.5em; padding-top: 12px; border-top: 1px solid var(--rule); font: 13px var(--sans); color: var(--ink-3); }
.asides { font: 14px/1.5 var(--sans); }
.asides.desktop { position: sticky; top: 64px; align-self: start; max-height: calc(100vh - 80px); overflow: auto; }
.asides.mobile { display: none; }
.panel { background: var(--panel); border: 1px solid var(--rule); border-radius: 10px; margin: 0 0 16px; overflow: hidden; }
.panel h3 { margin: 0; padding: 8px 12px; font: 600 13px var(--sans); letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-2); background: var(--panel-head); border-bottom: 1px solid var(--rule); }
.panel .panel-body, .panel ul, .panel ol { padding: 10px 12px; margin: 0; }
.panel ul.plain li a, .panel ol.toc li a { color: var(--ink); text-decoration: none; }
.panel ul.plain li a:hover, .panel ol.toc li a:hover { color: var(--accent); }
.panel ol.toc { list-style: none; counter-reset: none; }
.panel ol.toc li.l3 { padding-left: 14px; font-size: 13px; }
.infobox .panel-body p { margin: 0 0 8px; }
.infobox .panel-body table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
.infobox .panel-body th, .infobox .panel-body td { padding: 5px 6px; border-top: 1px solid var(--rule); text-align: left; vertical-align: top; }
.infobox .panel-body tr:first-child th, .infobox .panel-body tr:first-child td { border-top: 0; }
.infobox .panel-body th { width: 38%; color: var(--ink-2); font-weight: 600; }
.infobox .panel-body td:first-child { color: var(--ink-2); font-weight: 600; width: 38%; }
.infobox .panel-body img { max-width: 100%; border-radius: 6px; display: block; margin: 0 auto 8px; }
.results li { margin: 0 0 14px; }
.results p { margin: 2px 0 0; color: var(--ink-2); font-size: 14px; }
.site-foot { display: flex; justify-content: center; gap: 18px; padding: 18px; font: 12.5px var(--sans); color: var(--ink-3); }
@media (max-width: 1120px) { .layout { grid-template-columns: 230px minmax(0, 1fr); } .asides.desktop { display: none; } .asides.mobile { display: block; margin-bottom: 18px; } }
@media (max-width: 760px) { .layout { grid-template-columns: minmax(0, 1fr); gap: 16px; padding: 14px; } .side { position: static; max-height: none; order: 2; } .article { padding: 22px 20px; order: 1; } .top { gap: 10px; padding: 8px 12px; } .search input { width: 140px; } .tagline { display: none; } }
`;
