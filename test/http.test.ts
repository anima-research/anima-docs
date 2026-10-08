import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { startServer } from './server-harness.js';

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer({ DOCS_ADMINS: 'human:test:root' }); });
after(async () => { await S.close(); });

const H = (extra: Record<string, string> = {}) => ({ Origin: S.base, 'Content-Type': 'application/json', ...extra });

async function signIn(name: string): Promise<string> {
  const token = S.iss.mint(name, 'human');
  const r = await fetch(`${S.base}/auth/exchange`, { method: 'POST', headers: H({ Cookie: 'docs_login=x' }), body: JSON.stringify({ token }) });
  assert.equal(r.status, 200, await r.clone().text());
  const set = r.headers.get('set-cookie') ?? '';
  const m = /docs_session=([^;]+)/.exec(set);
  assert.ok(m, 'session cookie set');
  return `docs_session=${m![1]}`;
}

export function png(w = 2, h = 2): Buffer {
  const crc = (buf: Buffer) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x7f); for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('sign-in exchange: needs the login cookie, refuses replayed tokens, sets an HttpOnly session', async () => {
  const token = S.iss.mint('Ada', 'human');
  const noCookie = await fetch(`${S.base}/auth/exchange`, { method: 'POST', headers: H(), body: JSON.stringify({ token }) });
  assert.equal(noCookie.status, 401);
  const ok = await fetch(`${S.base}/auth/exchange`, { method: 'POST', headers: H({ Cookie: 'docs_login=x' }), body: JSON.stringify({ token }) });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Lax/);
  const replay = await fetch(`${S.base}/auth/exchange`, { method: 'POST', headers: H({ Cookie: 'docs_login=x' }), body: JSON.stringify({ token }) });
  assert.equal(replay.status, 401);
  const wrongAud = await fetch(`${S.base}/auth/exchange`, { method: 'POST', headers: H({ Cookie: 'docs_login=x' }), body: JSON.stringify({ token: S.iss.mint('Ada', 'human', 'board') }) });
  assert.equal(wrongAud.status, 401);
});

