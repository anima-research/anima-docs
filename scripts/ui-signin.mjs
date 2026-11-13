#!/usr/bin/env node
// Signing in with Archipelago, end to end in a real headless browser.
//
// Starts the server on a fresh data directory with a test issuer whose pages
// the browser never reaches: requests to it are answered here, by a page that
// sends the browser back with a freshly minted sign-in token, as the real
// issuer does. Then:
//   1. the popup: the page stays where it is, the popup signs in and closes,
//      and the page loads again signed in, at the same address;
//   2. the same when the issuer cuts the link between the two windows
//      (Cross-Origin-Opener-Policy, as Google's sign-in does);
//   3. a popup the browser won't close: it says so, and can carry on as the app;
//   4. a blocked popup: the sign-in runs in the page's own window and comes
//      back to where it started.
//
//   npm run build:web && node scripts/ui-signin.mjs
//   env: SIGNIN_PORT (7369), SIGNIN_HEADED=1, SIGNIN_DEBUG=1 (log navigations and sign-in requests)

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, createPublicKey, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SIGNIN_PORT ?? 7369);
const ORIGIN = `http://localhost:${PORT}`;
const ISSUER = 'test.local';
const DATA = mkdtempSync(join(tmpdir(), 'docs-signin-'));

const { privateKey } = generateKeyPairSync('ed25519');
const publicKey = `ed25519:${createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url')}`;
function mint(name) {
  const iat = Math.floor(Date.now() / 1000);
  const payload = { v: 1, iss: ISSUER, sub: `human:test:${name.toLowerCase()}`, kind: 'human', name, aud: 'docs', scopes: [], iat, exp: iat + 600, jti: randomBytes(12).toString('base64url') };
  const head = `aid1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${head}.${sign(null, Buffer.from(head), privateKey).toString('base64url')}`;
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
let failed = false;
async function step(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); } catch (e) { failed = true; console.error(`✗ ${name}\n${e.stack ?? e}`); }
}

