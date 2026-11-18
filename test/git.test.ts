// A collection as a git repository, driven with the real git and git-lfs clients.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './server-harness.js';

let S: Awaited<ReturnType<typeof startServer>>;
const HOME = mkdtempSync(join(tmpdir(), 'adocs-git-home-'));
before(async () => { S = await startServer(); });
after(async () => { await S.close(); rmSync(HOME, { recursive: true, force: true }); });

const hasLfs = (() => { try { execFileSync('git', ['lfs', 'version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const H = (extra: Record<string, string> = {}) => ({ Origin: S.base, 'Content-Type': 'application/json', ...extra });
const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');

async function signIn(name: string): Promise<string> {
  const r = await fetch(`${S.base}/auth/exchange`, { method: 'POST', headers: H({ Cookie: 'docs_login=x' }), body: JSON.stringify({ token: S.iss.mint(name, 'human') }) });
  assert.equal(r.status, 200, await r.clone().text());
  return `docs_session=${/docs_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')![1]}`;
}
/** A person with a session and a git password, and git run as them. */
async function person(name: string) {
  const cookie = await signIn(name);
  const made = await fetch(`${S.base}/api/git/password`, { method: 'POST', headers: H({ Cookie: cookie }) });
  assert.equal(made.status, 201, await made.clone().text());
  const password = (await made.json()).password as string;
  const remote = (id: string) => `${S.base.replace('://', `://${name.toLowerCase()}:${password}@`)}/git/${id}.git`;
  return { name, cookie, password, remote };
}
/** A small PNG, encoded by hand. */
function png(w = 2, h = 2): Buffer {
  const crc = (buf: Buffer) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x7f); for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * git, with nothing of this machine's configuration, as a named test user, with the LFS filter set up.
 * Never synchronously: the server it talks to runs in this process.
 */
function git(cwd: string, args: string[], o: { fails?: boolean } = {}): Promise<string> {
  const lfs = hasLfs ? ['-c', 'filter.lfs.clean=git-lfs clean -- %f', '-c', 'filter.lfs.smudge=git-lfs smudge -- %f', '-c', 'filter.lfs.process=git-lfs filter-process', '-c', 'filter.lfs.required=true'] : [];
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'user.name=Test Clone', '-c', 'user.email=clone@example.com', '-c', 'init.defaultBranch=main', ...lfs, ...args],
      { cwd, env: { ...process.env, HOME, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && !o.fails) reject(new Error(`git ${args.join(' ')} failed:\n${stdout}${stderr}`));
        else if (!err && o.fails) reject(new Error(`git ${args.join(' ')} was expected to fail; it said: ${stdout}${stderr}`));
        else resolve(err ? `${stdout}${stderr}` : stdout);
      });
  });
}
async function collection(cookie: string, title: string) {
  const doc = await (await fetch(`${S.base}/api/docs`, { method: 'POST', headers: H({ Cookie: cookie }), body: JSON.stringify({ title, type: 'files' }) })).json();
  const id = doc.id as string;
  return {
    id,
    put: async (path: string, body: string | Buffer) => { const r = await fetch(`${S.base}/api/docs/${id}/files/${enc(path)}`, { method: 'PUT', headers: { Cookie: cookie, Origin: S.base }, body }); assert.equal(r.status, 201, `${path}: ${await r.clone().text()}`); },
    del: (path: string) => fetch(`${S.base}/api/docs/${id}/files/${enc(path)}`, { method: 'DELETE', headers: { Cookie: cookie, Origin: S.base } }),
    paths: async () => ((await (await fetch(`${S.base}/api/docs/${id}/files`, { headers: { Cookie: cookie } })).json()).files as { path: string }[]).map((f) => f.path),
    read: async (path: string) => Buffer.from(await (await fetch(`${S.base}/p/${id}/${enc(path)}`, { headers: { Cookie: cookie } })).arrayBuffer()),
    log: async () => (await (await fetch(`${S.base}/api/docs/${id}/git/log`, { headers: { Cookie: cookie } })).json()).commits as { oid: string; parent: string | null; author: string; message: string; changes: { status: string; path: string }[] }[],
  };
}
const work = () => mkdtempSync(join(tmpdir(), 'adocs-git-work-'));
/** Clone as someone does who has run `git lfs install`: the filter (see git above) and the hook that uploads objects before a push. */
async function clone(dir: string, remote: string, name = 'repo') {
  await git(dir, ['clone', '--quiet', remote, name]);
  if (hasLfs) await git(join(dir, name), ['lfs', 'install', '--local']);
  return join(dir, name);
}
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

test('changes made in the browser are commits; a clone has the files, the large and the binary ones through LFS', { skip: !hasLfs && 'git-lfs is not installed' }, async () => {
  const ann = await person('Ann');
  const c = await collection(ann.cookie, 'Field work');
  const photo = png(64, 64), big = Buffer.from(`n,value\n${'1,0.123456789\n'.repeat(900_000)}`);
  assert.ok(big.length > 10 * 1024 * 1024);
  await c.put('Field notes.md', '# Notes\n\nlow tide\n');
  await c.put('photos/Island at dusk.png', photo);
  await c.put('data/readings.json', '{"n":[1,2]}');
  await c.put('data/Été — all [raw] runs.csv', big);
  await c.put('empty.txt', '');

  const dir = work();
  await clone(dir, ann.remote(c.id));
  const repo = join(dir, 'repo');
  assert.equal(readFileSync(join(repo, 'Field notes.md'), 'utf8'), '# Notes\n\nlow tide\n');
  assert.ok(readFileSync(join(repo, 'photos/Island at dusk.png')).equals(photo), 'the picture came through LFS whole');
  assert.ok(readFileSync(join(repo, 'data/Été — all [raw] runs.csv')).equals(big), 'so did the large file');
  assert.equal(readFileSync(join(repo, 'empty.txt')).length, 0);
  // Which files are LFS objects is what .gitattributes says: kinds by pattern, and the one large file by its own line.
  const attrs = readFileSync(join(repo, '.gitattributes'), 'utf8');
  assert.ok(attrs.includes('*.[pP][nN][gG] filter=lfs') && attrs.includes('"/data/Été — all \\\\[raw] runs.csv" filter=lfs'), attrs.split('\n').slice(-3).join('\n'));
  const tracked = (await git(repo, ['lfs', 'ls-files', '--name-only'])).trim().split('\n').sort();
  assert.deepEqual(tracked, ['data/Été — all [raw] runs.csv', 'photos/Island at dusk.png']);
  assert.equal(await git(repo, ['status', '--porcelain']), '', 'a fresh clone is clean: nothing "should have been a pointer"');
  // One upload, one commit, by the person who made it; no address of theirs in it.
  const log = (await git(repo, ['log', '--format=%an <%ae> %s'])).trim().split('\n');
  assert.ok(log.every((l) => l.startsWith('Ann <noreply@127.0.0.1> ')), log.join('\n'));
  assert.ok(log.some((l) => /Add \d+ files|Add Field notes\.md/.test(l)), log.join('\n'));
  // The collection shows the attributes file the repository needed.
  assert.ok((await c.paths()).includes('.gitattributes'));
  rmSync(dir, { recursive: true, force: true });
});

test('a push becomes the collection’s files; what is changed in the browser afterwards is pulled', { skip: !hasLfs && 'git-lfs is not installed' }, async () => {
  const ann = await person('Ann');
  const c = await collection(ann.cookie, 'Papers');
  await c.put('notes.md', 'one\n');
  await c.put('photo.png', png(8, 8));
  await c.put('data/readings.json', '{}');
  const dir = work(), repo = join(dir, 'repo');
  await clone(dir, ann.remote(c.id));

  writeFileSync(join(repo, 'notes.md'), 'one\ntwo\n');
  mkdirSync(join(repo, 'reports/2026'), { recursive: true });
  writeFileSync(join(repo, 'reports/2026/Survey (final).pdf'), PDF);
  mkdirSync(join(repo, 'pics'));
  renameSync(join(repo, 'photo.png'), join(repo, 'pics/photo.png'));
  rmSync(join(repo, 'data/readings.json'));
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '--quiet', '-m', 'Second pass']);
  await git(repo, ['push', '--quiet', 'origin', 'main']);

  assert.deepEqual(await c.paths(), ['.gitattributes', 'notes.md', 'pics/photo.png', 'reports/2026/Survey (final).pdf']);
  assert.equal((await c.read('notes.md')).toString(), 'one\ntwo\n');
  assert.ok((await c.read('reports/2026/Survey (final).pdf')).equals(PDF), 'the PDF went up through LFS and is served as itself');
  assert.ok((await c.read('pics/photo.png')).equals(png(8, 8)));
  const [last] = await c.log();
  assert.equal(last.message, 'Second pass');
  assert.deepEqual(last.changes.map((x) => `${x.status} ${x.path}`).sort(), ['A pics/photo.png', 'A reports/2026/Survey (final).pdf', 'D data/readings.json', 'D photo.png', 'M notes.md']);

  // Now the browser: one more file, a rename. A pull brings both, fast-forward.
  await c.put('reports/2026/summary.md', 'short\n');
  const moved = await fetch(`${S.base}/api/docs/${c.id}/files/move`, { method: 'POST', headers: H({ Cookie: ann.cookie }), body: JSON.stringify({ from: 'notes.md', to: 'Notes (old).md' }) });
  assert.equal(moved.status, 200);
  await git(repo, ['pull', '--quiet', '--ff-only']);
  assert.equal(readFileSync(join(repo, 'reports/2026/summary.md'), 'utf8'), 'short\n');
  assert.ok(existsSync(join(repo, 'Notes (old).md')) && !existsSync(join(repo, 'notes.md')));
  assert.equal(await git(repo, ['status', '--porcelain']), '');
  rmSync(dir, { recursive: true, force: true });
});