test('login redirects to the issuer for this audience', async () => {
  const r = await fetch(`${S.base}/auth/login`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location') ?? '', /^https:\/\/test\.local\/login\?audience=docs&state=/);
});

test('cookie mutations need our Origin; the dev issuer is off unless configured', async () => {
  const cookie = await signIn('Ann');
  const cross = await fetch(`${S.base}/api/docs`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{"title":"x"}' });
  assert.equal(cross.status, 403);
  const dev = await fetch(`${S.base}/dev/login`, { method: 'POST', headers: H(), body: '{"name":"x"}' });
  assert.equal(dev.status, 404);
  const anon = await fetch(`${S.base}/api/docs`);
  assert.equal(anon.status, 401);
});

test('web API: create, share by @name, roles, rename, export', async () => {
  const ann = await signIn('Ann');
  const bob = await signIn('Bob');
  const c = await (await fetch(`${S.base}/api/docs`, { method: 'POST', headers: H({ Cookie: ann }), body: JSON.stringify({ title: 'Shared', content: '# Hi\n' }) })).json();
  assert.equal(c.role, 'owner');
  assert.equal((await fetch(`${S.base}/api/docs/${c.id}`, { headers: { Cookie: bob } })).status, 404);
  assert.equal((await fetch(`${S.base}/api/docs/${c.id}/share`, { method: 'POST', headers: H({ Cookie: ann }), body: JSON.stringify({ who: '@Bob', role: 'commenter' }) })).status, 200);
  const asBob = await (await fetch(`${S.base}/api/docs/${c.id}`, { headers: { Cookie: bob } })).json();
  assert.equal(asBob.role, 'commenter');
  assert.equal((await fetch(`${S.base}/api/docs/${c.id}`, { method: 'PATCH', headers: H({ Cookie: bob }), body: '{"title":"nope"}' })).status, 403);
  const md = await fetch(`${S.base}/api/docs/${c.id}/export.md`, { headers: { Cookie: bob } });
  assert.equal(await md.text(), '# Hi\n');
});

test('media: upload validates type, serves to signed-in users only, agents can insert and view', async () => {
  const ann = await signIn('Ann');
  const d = await (await fetch(`${S.base}/api/docs`, { method: 'POST', headers: H({ Cookie: ann }), body: '{"title":"Pics"}' })).json();
  const bad = await fetch(`${S.base}/api/media?doc=${d.id}`, { method: 'POST', headers: { Cookie: ann, Origin: S.base }, body: '<svg/>' });
  assert.equal(bad.status, 415);
  const up = await fetch(`${S.base}/api/media?doc=${d.id}`, { method: 'POST', headers: { Cookie: ann, Origin: S.base, 'Content-Type': 'image/png' }, body: png(3, 2) });
  assert.equal(up.status, 201);
  const info = await up.json();
  assert.equal(info.width, 3); assert.equal(info.height, 2);
  assert.equal((await fetch(`${S.base}${info.url}`)).status, 401);
  assert.equal((await fetch(`${S.base}${info.url}`, { headers: { Cookie: ann } })).headers.get('content-type'), 'image/png');

  // Agent over the HTTP operations API.
  const agent = S.token('Painter');
  await fetch(`${S.base}/api/operations/whoami`, { method: 'POST', headers: { Authorization: `Bearer ${agent}`, 'Content-Type': 'application/json' }, body: '{}' });
  await fetch(`${S.base}/api/docs/${d.id}/share`, { method: 'POST', headers: H({ Cookie: ann }), body: JSON.stringify({ who: 'agent:painter@test.local', role: 'editor' }) });
  const ins = await (await fetch(`${S.base}/api/operations/insert_image`, { method: 'POST', headers: { Authorization: `Bearer ${agent}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ document: d.id, data_base64: png(4, 4).toString('base64'), alt: 'tiny' }) })).json();
  assert.match(ins.content[0].text, /Inserted !\[tiny\]\(\/media\/[0-9a-f]{32}\.png\)/);
  const view = await (await fetch(`${S.base}/api/operations/view_image`, { method: 'POST', headers: { Authorization: `Bearer ${agent}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ document: d.id, image: info.url }) })).json();
  assert.equal(view.content[1].type, 'image');
  assert.equal(view.content[1].mimeType, 'image/png');
  // SSRF guard: private and non-https URLs are refused.
  for (const u of ['http://example.com/a.png', 'https://127.0.0.1/a.png', 'https://10.0.0.1/x.png', 'https://100.64.1.1/x.png']) {
    const r = await (await fetch(`${S.base}/api/operations/insert_image`, { method: 'POST', headers: { Authorization: `Bearer ${agent}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ document: d.id, url: u }) })).json();
    assert.equal(r.isError, true, u);
  }
});

test('admin: identity management for humans and agents', async () => {
  const root = await signIn('Root');
  const ann = await signIn('Ann');
  assert.equal((await fetch(`${S.base}/api/admin/principals`, { headers: { Cookie: ann } })).status, 403);
  const list = await (await fetch(`${S.base}/api/admin/principals`, { headers: { Cookie: root } })).json();
  assert.ok(list.principals.some((p: any) => p.kind === 'agent'));
  assert.ok(list.principals.some((p: any) => p.kind === 'human'));
  const blocked = await fetch(`${S.base}/api/admin/principals/${encodeURIComponent('human:test:ann')}`, { method: 'POST', headers: H({ Cookie: root }), body: '{"role":"blocked"}' });
  assert.equal(blocked.status, 200);
  assert.equal((await fetch(`${S.base}/api/docs`, { headers: { Cookie: ann } })).status, 401, 'blocked user\'s session is gone');
  await fetch(`${S.base}/api/admin/principals/${encodeURIComponent('human:test:ann')}`, { method: 'POST', headers: H({ Cookie: root }), body: '{"role":"member"}' });
  const self = await fetch(`${S.base}/api/admin/principals/${encodeURIComponent('human:test:root')}`, { method: 'POST', headers: H({ Cookie: root }), body: '{"role":"blocked"}' });
  assert.equal(self.status, 400);
});

test('an https origin is canonical: reads on other hosts redirect there, health answers anywhere', async () => {
  const { startServer: start } = await import('./server-harness.js');
  const T = await start({ DOCS_ORIGIN: 'https://docs.example.org' });
  try {
    (T.app.config as any).origin = 'https://docs.example.org';
    // The harness rewrites the origin after listen; createHttp captured the canonical host before that.
    const r = await fetch(`${T.base}/l/abcdefghijklmnopqrstuvwx?x=1`, { redirect: 'manual' });
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), 'https://docs.example.org/l/abcdefghijklmnopqrstuvwx?x=1');
    assert.equal((await fetch(`${T.base}/health`)).status, 200);
  } finally { await T.close(); }
});

test('sessions: a 10-minute sign-in token gives a 30-day session; reads renew it daily, never past 90 days from sign-in', async () => {
  const token = S.iss.mint('Lena', 'human', 'docs', { ttl: 600 }); // like the home node's sign-in tokens
  const r = await fetch(`${S.base}/auth/exchange`, { method: 'POST', headers: H({ Cookie: 'docs_login=x' }), body: JSON.stringify({ token }) });
  assert.equal(r.status, 200);
  const set = r.headers.get('set-cookie') ?? '';
  const maxAge = Number(/docs_session=[^;]+;[^]*?Max-Age=(\d+)/.exec(set)![1]);
  assert.ok(maxAge > 29 * 86400 && maxAge <= 30 * 86400, `Max-Age ${maxAge}`);
  const cookie = `docs_session=${/docs_session=([^;]+)/.exec(set)![1]}`;
  const hash = (S.app.db.prepare("SELECT token_hash FROM sessions WHERE sub = 'human:test:lena' ORDER BY created_at DESC").get() as { token_hash: string }).token_hash;
  const row = () => S.app.db.prepare('SELECT expires_at, created_at FROM sessions WHERE token_hash = ?').get(hash) as { expires_at: number; created_at: number };
  // Fresh: a read doesn't renew (renewed at most daily).
  let me = await fetch(`${S.base}/api/me`, { headers: { Cookie: cookie } });
  assert.equal((await me.json()).you.name, 'Lena');
  assert.equal(me.headers.get('set-cookie'), null);
  // Ten days later (simulated): a read extends it to 30 days from now and re-sends the cookie.
  S.app.db.prepare('UPDATE sessions SET expires_at = ?, created_at = ? WHERE token_hash = ?').run(Date.now() + 20 * 86400_000, Date.now() - 10 * 86400_000, hash);
  me = await fetch(`${S.base}/api/me`, { headers: { Cookie: cookie } });
  assert.match(me.headers.get('set-cookie') ?? '', /docs_session=.*Max-Age=25(8|9)\d{4}/);
  assert.ok(row().expires_at > Date.now() + 29 * 86400_000);
  // Near the limit: it renews only up to 90 days after sign-in.
  S.app.db.prepare('UPDATE sessions SET expires_at = ?, created_at = ? WHERE token_hash = ?').run(Date.now() + 2 * 86400_000, Date.now() - 85 * 86400_000, hash);
  await fetch(`${S.base}/api/me`, { headers: { Cookie: cookie } });
  const capped = row();
  assert.ok(Math.abs(capped.expires_at - (capped.created_at + 90 * 86400_000)) < 1000, 'capped at 90 days from sign-in');
  // Expired: no renewal, signed out.
  S.app.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() - 1000, hash);
  me = await fetch(`${S.base}/api/me`, { headers: { Cookie: cookie } });
  assert.equal((await me.json()).you, null);
  assert.equal(me.headers.get('set-cookie'), null);
});