const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(PORT), DOCS_ORIGIN: ORIGIN, DOCS_DATA_DIR: DATA, DOCS_ISSUERS: `${ISSUER}=${publicKey}`, DOCS_DEV_ISSUER: '' },
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; ; i++) {
  try { if ((await fetch(`${ORIGIN}/api/config`)).ok) break; } catch { /* not up yet */ }
  if (i > 150) { console.error(serverLog); throw new Error('the server did not start'); }
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch({ headless: !process.env.SIGNIN_HEADED });

/** A browser of its own, with the issuer answered here. `coop`: the issuer's page cuts the opener link. */
async function visitor(name, { coop = false, blockPopups = false, keepOpen = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx.route(`https://${ISSUER}/**`, (route) => {
    const u = new URL(route.request().url());
    assert(u.pathname === '/login' && u.searchParams.get('audience') === 'docs', `unexpected issuer request ${u}`);
    const back = `${ORIGIN}/auth/callback#token=${mint(name)}&state=${encodeURIComponent(u.searchParams.get('state') ?? '')}`;
    return route.fulfill({
      status: 200, contentType: 'text/html',
      headers: coop ? { 'Cross-Origin-Opener-Policy': 'same-origin' } : {},
      body: `<!doctype html><title>issuer</title><script>setTimeout(() => location.replace(${JSON.stringify(back)}), 50)</script>`,
    });
  });
  // The browser follows the server's redirect to the issuer by itself, where nothing can answer for the issuer;
  // so the redirect is handed over as a page that goes there (the server's cookie kept), which can be answered.
  await ctx.route(`${ORIGIN}/auth/login*`, async (route) => {
    const r = await route.fetch({ maxRedirects: 0 });
    assert(r.status() === 302, `sign-in start answered ${r.status()}`);
    return route.fulfill({
      status: 200, contentType: 'text/html', headers: { 'set-cookie': r.headers()['set-cookie'] },
      body: `<!doctype html><title>to the issuer</title><script>location.replace(${JSON.stringify(r.headers()['location'])})</script>`,
    });
  });
  if (blockPopups) await ctx.addInitScript(() => { window.open = () => null; });
  if (keepOpen) await ctx.addInitScript(() => { window.close = () => {}; });
  if (process.env.SIGNIN_DEBUG) ctx.on('page', (p) => { p.on('console', (m) => console.log('   [console]', m.text().slice(0, 300))); p.on('framenavigated', (f) => { if (f === p.mainFrame()) console.log('   [nav]', f.url().slice(0, 120)); }); p.on('response', (r) => { if (r.status() >= 400 || r.url().includes('/auth/')) console.log('   [http]', r.status(), r.request().method(), r.url().slice(0, 100)); }); });
  const page = await ctx.newPage();
  return { ctx, page };
}
const signedInAs = (page, name) => page.waitForFunction(async (n) => (await (await fetch('/api/me')).json()).you?.name === n, name, { timeout: 15000 });

try {
  await step('popup: the page stays, the popup signs in and closes, the page carries on signed in', async () => {
    const { ctx, page } = await visitor('Ada');
    await page.goto(`${ORIGIN}/people`);
    const button = page.getByRole('link', { name: 'Sign in with Archipelago' });
    await button.waitFor();
    await page.evaluate(() => { window.__stayed = true; });
    const [popup] = await Promise.all([page.waitForEvent('popup'), button.click()]);
    const closed = popup.waitForEvent('close', { timeout: 15000 });
    await page.getByText('Sign in in the window that just opened').waitFor();
    await closed;
    await signedInAs(page, 'Ada');
    await page.locator('.topbar, header').first().waitFor();
    assert(new URL(page.url()).pathname === '/people', `the page moved to ${page.url()}`);
    assert(await page.evaluate(() => !window.__stayed), 'the page should have loaded again once signed in');
    assert(!(await page.getByRole('link', { name: 'Sign in with Archipelago' }).count()), 'still showing the sign-in page');
    await ctx.close();
  });

  await step('popup, opener link cut by the issuer (as Google does): the page still carries on signed in', async () => {
    const { ctx, page } = await visitor('Grace', { coop: true });
    await page.goto(`${ORIGIN}/groups`);
    const button = page.getByRole('link', { name: 'Sign in with Archipelago' });
    await button.waitFor();
    await Promise.all([ctx.waitForEvent('page'), button.click()]);
    await signedInAs(page, 'Grace');
    assert(new URL(page.url()).pathname === '/groups', `the page moved to ${page.url()}`);
    await ctx.close();
  });

  await step('popup the browser won\'t close: it says so, and can carry on as the app', async () => {
    const { ctx, page } = await visitor('Hedy', { keepOpen: true });
    await page.goto(`${ORIGIN}/people`);
    const button = page.getByRole('link', { name: 'Sign in with Archipelago' });
    await button.waitFor();
    const [popup] = await Promise.all([ctx.waitForEvent('page'), button.click()]);
    await signedInAs(page, 'Hedy');
    await popup.getByText('You’re signed in. You can close this window.').waitFor();
    await popup.getByRole('button', { name: 'Carry on in this window' }).click();
    await popup.waitForURL(`${ORIGIN}/people`, { timeout: 15000 });
    await signedInAs(popup, 'Hedy');
    await ctx.close();
  });

  await step('blocked popup: the sign-in runs in the same window and comes back to where it started', async () => {
    const { ctx, page } = await visitor('Linus', { blockPopups: true });
    await page.goto(`${ORIGIN}/people`);
    await page.getByRole('link', { name: 'Sign in with Archipelago' }).click();
    await page.waitForURL(`${ORIGIN}/people`, { timeout: 15000 });
    await signedInAs(page, 'Linus');
    assert(ctx.pages().length === 1, 'no second window');
    await ctx.close();
  });
} finally {
  await browser.close();
  server.kill();
  rmSync(DATA, { recursive: true, force: true });
}
if (failed) { console.error('\n--- server log ---\n' + serverLog.slice(-2000)); process.exit(1); }
console.log('sign-in: all passed');
