// HTTP: sign-in, the web app's JSON API, media, and the agent operations API.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import type { App } from './app.js';
import { DEFAULT_TEMPLATE, TEMPLATE_SLOTS } from './wiki.js';
import { createHash, timingSafeEqual } from 'node:crypto';

function timingSafeEqualStr(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
import { Fault, opaque, tokenHash, type Identity } from './auth.js';
import { isGuest, type Actor } from './principals.js';
import { attachMcpl } from './mcpl.js';
import { Realtime, maskFor, publicActor, type WebSession } from './realtime.js';
import { TOOLS, runTool } from './tools.js';
import { atLeast } from './documents.js';
import { Media, inlineMime } from './media.js';
import { COMPANION, isTextMime } from './files.js';
import { excerpt } from './wiki.js';
import { createReadStream } from 'node:fs';

const PUBLIC_DIR = resolve(new URL('.', import.meta.url).pathname, '..', 'public');

const safeDecode = (v: string) => { try { return decodeURIComponent(v); } catch { return v; } };
const cookies = (req: IncomingMessage): Record<string, string> => Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => {
  const i = c.indexOf('=');
  return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), safeDecode(c.slice(i + 1).trim())];
}));
const GUEST_SESSION_MS = 30 * 86400_000;

/** Sliding-window caps on new guest identities: per client network, per link, and overall. */
class GuestLimiter {
  private hits = new Map<string, number[]>();
  constructor(private limits = { perClient: 20, perLink: 100, total: 1000 }, private windowMs = 3600_000) {}
  take(client: string, linkId: string): boolean {
    const now = Date.now();
    const keys: [string, number][] = [[`c:${client}`, this.limits.perClient], [`l:${linkId}`, this.limits.perLink], ['*', this.limits.total]];
    const lists = keys.map(([k]) => (this.hits.get(k) ?? []).filter((t) => now - t < this.windowMs));
    if (lists.some((l, i) => l.length >= keys[i][1])) return false;
    lists.forEach((l, i) => { l.push(now); this.hits.set(keys[i][0], l); });
    if (this.hits.size > 20_000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    return true;
  }
}

/**
 * The client's network for rate limiting.
 * - `header`: a header the proxy sets and overwrites (Railway: x-real-ip) wins.
 * - Otherwise, behind `hops` trusted proxies that each append to X-Forwarded-For,
 *   the client is the entry `hops` from the end (anything before it is client-supplied).
 * IPv6 is bucketed by /64, since a single host can rotate through its whole prefix.
 */
export function clientNetwork(req: IncomingMessage, hops: number, header: string | null = null): string {
  const fromHeader = header ? String(req.headers[header.toLowerCase()] ?? '').split(',')[0].trim() : '';
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const raw = fromHeader || (hops > 0 && xff.length >= hops ? xff[xff.length - hops] : (req.socket.remoteAddress ?? '?'));
  const ip = raw.replace(/^::ffff:/, '');
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${full.slice(0, 4).join(':')}::/64`;
}

/** What a guest may do over HTTP (everything else needs an Archipelago sign-in). */
function guestAllowed(method: string, path: string): boolean {
  if (path === '/api/me' || path === '/api/config' || path === '/api/guest/name' || path === '/api/links/redeem') return true;
  if (/^\/api\/links\/[A-Za-z0-9_-]+$/.test(path)) return true;
  if (path === '/api/docs' && method === 'GET') return true;
  const m = /^\/api\/docs\/[A-Za-z0-9]+(\/.*)?$/.exec(path);
  if (!m) return false;
  const rest = m[1] ?? '';
  if (method === 'GET') return rest === '' || rest === '/files' || rest.startsWith('/files/') || rest === '/versions' || /^\/versions\/[a-z0-9]+$/.test(rest) || rest === '/activity' || rest === '/history' || rest === '/history/compare' || rest === '/export.md';
  // Editors through a link may rename, name versions and restore them, as any editor can.
  return (method === 'PATCH' && rest === '') || (method === 'POST' && (rest === '/versions' || /^\/versions\/[a-z0-9]+\/restore$/.test(rest) || /^\/history\/\d+\/(restore|undo)$/.test(rest)));
}

async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<Buffer> {
  let n = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new Fault(413, 'Request too large.');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}
async function json(req: IncomingMessage): Promise<any> {
  const b = await readBody(req, 8 * 1024 * 1024); // documents hold up to 2M characters; the JSON around them is small
  try { return JSON.parse(b.toString('utf8') || '{}'); } catch { throw new Fault(400, 'Invalid JSON.'); }
}

const STATIC: Record<string, [string, string]> = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/og-default.png': ['og-default.png', 'image/png'],
  '/page-annotate.js': ['page-annotate.js', 'text/javascript; charset=utf-8'],
};

const staticCache = new Map<string, { mtime: number; raw: Buffer; gz: Buffer | null }>();

export function createHttp(app: App) {
  const production = app.config.origin.startsWith('https:');
  const cookie = (name: string, value: string, maxAge: number) =>
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}${production ? '; Secure' : ''}`;

  // ---------------------------------------------------------------- sessions

  // A sign-in token proves who you are once (it lives minutes); the session is
  // ours: it lasts SESSION_MS from last use, renewed at most daily, and never
  // past SESSION_MAX_MS from sign-in. Blocking and sign-out still end it at once.
  const SESSION_MS = app.config.sessionDays * 86400_000;
  const SESSION_MAX_MS = Math.max(SESSION_MS, app.config.sessionMaxDays * 86400_000);
  const RENEW_AFTER_MS = Math.min(86400_000, SESSION_MS / 4);
  const createSession = (who: Identity): { token: string; maxAge: number } => {
    const token = opaque();
    const expires = Date.now() + SESSION_MS;
    app.db.prepare('INSERT INTO sessions (token_hash, sub, identity, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(tokenHash(token), who.sub, JSON.stringify(who), expires, Date.now());
    app.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    return { token, maxAge: (expires - Date.now()) / 1000 };
  };

  /** A guest session: someone who opened an "anyone" link without signing in. */
  const createGuestSession = (sub: string): { token: string; maxAge: number } => {
    const token = opaque();
    const expires = Date.now() + GUEST_SESSION_MS;
    app.db.prepare('INSERT INTO sessions (token_hash, sub, identity, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(tokenHash(token), sub, JSON.stringify({ sub, kind: 'guest' }), expires, Date.now());
    return { token, maxAge: GUEST_SESSION_MS / 1000 };
  };
  const guestLimiter = new GuestLimiter();
  // Hosted behind one proxy (Railway's edge) in production; nothing in front locally.
  const proxyHops = app.config.trustedProxyHops;

  const webSession = (req: IncomingMessage): WebSession | null => {
    const t = cookies(req).docs_session;
    if (!t) return null;
    const hash = tokenHash(t);
    const r = app.db.prepare('SELECT identity, expires_at FROM sessions WHERE token_hash = ?').get(hash) as { identity: string; expires_at: number } | undefined;
    if (!r || r.expires_at < Date.now()) return null;
    try {
      const who = JSON.parse(r.identity);
      const actor = who.kind === 'guest' ? app.principals.guestActor(String(who.sub), r.expires_at) : app.principals.admit(who, 'web');
      return actor ? { actor, tokenHash: hash, expiresAt: r.expires_at } : null;
    } catch { return null; }
  };
  const sessionActor = (req: IncomingMessage): Actor | null => webSession(req)?.actor ?? null;
  /** Keep an active member's session alive (at most once a day), within the limit from sign-in. */
  const renewSession = (req: IncomingMessage, res: ServerResponse) => {
    const t = cookies(req).docs_session;
    if (!t) return;
    const hash = tokenHash(t);
    const r = app.db.prepare('SELECT sub, expires_at, created_at FROM sessions WHERE token_hash = ?').get(hash) as { sub: string; expires_at: number; created_at: number } | undefined;
    const now = Date.now();
    if (!r || r.expires_at < now || isGuest(r.sub)) return;
    if (r.expires_at - now > SESSION_MS - RENEW_AFTER_MS) return; // renewed recently
    const next = Math.min(now + SESSION_MS, r.created_at + SESSION_MAX_MS);
    if (next <= r.expires_at) return;
    app.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(next, hash);
    res.appendHeader('Set-Cookie', cookie('docs_session', t, (next - now) / 1000));
  };
  const sessionValid = (s: WebSession) => {
    const r = app.db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(s.tokenHash) as { expires_at: number } | undefined;
    return !!r && r.expires_at > Date.now();
  };

  const bearerActor = (req: IncomingMessage): Actor | null => {
    const h = req.headers.authorization;
    if (!h) return null;
    if (!/^Bearer\s+/i.test(h)) throw new Fault(401, 'Use Authorization: Bearer <aid1 token>.');
    return app.principals.admit(app.verify(h.replace(/^Bearer\s+/i, '')), 'http');
  };

  const realtime = new Realtime(app, webSession, sessionValid);
  // Only an https origin is canonical (local development answers on any host).
  const canonicalHost = app.config.origin.startsWith('https:') ? new URL(app.config.origin).host.toLowerCase() : null;

  // ---------------------------------------------------------------- wiki pages (public, server-rendered)

  async function serveWiki(req: IncomingMessage, res: ServerResponse, root: string, base: string, rest: string, url: URL, absoluteBase: string, scriptsOk = false) {
    const ps = app.trees.publishSettings(root);
    if (!ps || !app.trees.isRoot(root)) throw new Fault(404, 'No such wiki.');
    // A wiki that allows scripts lives on its own host; from the app's origin, send people there.
    if (ps.scripts && !scriptsOk && ps.published === 'public' && (ps.domain || app.config.wikiHost)) {
      const target = ps.domain ? `https://${ps.domain}` : `https://${app.config.wikiHost}/${ps.slug}`;
      res.writeHead(302, { Location: `${target}${rest || '/'}${url.search}`, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    const session = webSession(req);
    const actor = session?.actor ?? null;
    const access = app.wiki.access(root, actor, ps);
    const html = (status: number, body: string, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': ps.published === 'public' ? 'public, max-age=60' : 'private, no-store', ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (access === 'none') throw new Fault(404, 'No such wiki.');
    if (access === 'signin') {
      html(401, `<!doctype html><meta charset="utf-8"><title>Sign in</title><body style="font:16px system-ui;padding:40px;max-width:560px;margin:auto"><h1>Members only</h1><p>This wiki is for signed-in members. <a href="${app.config.origin}/auth/login">Sign in</a>, then come back to this page.</p></body>`);
      return;
    }
    if (rest === '/search') { html(200, app.wiki.searchHtml(root, base, url.searchParams.get('q') ?? '')); return; }
    if (rest === '/sitemap.xml') { res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' }); res.end(app.wiki.sitemap(root, absoluteBase)); return; }
    if (rest === '') { res.writeHead(302, { Location: `${base}/` }); res.end(); return; }
    const slug = rest.replace(/^\//, '').replace(/\/$/, '');
    if (!/^[a-z0-9-]{0,80}$/.test(slug)) throw new Fault(404, 'No such page.');
    const page = app.wiki.pageBySlug(root, slug);
    if (!page) throw new Fault(404, 'No such page.');
    const pageDoc = app.docs.get(page.id);
    if (pageDoc?.type === 'html') { res.writeHead(302, { Location: `/p/${pageDoc.id}/t/${app.pageKeys.mint(pageDoc.id)}/`, 'Cache-Control': 'no-store' }); res.end(); return; }
    const canEdit = !!actor && atLeast(app.docs.role(page.id, actor), 'editor');
    const out = app.wiki.pageHtml(root, page, base, { canEdit, scripts: scriptsOk });
    if (req.headers['if-none-match'] === out.etag) { res.writeHead(304, { ETag: out.etag }); res.end(); return; }
    html(200, out.html, { ETag: out.etag, Vary: 'Cookie' });
  }

  // ---------------------------------------------------------------- server

  /**
   * An HTML page (a document of type html) served as itself, in a sandbox: CSP `sandbox` without
   * allow-same-origin gives it an opaque origin, so its scripts run but see no cookies, storage or
   * API of this origin (requests from it arrive with Origin: null and no session). The editor
   * frames it (frame-ancestors 'self'); nobody else may.
   */
  // ---------------------------------------------------------------- the app shell, with link previews
  // Crawlers (Slack, Discord, X, iMessage) fetch a link without a session and read Open Graph tags.
  // A document's title and excerpt go out only when anyone could read it anyway: a public wiki, an
  // active anyone-with-the-link link, or the share link itself. Everything else gets a generic card.
  interface LinkMeta { title: string; description: string; url: string; image?: string; type?: string }
  const attr = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const GENERIC = { title: 'Anima Docs', description: 'Documents, pages and wikis that people and agents write together.' };
  function shell(meta: LinkMeta): string {
    const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
    const image = meta.image ?? `${app.config.origin}/og-default.png`;
    const tags = [
      `<meta name="description" content="${attr(meta.description)}">`,
      `<meta property="og:site_name" content="Anima Docs">`, `<meta property="og:type" content="${meta.type ?? 'website'}">`,
      `<meta property="og:title" content="${attr(meta.title)}">`, `<meta property="og:description" content="${attr(meta.description)}">`,
      `<meta property="og:url" content="${attr(meta.url)}">`, `<meta property="og:image" content="${attr(image)}">`,
      `<meta name="twitter:card" content="summary_large_image">`, `<meta name="twitter:title" content="${attr(meta.title)}">`, `<meta name="twitter:description" content="${attr(meta.description)}">`, `<meta name="twitter:image" content="${attr(image)}">`,
    ].join('\n  ');
    return html.replace(/<title>[^<]*<\/title>/, `<title>${attr(meta.title === 'Anima Docs' ? meta.title : `${meta.title} · Anima Docs`)}</title>`).replace('</head>', `  ${tags}\n</head>`);
  }
  /** Readable by anyone who has the address: a public wiki, or an active anyone-with-the-link link. */
  function openToAnyone(docId: string): boolean {
    const links = (app.db.prepare("SELECT count(*) AS n FROM doc_links WHERE doc_id = ? AND audience = 'anyone' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)").get(docId, Date.now()) as { n: number }).n;
    if (links > 0) return true;
    const roots = app.db.prepare("SELECT root_id FROM trees WHERE published = 'public'").all() as { root_id: string }[];
    return roots.some((t) => app.wiki.members(t.root_id).has(docId));
  }
  /** The card for a document: its title and an excerpt when it is open to anyone (or `reveal` says the address itself is the secret), else generic. */
  function docMeta(d: { id: string; title: string; type: string }, url: string, reveal = false): LinkMeta {
    if (!reveal && !openToAnyone(d.id)) return { ...GENERIC, title: 'Anima Docs', description: 'A document on Anima Docs. Sign in to open it.', url };
    const text = (d.type === 'html' ? app.files.text(d.id, COMPANION) : null) ?? app.docs.text(d.id);
    const first = /!\[[^\]]*\]\((\/media\/[0-9a-f]{32}\.(?:png|jpg|gif|webp))\)/.exec(text)?.[1];
    return { title: d.title || 'Untitled', description: excerpt(text) || (d.type === 'html' ? 'An HTML page on Anima Docs.' : 'A document on Anima Docs.'), url, type: 'article', image: first ? `${app.config.origin}${first}` : undefined };
  }
  const sendShell = (res: ServerResponse, meta: LinkMeta) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(shell(meta)); };

  const SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock allow-presentation; frame-ancestors 'self'";
  function sendSandboxed(req: IncomingMessage, res: ServerResponse, body: Buffer | string, etag: string, type: string, cache = 'private, no-cache') {
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', SANDBOX);
    // The page's own scripts fetch its files from an opaque origin: the token in the path is the capability, so CORS may be open.
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); res.end(); return; }
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': cache, ETag: etag, Vary: 'Cookie' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  }
  function sendPage(req: IncomingMessage, res: ServerResponse, body: string, rev: number) {
    sendSandboxed(req, res, body, `"p${rev}-${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`, 'text/html; charset=utf-8');
  }
  /** An attached file of a page, served next to it. */
  function sendDocFile(req: IncomingMessage, res: ServerResponse, docId: string, filePath: string) {
    const f = app.files.read(docId, filePath);
    if (!f) throw new Fault(404, 'No such file.');
    sendSandboxed(req, res, f.bytes, `"f${f.file.mediaId}"`, f.file.mime, 'private, max-age=60');
  }
  /** Media readable without a session: its document is shareable beyond its explicit list (an active link, members access, a public wiki). Ids are content hashes: unguessable. */
  function mediaOpen(mediaId: string): boolean {
    const r = app.db.prepare('SELECT doc_id FROM media WHERE id = ?').get(mediaId) as { doc_id: string | null } | undefined;
    if (!r?.doc_id) return false;
    const d = app.docs.get(r.doc_id);
    if (!d) return false;
    if (d.generalAccess !== 'restricted') return true;
    const links = (app.db.prepare('SELECT count(*) AS n FROM doc_links WHERE doc_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)').get(r.doc_id, Date.now()) as { n: number }).n;
    if (links > 0) return true;
    return app.wiki.mediaPublic(mediaId);
  }

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    const wsOrigin = app.config.origin.replace(/^http/, 'ws');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; media-src 'self' https: blob:; frame-src 'self' https://www.youtube-nocookie.com https://player.vimeo.com; connect-src 'self' ${wsOrigin}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    /** Who the response is for: guests get principal ids masked (they see people by name only). */
    let viewer: Actor | null = null;
    const send = (status: number, data: unknown, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
      res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(viewer ? maskFor(viewer, data, (id) => !!app.principals.get(id)) : data));
    };

    try {
      const url = new URL(req.url ?? '/', app.config.origin);
      const path = url.pathname;
      const method = req.method ?? 'GET';

      if (path === '/health') { app.db.prepare('SELECT 1').get(); send(200, { ok: true }); return; }
      const wm = /^\/w\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(\/.*)?$/.exec(path);
      if (wm && (method === 'GET' || method === 'HEAD')) {
        const root = app.trees.rootBySlug(wm[1]);
        if (!root) throw new Fault(404, 'No such wiki.');
        await serveWiki(req, res, root, `/w/${wm[1]}`, wm[2] ?? '/', url, `${app.config.origin}/w/${wm[1]}`);
        return;
      }
      // ---------------------------------------------------------- database copies (keyed; for a staging instance)
      if (path === '/api/admin/export' && method === 'GET') {
        const key = app.config.exportKey;
        if (!key || !timingSafeEqualStr(String(req.headers['x-export-key'] ?? ''), key)) throw new Fault(404, 'Not found.');
        const file = join(app.config.dataDir === ':memory:' ? process.cwd() : app.config.dataDir, `export-${Date.now()}.db`);
        await app.db.backup(file);
        const bytes = readFileSync(file);
        rmSync(file);
        send(200, bytes, 'application/octet-stream', { 'Content-Disposition': 'attachment; filename="docs.db"' });
        return;
      }
      if (path === '/api/admin/import' && method === 'POST') {
        const key = app.config.importKey;
        if (!key || !timingSafeEqualStr(String(req.headers['x-import-key'] ?? ''), key)) throw new Fault(404, 'Not found.');
        if (app.config.dataDir === ':memory:') throw new Fault(400, 'No data directory.');
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) { size += (c as Buffer).length; if (size > 512 * 1024 * 1024) throw new Fault(413, 'Too large.'); chunks.push(c as Buffer); }
        const body = Buffer.concat(chunks);
        if (!body.subarray(0, 16).toString('latin1').startsWith('SQLite format 3')) throw new Fault(400, 'Not a SQLite database.');
        writeFileSync(join(app.config.dataDir, 'docs.db.import'), body);
        send(200, { ok: true, bytes: body.length, note: 'Installed at the next start; the process exits now so the platform restarts it.' });
        setTimeout(() => process.exit(1), 300);
        return;
      }
      // One public address: page and API reads arriving on another host (the platform's
      // default domain, say) are sent to the origin, so old links keep working.
      const reqHost = String(req.headers.host ?? '').toLowerCase().split(':')[0];
      // A published wiki on its own domain is served here, as that domain.
      const wikiDomainRoot = canonicalHost && reqHost !== canonicalHost ? app.trees.rootByDomain(reqHost) : null;
      if (wikiDomainRoot && (method === 'GET' || method === 'HEAD') && !path.startsWith('/media/') && !path.startsWith('/katex/')) {
        await serveWiki(req, res, wikiDomainRoot, '', path, url, `https://${reqHost}`, true);
        return;
      }
      // The shared wiki host: /<slug>/... for every public wiki; scripts may run here (it is not the app's origin).
      const onWikiHost = !!app.config.wikiHost && reqHost === app.config.wikiHost && reqHost !== (canonicalHost ?? new URL(app.config.origin).host.toLowerCase());
      if (onWikiHost && (method === 'GET' || method === 'HEAD') && !path.startsWith('/media/') && !path.startsWith('/katex/')) {
        const hm = /^\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(\/.*)?$/.exec(path);
        const root = hm ? app.trees.rootBySlug(hm[1]) : null;
        if (!root) throw new Fault(404, 'No such wiki.');
        if (app.trees.publishSettings(root)?.published !== 'public') throw new Fault(404, 'No such wiki.');
        await serveWiki(req, res, root, `/${hm![1]}`, hm![2] ?? '/', url, `https://${reqHost}/${hm![1]}`, true);
        return;
      }
      if (canonicalHost && (method === 'GET' || method === 'HEAD') && String(req.headers.host ?? '').toLowerCase() !== canonicalHost && !path.startsWith('/debug/') && !wikiDomainRoot && !onWikiHost) {
        res.writeHead(301, { Location: `${app.config.origin}${req.url ?? '/'}`, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      // Operator diagnostic (off unless DOCS_DEBUG_CLIENT=1): which forwarding headers the hosting proxy sets.
      if (path === '/debug/client' && process.env.DOCS_DEBUG_CLIENT === '1') {
        const pick = ['x-forwarded-for', 'x-real-ip', 'x-envoy-external-address', 'forwarded', 'cf-connecting-ip', 'true-client-ip', 'x-railway-request-id', 'via'];
        send(200, { headers: Object.fromEntries(pick.map((h) => [h, req.headers[h] ?? null])), remote: req.socket.remoteAddress, network: clientNetwork(req, app.config.trustedProxyHops, app.config.clientIpHeader) });
        return;
      }

      // Same-origin rule for every cookie-authenticated mutation.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !req.headers.authorization && req.headers.origin !== app.config.origin) {
        throw new Fault(403, 'Use this service from its own origin.');
      }

      // ------------------------------------------------ sign-in
      if (path === '/auth/login' && method === 'GET') {
        const state = opaque(16);
        const issuer = app.config.issuers[0]?.domain;
        if (!issuer) throw new Fault(500, 'No issuer configured.');
        res.setHeader('Set-Cookie', cookie('docs_login', state, 600));
        res.writeHead(302, { Location: `https://${issuer}/login?audience=${encodeURIComponent(app.config.audience)}&state=${state}` });
        res.end();
        return;
      }
      if (path === '/auth/exchange' && method === 'POST') {
        const body = await json(req);
        const pending = cookies(req).docs_login;
        if (!pending) throw new Fault(401, 'Start from the Sign in button.');
        // Login CSRF: when the issuer returns our state, it must be the one this browser started with.
        if (body.state !== undefined && body.state !== pending) throw new Fault(401, 'This sign-in did not start here. Start from the Sign in button.');
        const who = app.verify(String(body.token ?? ''));
        if (who.kind !== 'human') throw new Fault(403, 'Browser sign-in is for people; agents connect with their token directly.');
        if (!who.jti) throw new Fault(401, 'Sign-in tokens must be single-use.');
        if (!app.jti.use(who.jti, who.exp)) throw new Fault(401, 'This sign-in link was already used.');
        const seen = app.db.prepare('SELECT 1 FROM used_jti WHERE jti = ?').get(who.jti);
        if (seen) throw new Fault(401, 'This sign-in link was already used.');
        app.db.prepare('DELETE FROM used_jti WHERE expires_at < ?').run(Date.now());
        app.db.prepare('INSERT INTO used_jti (jti, expires_at) VALUES (?, ?)').run(who.jti, who.exp * 1000);
        const actor = app.principals.admit(who, 'web');
        // Signing in replaces whatever session this browser had (a guest's, say): end it and its sockets.
        const previous = cookies(req).docs_session;
        if (previous) { app.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(previous)); realtime.closeSession(tokenHash(previous)); }
        const s = createSession(who);
        res.setHeader('Set-Cookie', [cookie('docs_session', s.token, s.maxAge), cookie('docs_login', '', 0)]);
        send(200, { you: publicActor(actor) });
        return;
      }
      if (path === '/auth/logout' && method === 'POST') {
        const t = cookies(req).docs_session;
        if (t) { app.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(t)); realtime.closeSession(tokenHash(t)); }
        res.setHeader('Set-Cookie', cookie('docs_session', '', 0));
        send(200, { ok: true });
        return;
      }

      // ------------------------------------------------ development issuer
      if (path.startsWith('/dev/')) {
        if (!app.devIssuer) throw new Fault(404, 'Not found.');
        if (path === '/dev/login' && method === 'POST') {
          const body = await json(req);
          const name = String(body.name ?? '').trim().slice(0, 60);
          if (!name) throw new Fault(400, 'Name required.');
          const token = app.devIssuer.mint({ name, kind: 'human', audience: app.config.audience, scopes: body.admin ? ['docs:admin'] : [] });
          const who = app.verify(token);
          const actor = app.principals.admit(who, 'web');
          const s = createSession(who);
          res.setHeader('Set-Cookie', cookie('docs_session', s.token, s.maxAge));
          send(200, { you: publicActor(actor) });
          return;
        }
        if (path === '/dev/token' && method === 'POST') {
          const body = await json(req);
          const name = String(body.name ?? '').trim().slice(0, 60);
          const kind = body.kind === 'human' ? 'human' : body.kind === 'service' ? 'service' : 'agent';
          if (!name) throw new Fault(400, 'Name required.');
          send(200, { token: app.devIssuer.mint({ name, kind, audience: app.config.audience, ttlSeconds: Number(body.ttl ?? 12 * 3600) }), issuer: app.devIssuer.domain });
          return;
        }
        throw new Fault(404, 'Not found.');
      }

      // ------------------------------------------------ identify
      let actor: Actor | null = bearerActor(req) ?? sessionActor(req);
      viewer = actor;
      // Reads by a signed-in browser keep its session alive (they never set cookies of their own).
      if (actor && method === 'GET' && path.startsWith('/api/') && !req.headers.authorization) renewSession(req, res);

      if (path === '/api/config') {
        send(200, { audience: app.config.audience, issuer: app.config.issuers[0]?.domain ?? null, dev: !!app.devIssuer, origin: app.config.origin });
        return;
      }
      if (path === '/api/me') {
        if (!actor) { send(200, { you: null, dev: !!app.devIssuer }); return; }
        send(200, { you: publicActor(actor), guest: isGuest(actor.sub), dev: !!app.devIssuer });
        return;
      }

      // ------------------------------------------------ share links
      // Peek: what a link leads to, before opening it (no sign-in needed).
      const peek = /^\/api\/links\/([A-Za-z0-9_-]{20,40})$/.exec(path);
      if (peek && method === 'GET') {
        const { docId: _docId, ...peeked } = app.docs.peekLink(peek[1]); // the id is for link previews on the server, not for the visitor
        send(200, { ...peeked, signedIn: !!actor && !isGuest(actor.sub), guest: !!actor && isGuest(actor.sub) });
        return;
      }
      if (path === '/api/links/redeem' && method === 'POST') {
        const b = await json(req);
        const key = String(b.key ?? '');
        const info = app.docs.peekLink(key);
        if (!info.active) throw new Fault(404, 'This link no longer works. It may have expired or been turned off; ask whoever sent it for a new one.');
        if (actor) {
          const r = app.docs.redeemLink(key, actor);
          send(200, { docId: r.doc.id, title: r.doc.title, role: r.role, guest: isGuest(actor.sub), you: publicActor(actor) });
          return;
        }
        if (info.audience !== 'anyone') throw new Fault(401, 'Sign in with Archipelago to open this link.');
        const linkId = app.docs.linkById(key)?.id ?? '?';
        if (!guestLimiter.take(clientNetwork(req, proxyHops, app.config.clientIpHeader), linkId)) throw new Fault(429, 'Too many new visitors just now. Try again later, or sign in.');
        // The guest, their session and the redemption stand or fall together.
        const made = app.db.transaction(() => {
          const g = app.principals.createGuest(typeof b.name === 'string' ? b.name : undefined);
          const session = createGuestSession(g.sub);
          const who = app.principals.guestActor(g.sub, Date.now() + GUEST_SESSION_MS)!;
          return { session, who, r: app.docs.redeemLink(key, who) };
        })();
        res.setHeader('Set-Cookie', cookie('docs_session', made.session.token, made.session.maxAge));
        viewer = made.who;
        send(200, { docId: made.r.doc.id, title: made.r.doc.title, role: made.r.role, guest: true, you: publicActor(made.who) });
        return;
      }

      // Guests (link visitors without an Archipelago sign-in) get the document routes only.
      if (actor && isGuest(actor.sub) && path.startsWith('/api/') && !guestAllowed(method, path)) {
        throw new Fault(403, 'Sign in with Archipelago to do this.');
      }
      if (path === '/api/guest/name' && method === 'POST') {
        if (!actor) throw new Fault(401, 'Open a share link first.');
        const b = await json(req);
        const p = app.principals.renameGuest(actor.sub, String(b.name ?? ''));
        send(200, { you: publicActor({ ...actor, name: p.name }) });
        return;
      }

      // ------------------------------------------------ agent operations (HTTP)
      if (path === '/api/tools' && method === 'GET') {
        send(200, { tools: TOOLS.map((t) => ({ name: t.name, featureSet: t.featureSet, description: t.description, inputSchema: t.inputSchema })) });
        return;
      }
      if (path.startsWith('/api/operations/') && method === 'POST') {
        if (!actor) throw new Fault(401, 'Authenticate with an Archipelago token.');
        const r = await runTool(app, actor, decodeURIComponent(path.slice('/api/operations/'.length)), await json(req));
        send(r.isError ? 400 : 200, r);
        return;
      }

      // ------------------------------------------------ HTML pages, as themselves (with their files)
      const pm = /^\/p\/([A-Za-z0-9]+)(?:\/(.*))?$/.exec(path);
      if (pm && (method === 'GET' || method === 'HEAD')) {
        const d = app.docs.get(pm[1]);
        if (!d) throw new Fault(404, 'No such page.');
        const rest = pm[2]; // undefined: "/p/<id>"; "": "/p/<id>/"; otherwise a sub-path
        // Signed path: the page or one of its files, no session needed (the token is the capability).
        const tm = rest !== undefined ? /^t\/([0-9a-z]+\.[A-Za-z0-9_-]{22})(?:\/(.*))?$/.exec(rest) : null;
        if (tm) {
          res.setHeader('Access-Control-Allow-Origin', '*'); // errors too: the page's scripts see a 404, not a CORS failure
          if (!app.pageKeys.verify(d.id, tm[1])) throw new Fault(404, 'This page address has expired; open the page again.');
          const sub = tm[2] ?? '';
          if (sub === '') {
            if (d.type !== 'html') throw new Fault(404, 'Not an HTML page.');
            let body = app.nodes.flatten(d.id, { sub: d.ownerSub, admin: false });
            // Framed by the app with ?annotate=1: the annotation layer rides along (selection → comment, highlights, text edits; the app confirms everything).
            if (url.searchParams.get('annotate') === '1') { const tag = '<script src="/page-annotate.js" data-anima-ui></script>'; body = /<\/body\s*>/i.test(body) ? body.replace(/<\/body\s*>/i, `${tag}\n</body>`) : `${body}\n${tag}`; }
            sendPage(req, res, body, d.rev);
          }
          else sendDocFile(req, res, d.id, sub);
          return;
        }
        // A person navigating to the short link gets the app around the page (title, share, comments, edit);
        // frames, agents, non-browsers and ?raw=1 get the page itself (redirected to its signed path below).
        const browserNav = method === 'GET' && (rest === undefined || rest === '') && req.headers['sec-fetch-dest'] === 'document' && String(req.headers.accept ?? '').includes('text/html') && !url.searchParams.has('raw') && !url.searchParams.has('format');
        if (browserNav) { sendShell(res, docMeta(d, `${app.config.origin}/p/${d.id}`)); return; }
        const role = actor ? app.docs.role(d.id, actor) : null;
        if (actor && !role) throw new Fault(404, 'No such page.');
        if (!actor) {
          // No session: the bare page needs one (401); the short link gets the shell — the app asks to sign in, crawlers read the card.
          if ((rest === undefined || rest === '') && !url.searchParams.has('raw') && !url.searchParams.has('format')) { sendShell(res, docMeta(d, `${app.config.origin}/p/${d.id}`)); return; }
          throw new Fault(401, 'Sign in to view this page.');
        }
        if (rest !== undefined && rest !== '') { sendDocFile(req, res, d.id, rest); return; } // /p/<id>/<path> with a session or a bearer token: the file
        if (d.type !== 'html') { res.writeHead(302, { Location: `/d/${d.id}` }); res.end(); return; }
        // Agents asking for text get the markdown companion when the page has one.
        const accept = String(req.headers.accept ?? '');
        if ((url.searchParams.get('format') === 'md' || (accept.includes('text/markdown') && !accept.includes('text/html'))) && app.files.get(d.id, COMPANION)) {
          sendSandboxed(req, res, app.files.read(d.id, COMPANION)!.bytes, `"c${app.files.get(d.id, COMPANION)!.mediaId}"`, 'text/markdown; charset=utf-8');
          return;
        }
        // The page proper lives under a signed path, so its relative URLs (data, scripts, styles) resolve without a session.
        res.writeHead(302, { Location: `/p/${d.id}/t/${app.pageKeys.mint(d.id)}/${url.searchParams.get('annotate') === '1' ? '?annotate=1' : ''}`, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      // ------------------------------------------------ media
      if (path.startsWith('/media/') && (method === 'GET' || method === 'HEAD')) {
        const id = Media.idFrom(path);
        // Sandboxed pages (opaque origin) cannot send the session: media of shareable documents is open by id.
        if (!actor && !(id && mediaOpen(id))) throw new Fault(401, 'Sign in to view files.');
        const f = id ? app.media.locate(id) : null;
        if (!f) throw new Fault(404, 'Not found.');
        // Images, audio, video and PDF are served as what they are; anything else is a download
        // under its original name (never rendered by the browser: no HTML/SVG/script on this origin).
        const inline = inlineMime(f.info.mime);
        const name = (f.info.name ?? f.info.id).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
        const headers: Record<string, string | number> = {
          'Content-Type': inline ? f.info.mime : 'application/octet-stream',
          'Cache-Control': 'private, max-age=31536000, immutable',
          'Accept-Ranges': 'bytes',
          'X-Content-Type-Options': 'nosniff',
          ...(inline ? {} : { 'Content-Disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(f.info.name ?? f.info.id)}` }),
        };
        // Range requests: audio and video players seek, and Safari will not play without them.
        const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
        let start = 0, end = f.size - 1, status = 200;
        if (range && (range[1] || range[2])) {
          if (range[1]) { start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), f.size - 1) : f.size - 1; }
          else { start = Math.max(0, f.size - Number(range[2])); }
          if (start > end || start >= f.size) { res.writeHead(416, { 'Content-Range': `bytes */${f.size}` }); res.end(); return; }
          status = 206;
          headers['Content-Range'] = `bytes ${start}-${end}/${f.size}`;
        }
        headers['Content-Length'] = end - start + 1;
        res.writeHead(status, headers);
        if (method === 'HEAD') { res.end(); return; }
        const stream = createReadStream(f.file, { start, end });
        stream.on('error', (e) => { console.error('[media] read failed', f.info.id, e); res.destroy(); });
        res.on('close', () => stream.destroy());
        stream.pipe(res);
        return;
      }
      if (path === '/api/media' && method === 'POST') {
        if (!actor) throw new Fault(401, 'Sign in to upload.');
        const docId = url.searchParams.get('doc') ?? '';
        app.docs.require(docId, actor, 'editor'); // files belong to a document you can edit
        const used = (app.db.prepare('SELECT coalesce(sum(size), 0) AS n FROM media WHERE uploader_sub = ? AND created_at > ?').get(actor.sub, Date.now() - 86400_000) as { n: number }).n;
        if (used > app.config.uploadQuotaBytes) throw new Fault(429, 'Daily upload limit reached.');
        // Streamed to disk: a 300 MB video must not sit in memory.
        send(201, await app.media.putStream(req, actor.sub, docId, { name: url.searchParams.get('name'), maxBytes: app.config.uploadMaxBytes }));
        return;
      }

      // ------------------------------------------------ web app JSON API
      if (path.startsWith('/api/')) {
        if (!actor) throw new Fault(401, 'Sign in with Archipelago.');
        const a = actor;
        const P = app.principals;
        const linkView = (l: import('./documents.js').ShareLink) => ({ id: l.id, url: `${app.config.origin}/l/${l.key}`, role: l.role, who: l.audience, label: l.label,
          createdBy: { sub: l.createdBy, label: P.label(l.createdBy) }, createdAt: l.createdAt, expiresAt: l.expiresAt, holders: l.holders, active: l.active });
        const docView = (id: string) => {
          const d = app.docs.get(id)!;
          return { id: d.id, title: d.title, section: d.title === '', type: d.type, owner: { sub: d.ownerSub, label: P.label(d.ownerSub), kind: P.get(d.ownerSub)?.kind, color: P.get(d.ownerSub)?.color }, generalAccess: d.generalAccess,
            publicLink: app.docs.hasPublicLink(id),
            role: app.docs.role(id, a), rev: d.rev, updatedAt: d.updatedAt, createdAt: d.createdAt, openComments: app.comments.openCount(id), present: realtime.presence(id) };
        };
        if (path === '/api/docs' && method === 'GET') {
          send(200, { docs: app.docs.list(a, { query: url.searchParams.get('q') ?? undefined, filter: (url.searchParams.get('filter') as any) ?? 'all' }).map((d) => docView(d.id)) });
          return;
        }
        if (path === '/api/docs' && method === 'POST') {
          const b = await json(req);
          const d = app.docs.create(a, String(b.title ?? ''), typeof b.content === 'string' ? b.content : '', typeof b.type === 'string' ? b.type : 'markdown');
          send(201, docView(d.id));
          return;
        }
        // ---------------------------------------------------------- navigation trees
        if (path === '/api/trees' && method === 'GET') { send(200, { trees: app.trees.roots(a) }); return; }
        if (path === '/api/wiki/template' && method === 'GET') { send(200, { template: DEFAULT_TEMPLATE, slots: TEMPLATE_SLOTS }); return; }
        if (path === '/api/trees' && method === 'POST') { const b = await json(req); send(201, app.trees.create(String(b.root ?? ''), a)); return; }
        const tr = /^\/api\/trees\/([A-Za-z0-9]+)(\/.*)?$/.exec(path);
        if (tr) {
          const root = tr[1], rest = tr[2] ?? '';
          if (rest === '' && method === 'GET') { send(200, { ...app.trees.view(root, a), url: app.wiki.url(root) }); return; }
          if (rest === '' && method === 'DELETE') { app.trees.drop(root, a); send(200, { ok: true }); return; }
          if (rest === '/publish' && method === 'PATCH') {
            const b = await json(req);
            const ps = app.trees.setPublish(root, a, { published: b.published, slug: b.slug, domain: b.domain, theme: b.theme, scripts: typeof b.scripts === 'boolean' ? b.scripts : undefined });
            send(200, { ...ps, url: app.wiki.url(root) });
            return;
          }
          if (rest === '/reparent' && method === 'POST') {
            const b = await json(req);
            app.trees.reparent(root, String(b.child ?? ''), String(b.from ?? ''), String(b.to ?? ''), a, Number.isInteger(b.index) ? b.index : null);
            send(200, app.trees.view(root, a));
            return;
          }
          if (method === 'POST' && (rest === '/place' || rest === '/unplace' || rest === '/move')) {
            const b = await json(req);
            const parent = String(b.parent ?? ''), child = String(b.child ?? '');
            if (rest === '/place') { const ok = app.trees.place(root, parent, child, a); if (!ok) throw new Fault(409, 'That would place a page inside itself.'); }
            else if (rest === '/unplace') app.trees.unplace(root, parent, child, a);
            else app.trees.move(root, parent, child, a, b.dir === -1 || b.dir === 'up' ? -1 : 1);
            send(200, app.trees.view(root, a));
            return;
          }
        }
        const m = /^\/api\/docs\/([A-Za-z0-9]+)(\/.*)?$/.exec(path);
        if (m) {
          const id = m[1], rest = m[2] ?? '';
          if (rest === '' && method === 'GET') {
            const { role } = app.docs.require(id, a, 'viewer');
            // Guests see the document, not who else has access to it.
            send(200, { ...docView(id), acl: atLeast(role, 'viewer') && !isGuest(a.sub) ? app.docs.acl(id).map((x) => ({ ...x, label: P.label(x.sub), kind: P.get(x.sub)?.kind, name: P.get(x.sub)?.name, color: P.get(x.sub)?.color })) : [] });
            return;
          }
          if (rest === '' && method === 'PATCH') {
            const b = await json(req);
            if (typeof b.title === 'string') app.docs.rename(id, a, b.title);
            if (typeof b.type === 'string') app.docs.setType(id, a, b.type);
            if (typeof b.generalAccess === 'string') app.docs.setGeneralAccess(id, a, b.generalAccess);
            send(200, docView(id));
            return;
          }
          // ---------------------------------------------------------- nodes: the content tree and structural operations
          if (rest === '/tree' && method === 'GET') {
            app.docs.require(id, a, 'viewer');
            const t = app.nodes.tree(id, a);
            send(200, { ...t, nodes: t.nodes.map((n) => ({ ...n, role: app.docs.role(n.id, a) })), paths: app.trees.pathsOf(id, a) });
            return;
          }
          if (rest === '/files' && method === 'GET') { app.docs.require(id, a, 'viewer'); send(200, { files: app.files.list(id).map((f) => ({ ...f, url: `/p/${id}/${f.path}` })) }); return; }
          const fm = /^\/files\/(.+)$/.exec(rest);
          if (fm && (method === 'PUT' || method === 'DELETE')) {
            app.docs.require(id, a, 'editor');
            if (method === 'DELETE') { send(200, { removed: app.files.remove(id, decodeURIComponent(fm[1])) }); return; }
            const bytes = await readBody(req, app.config.uploadMaxBytes + 1024);
            const f = app.files.put(id, decodeURIComponent(fm[1]), bytes, a.sub, { maxBytes: app.config.uploadMaxBytes });
            send(201, { ...f, url: `/p/${id}/${f.path}` });
            return;
          }
          if (rest === '/paths' && method === 'GET') { app.docs.require(id, a, 'viewer'); send(200, { paths: app.trees.pathsOf(id, a), root: app.trees.isRoot(id) }); return; }
          if (rest === '/subpages' && method === 'GET') {
            app.docs.require(id, a, 'viewer');
            const tree = url.searchParams.get('tree') ?? '';
            const ids = tree && app.trees.isRoot(tree) ? app.trees.subpagesNotInline(tree, id).filter((c) => app.docs.role(c, a)) : [];
            send(200, { subpages: ids.map((c) => { const d = app.docs.get(c)!; return { id: c, title: d.title, type: d.type }; }) });
            return;
          }
          if (rest === '/split' && method === 'POST') {
            const b = await json(req);
            const child = app.nodes.split(id, { ...a, via: 'http' }, Number(b.at), { title: typeof b.title === 'string' ? b.title : undefined });
            send(201, docView(child.id));
            return;
          }
          if (rest === '/merge' && method === 'POST') { const b = await json(req); send(200, app.nodes.merge(id, String(b.child ?? ''), { ...a, via: 'http' })); return; }
          if (rest === '/mount' && method === 'POST') { const b = await json(req); app.nodes.mount(id, String(b.child ?? ''), { ...a, via: 'http' }, { at: Number.isInteger(b.at) ? b.at : undefined }); send(200, { ok: true }); return; }
          if (rest === '/unmount' && method === 'POST') { const b = await json(req); send(200, { removed: app.nodes.unmount(id, String(b.child ?? ''), { ...a, via: 'http' }) }); return; }
          if (rest === '/sections' && method === 'POST') {
            const b = await json(req);
            const d = app.nodes.createSection(id, { ...a, via: 'http' }, { content: typeof b.content === 'string' ? b.content : '', title: typeof b.title === 'string' ? b.title : '', type: typeof b.type === 'string' ? b.type : undefined, mount: b.mount !== false });
            send(201, docView(d.id));
            return;
          }
          if (rest === '' && method === 'DELETE') { app.docs.remove(id, a); send(200, { ok: true }); return; }
          if (rest === '/share' && method === 'POST') {
            const b = await json(req);
            const p = P.resolve(String(b.who ?? ''));
            app.docs.share(id, a, p.sub, b.role);
            send(200, { ok: true });
            return;
          }
          if (rest === '/links' && method === 'GET') {
            send(200, { links: app.docs.links(id, a).map(linkView) });
            return;
          }
          if (rest === '/links' && method === 'POST') {
            const b = await json(req);
            const l = app.docs.createLink(id, a, { role: b.role, audience: b.who, label: typeof b.label === 'string' ? b.label : null, expiresInDays: typeof b.expiresInDays === 'number' ? b.expiresInDays : null });
            send(201, linkView(l));
            return;
          }
          const lr = /^\/links\/([A-Za-z0-9]+)$/.exec(rest);
          if (lr && method === 'DELETE') {
            const l = app.docs.linkById(lr[1]);
            if (!l || l.docId !== id) throw new Fault(404, 'No such link.');
            send(200, linkView(app.docs.revokeLink(l.id, a)));
            return;
          }
          if (rest === '/versions' && method === 'GET') { app.docs.require(id, a, 'viewer'); send(200, { versions: app.docs.versions(id).map((v) => ({ ...v, by: P.label(v.createdBy) })) }); return; }
          if (rest === '/versions' && method === 'POST') { const b = await json(req); send(201, app.docs.saveVersion(id, a, String(b.name ?? ''))); return; }
          const vr = /^\/versions\/([a-z0-9]+)(\/restore)?$/.exec(rest);
          if (vr && method === 'GET') { app.docs.require(id, a, 'viewer'); send(200, { text: app.docs.textAt(id, app.docs.versionSnapshot(id, vr[1])) }); return; }
          if (vr && vr[2] && method === 'POST') { app.docs.restoreVersion(id, a, vr[1]); send(200, { ok: true }); return; }
          if (rest === '/activity' && method === 'GET') {
            app.docs.require(id, a, 'viewer');
            send(200, { activity: app.docs.activity(id, Date.now() - 30 * 86400_000).map((r) => ({ ...r, label: P.label(r.sub), kind: P.get(r.sub)?.kind, color: P.get(r.sub)?.color })) });
            return;
          }
          // ---------------------------------------------------------- pings
          if (rest === '/agents' && method === 'GET') {
            app.docs.require(id, a, 'commenter');
            send(200, { agents: app.attention.pingable(id) });
            return;
          }
          if (rest === '/ping' && method === 'POST') {
            app.docs.require(id, a, 'commenter');
            const b = await json(req);
            const r = await app.attention.ping({ sub: a.sub, kind: a.kind }, String(b.who ?? ''), id, {
              message: typeof b.message === 'string' ? b.message : undefined,
              quote: typeof b.quote === 'string' ? b.quote : undefined,
              line: Number.isInteger(b.line) ? b.line : undefined,
            });
            send(200, r);
            return;
          }

          // ---------------------------------------------------------- history (automatic checkpoints)
          if (rest === '/history' && method === 'GET') {
            app.docs.require(id, a, 'viewer');
            const before = Number(url.searchParams.get('before') ?? '') || undefined;
            const limit = Math.min(200, Number(url.searchParams.get('limit') ?? '') || 100);
            const list = app.history.list(id, { before, limit: limit + 1 });
            const person = (sub: string) => { const p = P.get(sub); return { sub, name: p?.name ?? sub, kind: p?.kind ?? 'human', color: p?.color ?? '#5f6368' }; };
            send(200, { checkpoints: list.slice(0, limit).map((c) => ({ ...c, authors: c.authors.map(person) })), more: list.length > limit });
            return;
          }
          if (rest === '/history/compare' && method === 'GET') {
            app.docs.require(id, a, 'viewer');
            const from = Number(url.searchParams.get('from'));
            const toRaw = url.searchParams.get('to') ?? '';
            const to = toRaw === 'now' ? 'now' as const : Number(toRaw || from);
            if (!Number.isInteger(from) || (to !== 'now' && !Number.isInteger(to))) throw new Fault(400, 'from and to must be change numbers (to may be "now").');
            const c = app.history.compare(id, from, to);
            send(200, { before: c.before, after: c.after, from: c.from, to: c.to });
            return;
          }
          const hr = /^\/history\/(\d+)\/(restore|undo)$/.exec(rest);
          if (hr && method === 'POST') {
            const b = await json(req);
            if (hr[2] === 'restore') app.history.restore(id, { ...a, via: 'http' }, Number(hr[1]), b.at === 'before' ? 'before' : 'after');
            else app.history.undo(id, { ...a, via: 'http' }, Number(hr[1]));
            send(200, { ok: true, rev: app.docs.get(id)!.rev });
            return;
          }
          if (rest === '/export.md' && method === 'GET') {
            const { doc } = app.docs.require(id, a, 'viewer');
            // The whole thing: every mounted section inlined.
            send(200, app.nodes.flatten(id, a), 'text/markdown; charset=utf-8', { 'Content-Disposition': `attachment; filename="${(doc.title || doc.id).replace(/[^\w .-]+/g, '_').slice(0, 80)}.md"` });
            return;
          }
        }
        if (path === '/api/people' && method === 'GET') {
          send(200, { people: P.list({ query: url.searchParams.get('q') ?? undefined, limit: 50 }).map((p) => ({ sub: p.sub, name: p.name, kind: p.kind, color: p.color, label: P.label(p.sub), issuer: p.issuer, role: p.role, lastSeen: p.lastSeen })) });
          return;
        }
        if (path === '/api/watches' && method === 'GET') {
          send(200, { watches: app.attention.watches(a.sub), defaults: app.attention.settings(a.sub, '*') });
          return;
        }
        if (path.startsWith('/api/admin/')) {
          if (!a.admin) throw new Fault(403, 'Admins only.');
          if (path === '/api/admin/principals' && method === 'GET') {
            send(200, { principals: P.list({ query: url.searchParams.get('q') ?? undefined, limit: 500, includeGuests: url.searchParams.get('guests') === '1' }).map((p) => ({ ...p, label: P.label(p.sub),
              docs: (app.db.prepare('SELECT count(*) AS n FROM documents WHERE owner_sub = ? AND deleted_at IS NULL').get(p.sub) as { n: number }).n,
              watches: (app.db.prepare('SELECT count(*) AS n FROM watches WHERE sub = ?').get(p.sub) as { n: number }).n })) });
            return;
          }
          const pr = /^\/api\/admin\/principals\/(.+)$/.exec(path);
          if (pr && method === 'POST') {
            const b = await json(req);
            const sub = decodeURIComponent(pr[1]);
            if (sub === a.sub && b.role !== 'admin') throw new Fault(400, 'You cannot demote or block yourself.');
            send(200, P.setRole(sub, b.role));
            return;
          }
        }
        throw new Fault(404, 'Not found.');
      }

      // ------------------------------------------------ static app shell
      if (method !== 'GET' && method !== 'HEAD') throw new Fault(405, 'Method not allowed.');
      // KaTeX's stylesheet and fonts (copied into public/katex by the web build); on wiki hosts too.
      const km = /^\/katex\/(katex\.min\.css|fonts\/KaTeX_[A-Za-z0-9-]+\.(?:woff2|woff|ttf))$/.exec(path);
      const st = km ? [`katex/${km[1]}`, km[1].endsWith('.css') ? 'text/css; charset=utf-8' : km[1].endsWith('.woff2') ? 'font/woff2' : km[1].endsWith('.woff') ? 'font/woff' : 'font/ttf'] as [string, string] : STATIC[path];
      if (st) {
        const file = join(PUBLIC_DIR, st[0]);
        if (!existsSync(file)) throw new Fault(404, 'Not built. Run npm run build:web.');
        const mtime = statSync(file).mtimeMs;
        const etag = `"${mtime.toString(36)}"`;
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); res.end(); return; }
        const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
        let cached = staticCache.get(file);
        if (!cached || cached.mtime !== mtime) staticCache.set(file, cached = { mtime, raw: readFileSync(file), gz: null });
        if (gzip && !cached.gz) cached.gz = gzipSync(cached.raw, { level: 9 });
        send(200, gzip ? cached.gz! : cached.raw, st[1], { 'Cache-Control': km ? 'public, max-age=604800' : 'no-cache', ETag: etag, Vary: 'Accept-Encoding', ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
        return;
      }
      const dmatch = /^\/d\/([A-Za-z0-9]+)$/.exec(path), lmatch = /^\/l\/([A-Za-z0-9_-]{20,40})$/.exec(path);
      if (dmatch) {
        const d = app.docs.get(dmatch[1]);
        sendShell(res, d ? docMeta(d, `${app.config.origin}/d/${d.id}`) : { ...GENERIC, url: `${app.config.origin}${path}` });
        return;
      }
      if (lmatch) {
        // The share link is itself the secret: an active anyone-link reveals the card; a members-only or dead link does not.
        const peek = app.docs.peekLink(lmatch[1]);
        const d = peek.active && peek.docId ? app.docs.get(peek.docId) : null;
        sendShell(res, d ? docMeta(d, `${app.config.origin}${path}`, true) : { ...GENERIC, url: `${app.config.origin}${path}` });
        return;
      }
      if (path === '/' || path === '/auth/callback' || path === '/admin' || path === '/people') {
        sendShell(res, { ...GENERIC, url: `${app.config.origin}${path === '/auth/callback' ? '/' : path}` });
        return;
      }
      throw new Fault(404, 'Not found.');
    } catch (e) {
      if (e instanceof Fault) {
        if (e.code) console.log(`[http] ${req.method} ${req.url?.split('?')[0]} → ${e.status} (${e.code})`);
        send(e.status, { error: e.message });
      } else {
        console.error('[http]', e);
        send(500, { error: 'Internal error.' });
      }
    }
  });

  realtime.attach(server);
  const mcpl = attachMcpl(server, app);
  // Upgrades for paths nobody claims are closed.
  server.on('upgrade', (req, socket) => {
    let p = '';
    try { p = new URL(req.url ?? '/', 'http://x').pathname; } catch { /* malformed: close below */ }
    if (p !== '/ws' && p !== '/mcpl') { try { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); } catch { /* ignore */ } socket.destroy(); }
  });
  return { server, realtime, mcpl };
}
