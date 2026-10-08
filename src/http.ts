// HTTP: sign-in, the web app's JSON API, media, and the agent operations API.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import type { App } from './app.js';
import { Fault, opaque, tokenHash, type Identity } from './auth.js';
import { isGuest, type Actor } from './principals.js';
import { attachMcpl } from './mcpl.js';
import { Realtime, maskFor, publicActor, type WebSession } from './realtime.js';
import { TOOLS, runTool } from './tools.js';
import { atLeast } from './documents.js';
import { MAX_IMAGE_BYTES, Media } from './media.js';

const PUBLIC_DIR = resolve(new URL('.', import.meta.url).pathname, '..', 'public');

const safeDecode = (v: string) => { try { return decodeURIComponent(v); } catch { return v; } };
const cookies = (req: IncomingMessage): Record<string, string> => Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => {
  const i = c.indexOf('=');
  return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), safeDecode(c.slice(i + 1).trim())];
}));
const UPLOAD_QUOTA_BYTES = 500 * 1024 * 1024; // per principal per day
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
  if (method === 'GET') return rest === '' || rest === '/versions' || /^\/versions\/[a-z0-9]+$/.test(rest) || rest === '/activity' || rest === '/history' || rest === '/history/compare' || rest === '/export.md';
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
  const b = await readBody(req);
  try { return JSON.parse(b.toString('utf8') || '{}'); } catch { throw new Fault(400, 'Invalid JSON.'); }
}

const STATIC: Record<string, [string, string]> = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
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

  // ---------------------------------------------------------------- server

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    const wsOrigin = app.config.origin.replace(/^http/, 'ws');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; connect-src 'self' ${wsOrigin}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
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
      // One public address: page and API reads arriving on another host (the platform's
      // default domain, say) are sent to the origin, so old links keep working.
      if (canonicalHost && (method === 'GET' || method === 'HEAD') && String(req.headers.host ?? '').toLowerCase() !== canonicalHost && !path.startsWith('/debug/')) {
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
        send(200, { ...app.docs.peekLink(peek[1]), signedIn: !!actor && !isGuest(actor.sub), guest: !!actor && isGuest(actor.sub) });
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

      // ------------------------------------------------ media
      if (path.startsWith('/media/') && (method === 'GET' || method === 'HEAD')) {
        if (!actor) throw new Fault(401, 'Sign in to view images.');
        const id = Media.idFrom(path);
        const f = id ? app.media.read(id) : null;
        if (!f) throw new Fault(404, 'Not found.');
        res.writeHead(200, { 'Content-Type': f.info.mime, 'Content-Length': f.info.size, 'Cache-Control': 'private, max-age=31536000, immutable' });
        res.end(method === 'HEAD' ? undefined : f.bytes);
        return;
      }
      if (path === '/api/media' && method === 'POST') {
        if (!actor) throw new Fault(401, 'Sign in to upload.');
        const docId = url.searchParams.get('doc') ?? '';
        app.docs.require(docId, actor, 'editor'); // images belong to a document you can edit
        const used = (app.db.prepare('SELECT coalesce(sum(size), 0) AS n FROM media WHERE uploader_sub = ? AND created_at > ?').get(actor.sub, Date.now() - 86400_000) as { n: number }).n;
        if (used > UPLOAD_QUOTA_BYTES) throw new Fault(429, 'Daily upload limit reached.');
        const bytes = await readBody(req, MAX_IMAGE_BYTES + 1024);
        send(201, app.media.put(bytes, actor.sub, docId));
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
          return { id: d.id, title: d.title, owner: { sub: d.ownerSub, label: P.label(d.ownerSub), kind: P.get(d.ownerSub)?.kind, color: P.get(d.ownerSub)?.color }, generalAccess: d.generalAccess,
            publicLink: app.docs.hasPublicLink(id),
            role: app.docs.role(id, a), rev: d.rev, updatedAt: d.updatedAt, createdAt: d.createdAt, openComments: app.comments.openCount(id), present: realtime.presence(id) };
        };
        if (path === '/api/docs' && method === 'GET') {
          send(200, { docs: app.docs.list(a, { query: url.searchParams.get('q') ?? undefined, filter: (url.searchParams.get('filter') as any) ?? 'all' }).map((d) => docView(d.id)) });
          return;
        }
        if (path === '/api/docs' && method === 'POST') {
          const b = await json(req);
          const d = app.docs.create(a, String(b.title ?? ''), typeof b.content === 'string' ? b.content : '');
          send(201, docView(d.id));
          return;
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
            if (typeof b.generalAccess === 'string') app.docs.setGeneralAccess(id, a, b.generalAccess);
            send(200, docView(id));
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
            send(200, app.docs.text(id), 'text/markdown; charset=utf-8', { 'Content-Disposition': `attachment; filename="${doc.title.replace(/[^\w .-]+/g, '_').slice(0, 80)}.md"` });
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
      const st = STATIC[path];
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
        send(200, gzip ? cached.gz! : cached.raw, st[1], { 'Cache-Control': 'no-cache', ETag: etag, Vary: 'Accept-Encoding', ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
        return;
      }
      if (path === '/' || path === '/auth/callback' || path === '/admin' || path === '/people' || /^\/d\/[A-Za-z0-9]+$/.test(path) || /^\/l\/[A-Za-z0-9_-]{20,40}$/.test(path)) {
        send(200, readFileSync(join(PUBLIC_DIR, 'index.html')), 'text/html; charset=utf-8');
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