test('a push is checked before it is accepted: one branch, forward only, large files and pointers through LFS, plain files only', async () => {
  const ann = await person('Ann');
  const c = await collection(ann.cookie, 'Checked');
  await c.put('notes.md', 'one\n');
  const dir = work(), repo = join(dir, 'repo');
  await clone(dir, ann.remote(c.id));
  const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  const attempt = async (message: string, ...how: string[]) => { await git(repo, ['add', '-A']); await git(repo, ['commit', '--quiet', '-m', message]); return git(repo, ['push', ...how, 'origin', 'HEAD:main'], { fails: true }); };
  const undo = () => git(repo, ['reset', '--quiet', '--hard', base]);

  writeFileSync(join(repo, 'huge.dat'), randomBytes(11 * 1024 * 1024));
  assert.match(await attempt('too big'), /huge\.dat \(11\.0 MB\) is too large to push as a plain file[\s\S]*git lfs migrate import --include="huge\.dat"/);
  await undo();

  writeFileSync(join(repo, 'pointer.txt'), `version https://git-lfs.github.com/spec/v1\noid sha256:${'ab'.repeat(32)}\nsize 12345\n`);
  // Pushed past git-lfs's own check (which would stop it on this side): the server's is the one that counts.
  assert.match(await attempt('a pointer to nothing', '--no-verify'), /pointer\.txt is a Git LFS pointer, but its file was not uploaded/);
  await undo();

  execFileSync('ln', ['-s', 'notes.md', join(repo, 'link.md')]);
  assert.match(await attempt('a link'), /link\.md is a symbolic link: a collection holds plain files only/);
  await undo();

  writeFileSync(join(repo, 'ok.md'), 'fine\n');
  await git(repo, ['add', '-A']); await git(repo, ['commit', '--quiet', '-m', 'on a branch']);
  assert.match(await git(repo, ['push', 'origin', 'HEAD:refs/heads/draft'], { fails: true }), /A collection has one branch, main: draft cannot be pushed/);
  assert.match(await git(repo, ['push', 'origin', 'HEAD:refs/tags/v1'], { fails: true }), /one branch, main/);
  await git(repo, ['push', '--quiet', 'origin', 'HEAD:main']);
  await git(repo, ['commit', '--quiet', '--amend', '-m', 'rewritten']);
  assert.match(await git(repo, ['push', '--force', 'origin', 'HEAD:main'], { fails: true }), /non-fast-forward|denying non-fast-forward/);
  assert.match(await git(repo, ['push', 'origin', ':main'], { fails: true }), /deletion|delet/i);
  // Nothing refused left a trace.
  assert.deepEqual(await c.paths(), ['.gitattributes', 'notes.md', 'ok.md']);

  // A name a collection cannot hold.
  await git(repo, ['fetch', '--quiet', 'origin']);
  await git(repo, ['reset', '--quiet', '--hard', 'origin/main']);
  writeFileSync(join(repo, 'back\\slash.md'), 'x\n');
  assert.match(await attempt('a backslash'), /"back\\\\slash\.md" is not a file name a collection can hold/);
  await git(repo, ['reset', '--quiet', '--hard', 'origin/main']);

  // If the check cannot run (the hook lost its execute bit, say), git would let any push through: none is received.
  const hookFile = join(S.dir, 'git/hooks/pre-receive');
  writeFileSync(join(repo, 'unchecked.md'), 'never looked at\n');
  await git(repo, ['add', '-A']); await git(repo, ['commit', '--quiet', '-m', 'unchecked']);
  const logged = console.error;
  console.error = () => undefined;
  chmodSync(hookFile, 0o644);
  try { assert.match(await git(repo, ['push', 'origin', 'HEAD:main'], { fails: true }), /503/); } finally { chmodSync(hookFile, 0o755); console.error = logged; }
  assert.deepEqual(await c.paths(), ['.gitattributes', 'notes.md', 'ok.md']);

  // A push is checked at its tip. An earlier commit of it that holds what a collection cannot is in the history, and stays there.
  await git(repo, ['reset', '--quiet', '--hard', 'origin/main']);
  execFileSync('ln', ['-s', 'notes.md', join(repo, 'link.md')]);
  await git(repo, ['add', '-A']); await git(repo, ['commit', '--quiet', '-m', 'with a link']);
  const withLink = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  rmSync(join(repo, 'link.md'));
  await git(repo, ['add', '-A']); await git(repo, ['commit', '--quiet', '-m', 'without it']);
  await git(repo, ['push', '--quiet', 'origin', 'HEAD:main']);
  const back = await fetch(`${S.base}/api/docs/${c.id}/git/restore`, { method: 'POST', headers: H({ Cookie: ann.cookie }), body: JSON.stringify({ commit: withLink }) });
  assert.equal(back.status, 409);
  assert.match((await back.json()).error, /cannot be restored: link\.md is a symbolic link/);
  assert.deepEqual(await c.paths(), ['.gitattributes', 'notes.md', 'ok.md']);

  // Who may: a viewer reads and cannot push; a stranger sees no repository; no password, no entry.
  const bob = await person('Bob'), eve = await person('Eve');
  const share = await fetch(`${S.base}/api/docs/${c.id}/share`, { method: 'POST', headers: H({ Cookie: ann.cookie }), body: JSON.stringify({ who: '@Bob', role: 'viewer' }) });
  assert.equal(share.status, 200, await share.clone().text());
  await clone(dir, bob.remote(c.id), 'bob');
  writeFileSync(join(dir, 'bob/mine.md'), 'x\n');
  await git(join(dir, 'bob'), ['add', '-A']); await git(join(dir, 'bob'), ['commit', '--quiet', '-m', 'mine']);
  assert.match(await git(join(dir, 'bob'), ['push', 'origin', 'main'], { fails: true }), /403/);
  assert.match(await git(dir, ['ls-remote', eve.remote(c.id)], { fails: true }), /not found|404/i);
  assert.equal((await fetch(`${S.base}/git/${c.id}.git/info/refs?service=git-upload-pack`)).status, 401);
  assert.match(await git(dir, ['ls-remote', `${S.base.replace('://', '://ann:adg_wrong@')}/git/${c.id}.git`], { fails: true }), /Authentication failed|401|could not read/i);
  // An agent's Archipelago token is its password.
  const scout = S.token('Scout');
  await fetch(`${S.base}/api/operations/whoami`, { method: 'POST', headers: { Authorization: `Bearer ${scout}`, 'Content-Type': 'application/json' }, body: '{}' });
  await fetch(`${S.base}/api/docs/${c.id}/share`, { method: 'POST', headers: H({ Cookie: ann.cookie }), body: JSON.stringify({ who: '@Scout', role: 'viewer' }) });
  assert.match(await git(dir, ['ls-remote', `${S.base.replace('://', `://scout:${scout}@`)}/git/${c.id}.git`]), /refs\/heads\/main/);
  // A new password ends the old one.
  await fetch(`${S.base}/api/git/password`, { method: 'POST', headers: H({ Cookie: ann.cookie }) });
  assert.match(await git(dir, ['ls-remote', ann.remote(c.id)], { fails: true }), /Authentication failed|401|could not read/i);
  rmSync(dir, { recursive: true, force: true });
});

test('history: what changed and who; a deleted file, a folder and the whole collection can be brought back', async () => {
  const ann = await person('Ann');
  const c = await collection(ann.cookie, 'History');
  // Two people within one quiet spell share a commit, and it names both.
  {
    const cara = await person('Cara');
    const shared = await collection(ann.cookie, 'Shared');
    const give = await fetch(`${S.base}/api/docs/${shared.id}/share`, { method: 'POST', headers: H({ Cookie: ann.cookie }), body: JSON.stringify({ who: '@Cara', role: 'editor' }) });
    assert.equal(give.status, 200, await give.clone().text());
    await shared.put('from ann.md', 'a');
    assert.equal((await fetch(`${S.base}/api/docs/${shared.id}/files/${enc('from cara.md')}`, { method: 'PUT', headers: { Cookie: cara.cookie, Origin: S.base }, body: 'c' })).status, 201);
    const [both] = await shared.log();
    assert.equal(both.author, 'Ann, Cara');
    assert.equal(both.message, 'Add 2 files');
  }
  const restore = async (commit: string, path?: string) => { const r = await fetch(`${S.base}/api/docs/${c.id}/git/restore`, { method: 'POST', headers: H({ Cookie: ann.cookie }), body: JSON.stringify({ commit, path }) }); assert.equal(r.status, 200, await r.clone().text()); };
  await c.put('a.md', 'first\n');
  await c.put('papers/one.pdf', PDF);
  await c.put('papers/two.md', 'two\n');
  const first = (await c.log())[0];
  assert.equal(first.author, 'Ann');
  assert.deepEqual(first.changes.map((x) => `${x.status} ${x.path}`), ['A .gitattributes', 'A a.md', 'A papers/one.pdf', 'A papers/two.md']);

  await c.put('a.md', 'second\n');
  assert.equal((await c.log())[0].message, 'Change a.md');
  await c.del('papers/one.pdf');
  await c.put('papers/three.md', 'three\n');
  const deleted = (await c.log())[0];
  assert.equal(deleted.message, 'Add papers/three.md, remove papers/one.pdf');

  // The deleted file, from the commit before the one that removed it.
  await restore(deleted.parent!, 'papers/one.pdf');
  assert.ok((await c.read('papers/one.pdf')).equals(PDF));
  assert.equal((await c.log())[0].message, `Restore papers/one.pdf as of ${deleted.parent!.slice(0, 7)}`);
  // A folder as it was: what has been added to it since goes.
  await restore(first.oid, 'papers');
  assert.deepEqual((await c.paths()).filter((p) => p.startsWith('papers/')), ['papers/one.pdf', 'papers/two.md']);
  assert.equal((await c.read('a.md')).toString(), 'second\n', 'the rest is untouched');
  // Everything as it was.
  await c.put('later.md', 'x\n');
  await restore(first.oid);
  assert.deepEqual(await c.paths(), ['.gitattributes', 'a.md', 'papers/one.pdf', 'papers/two.md']);
  assert.equal((await c.read('a.md')).toString(), 'first\n');
  // Nothing was rewritten: every step is still in the history, newest first.
  const all = await c.log();
  assert.equal(all[0].message, `Restore the collection as of ${first.oid.slice(0, 7)}`);
  assert.equal(all[all.length - 1].oid, first.oid);
  // Not a commit of this collection.
  const other = await collection(ann.cookie, 'Other');
  await other.put('x.md', 'x');
  const foreign = (await other.log())[0].oid;
  assert.equal((await fetch(`${S.base}/api/docs/${c.id}/git/restore`, { method: 'POST', headers: H({ Cookie: ann.cookie }), body: JSON.stringify({ commit: foreign }) })).status, 404);
  // Viewers see the history and cannot restore.
  const bob = await person('Bob');
  await fetch(`${S.base}/api/docs/${c.id}/share`, { method: 'POST', headers: H({ Cookie: ann.cookie }), body: JSON.stringify({ who: '@Bob', role: 'viewer' }) });
  assert.equal((await fetch(`${S.base}/api/docs/${c.id}/git/log`, { headers: { Cookie: bob.cookie } })).status, 200);
  assert.equal((await fetch(`${S.base}/api/docs/${c.id}/git/restore`, { method: 'POST', headers: H({ Cookie: bob.cookie }), body: JSON.stringify({ commit: first.oid }) })).status, 403);
});
