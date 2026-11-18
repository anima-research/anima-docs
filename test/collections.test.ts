import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './server-harness.js';

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer({}, { gitSettleMs: 30 }); });
after(async () => { await S.close(); });

const H = (extra: Record<string, string> = {}) => ({ Origin: S.base, 'Content-Type': 'application/json', ...extra });
async function signIn(name: string): Promise<string> {
  const r = await fetch(`${S.base}/auth/exchange`, { method: 'POST', headers: H({ Cookie: 'docs_login=x' }), body: JSON.stringify({ token: S.iss.mint(name, 'human') }) });
  assert.equal(r.status, 200, await r.clone().text());
  return `docs_session=${/docs_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')![1]}`;
}
const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');

async function collection(cookie: string, title = 'Papers') {
  const r = await fetch(`${S.base}/api/docs`, { method: 'POST', headers: H({ Cookie: cookie }), body: JSON.stringify({ title, type: 'files' }) });
  assert.equal(r.status, 201, await r.clone().text());
  const doc = await r.json();
  const put = (path: string, body: string | Buffer) => fetch(`${S.base}/api/docs/${doc.id}/files/${enc(path)}`, { method: 'PUT', headers: { Cookie: cookie, Origin: S.base }, body });
  const paths = async () => ((await (await fetch(`${S.base}/api/docs/${doc.id}/files`, { headers: { Cookie: cookie } })).json()).files as { path: string }[]).map((f) => f.path);
  return { id: doc.id as string, type: doc.type as string, put, paths };
}

test('a collection takes the names files really have, dotfiles and empty files included', async () => {
  const ann = await signIn('Ann');
  const c = await collection(ann);
  assert.equal(c.type, 'files');
  for (const p of ['papers/2024/Annual report (final).pdf', 'photos/Été à Kyïv.jpg', '.gitattributes', 'notes/empty.txt']) {
    const r = await c.put(p, p.endsWith('empty.txt') ? '' : `content of ${p}`);
    assert.equal(r.status, 201, `${p}: ${await r.clone().text()}`);
  }
  assert.deepEqual(await c.paths(), ['.gitattributes', 'notes/empty.txt', 'papers/2024/Annual report (final).pdf', 'photos/Été à Kyïv.jpg']);
  // The same name typed decomposed (as macOS sends it) is the same file.
  assert.equal((await c.put('photos/Été à Kyïv.jpg', 'again')).status, 201);
  assert.equal((await c.paths()).length, 4);
  // Encoded whole: a client would otherwise resolve the dots before sending.
  for (const bad of ['a/../b', 'a/./b', '.git/config', 'sub/.GIT/x', 'a\\b', ' lead', 'a//b']) {
    const r = await fetch(`${S.base}/api/docs/${c.id}/files/${encodeURIComponent(bad)}`, { method: 'PUT', headers: { Cookie: ann, Origin: S.base }, body: 'x' });
    assert.equal(r.status, 400, `${JSON.stringify(bad)} is refused`);
  }
  // A page keeps its narrow rule.
  const page = await (await fetch(`${S.base}/api/docs`, { method: 'POST', headers: H({ Cookie: ann }), body: JSON.stringify({ title: 'Page', type: 'html', content: '<p>x</p>' }) })).json();
  assert.equal((await fetch(`${S.base}/api/docs/${page.id}/files/${enc('My file.txt')}`, { method: 'PUT', headers: { Cookie: ann, Origin: S.base }, body: 'x' })).status, 400);
  assert.equal((await fetch(`${S.base}/api/docs/${page.id}/files/empty.txt`, { method: 'PUT', headers: { Cookie: ann, Origin: S.base }, body: '' })).status, 400);
});

test('files are served by path: text whole, anything else with ranges, and as a download under its name', async () => {
  const ann = await signIn('Ann');
  const c = await collection(ann);
  const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
  await c.put('data/blob one.bin', bytes);
  await c.put('notes/read me.md', '# Hello');
  await c.put('notes/empty.txt', '');
  const url = `${S.base}/p/${c.id}/${enc('data/blob one.bin')}`;
  assert.equal((await fetch(url)).status, 401, 'a session is needed');
  const whole = await fetch(url, { headers: { Cookie: ann } });
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.match(whole.headers.get('content-security-policy') ?? '', /^sandbox /, 'never runs on the app’s origin');
  assert.ok(Buffer.from(await whole.arrayBuffer()).equals(bytes));
  const part = await fetch(url, { headers: { Cookie: ann, Range: 'bytes=100-199' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 100-199/5000');
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(100, 200)));
  assert.equal((await fetch(url, { headers: { Cookie: ann, 'If-None-Match': whole.headers.get('etag')! } })).status, 304);
  const dl = await fetch(`${url}?download=1`, { headers: { Cookie: ann } });
  assert.match(dl.headers.get('content-disposition') ?? '', /^attachment; filename="blob one.bin"/);
  const md = await fetch(`${S.base}/p/${c.id}/${enc('notes/read me.md')}`, { headers: { Cookie: ann } });
  assert.equal(await md.text(), '# Hello');
  assert.match(md.headers.get('content-type') ?? '', /^text\/markdown/);
  const empty = await fetch(`${S.base}/p/${c.id}/notes/empty.txt`, { headers: { Cookie: ann } });
  assert.equal(empty.status, 200);
  assert.equal(await empty.text(), '');
  // Someone the collection is not shared with sees nothing.
  const bob = await signIn('Bob');
  assert.equal((await fetch(url, { headers: { Cookie: bob } })).status, 404);
  assert.equal((await fetch(`${S.base}/api/docs/${c.id}/files`, { headers: { Cookie: bob } })).status, 404);
});

test('folders: a file and a folder cannot share a name; moving and removing take everything under', async () => {
  const ann = await signIn('Ann');
  const c = await collection(ann);
  for (const p of ['a/one.txt', 'a/deep/two.txt', 'a_b/three.txt', 'b.txt']) assert.equal((await c.put(p, p)).status, 201);
  assert.equal((await c.put('a', 'x')).status, 409, 'a is a folder');
  assert.equal((await c.put('b.txt/inside', 'x')).status, 409, 'b.txt is a file');
  const move = (from: string, to: string) => fetch(`${S.base}/api/docs/${c.id}/files/move`, { method: 'POST', headers: H({ Cookie: ann }), body: JSON.stringify({ from, to }) });
  // "a" is the folder a/, not everything that starts with "a".
  assert.deepEqual(await (await move('a', 'archive/a')).json(), { moved: 2 });
  assert.deepEqual(await c.paths(), ['a_b/three.txt', 'archive/a/deep/two.txt', 'archive/a/one.txt', 'b.txt']);
  assert.deepEqual(await (await move('b.txt', 'archive/b renamed.txt')).json(), { moved: 1 });
  assert.equal((await move('a_b/three.txt', 'archive/a/one.txt')).status, 409, 'nothing is overwritten');
  assert.equal((await move('archive', 'archive/inner')).status, 400, 'not into itself');
  assert.equal((await move('nowhere', 'x')).status, 404);
  assert.equal(await (await fetch(`${S.base}/p/${c.id}/archive/a/one.txt`, { headers: { Cookie: ann } })).text(), 'a/one.txt', 'the content moved with the name');
  const gone = await fetch(`${S.base}/api/docs/${c.id}/files/archive/a?folder=1`, { method: 'DELETE', headers: { Cookie: ann, Origin: S.base } });
  assert.deepEqual(await gone.json(), { removed: 2 });
  assert.deepEqual(await c.paths(), ['a_b/three.txt', 'archive/b renamed.txt']);
  // Viewers read; they do not write.
  const bob = await signIn('Bob');
  const share = await fetch(`${S.base}/api/docs/${c.id}/share`, { method: 'POST', headers: H({ Cookie: ann }), body: JSON.stringify({ who: '@Bob', role: 'viewer' }) });
  assert.equal(share.status, 200, await share.clone().text());
  assert.equal((await fetch(`${S.base}/api/docs/${c.id}/files`, { headers: { Cookie: bob } })).status, 200);
  assert.equal((await fetch(`${S.base}/api/docs/${c.id}/files/new.txt`, { method: 'PUT', headers: { Cookie: bob, Origin: S.base }, body: 'x' })).status, 403);
  assert.equal((await fetch(`${S.base}/api/docs/${c.id}/files/move`, { method: 'POST', headers: H({ Cookie: bob }), body: JSON.stringify({ from: 'a_b', to: 'z' }) })).status, 403);
});

test('agents: a collection reads as its top folder; list, read, attach, move and remove work by path', async () => {
  const agent = S.token('Scout');
  const op = async (name: string, args: unknown) => (await (await fetch(`${S.base}/api/operations/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${agent}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) })).json()).content[0].text as string;
  const made = await op('create_document', { title: 'Field data', type: 'files' });
  const id = /\((d[A-Za-z0-9]+)\)/.exec(made)![1];
  assert.ok((await op('read_document', { document: id })).includes('It is empty'));
  assert.ok((await op('attach_file', { document: id, path: 'runs/2026-11/run 1.json', content: '{"ok":true,"n":[1,2]}' })).includes('Attached runs/2026-11/run 1.json (application/json'));
  await op('attach_file', { document: id, path: 'runs/2026-11/notes.md', content: 'line one\nline two' });
  await op('attach_file', { document: id, path: 'README', content: 'What this is.' });
  const top = await op('read_document', { document: id });
  assert.ok(top.includes('is a file collection: 3 files') && top.includes('runs/  folder, 2 files') && top.includes('README  text/plain'), top);
  const listed = await op('list_documents', {});
  assert.ok(listed.includes('[file collection]'), listed);
  const inner = await op('list_files', { document: id, folder: 'runs/2026-11' });
  assert.ok(inner.includes('runs/2026-11/run 1.json  application/json') && inner.includes('runs/2026-11/notes.md  text/markdown') && !inner.includes('README'), inner);
  assert.equal(await op('read_file', { document: id, path: 'runs/2026-11/run 1.json', json_pointer: '/n/1' }), '2');
  assert.equal(await op('move_file', { document: id, from: 'runs/2026-11', to: 'archive/november' }), 'Moved runs/2026-11 to archive/november (2 files).');
  assert.ok((await op('read_file', { document: id, path: 'archive/november/notes.md', from_line: 2, to_line: 2 })).includes('line two'));
  assert.equal(await op('remove_file', { document: id, path: 'archive', folder: true }), 'Removed archive (2 files).');
  assert.ok((await op('list_files', { document: id })).startsWith('README  text/plain'));
});

/** A one-page PDF with real text in it. */
function pdfSaying(words: string): Buffer {
  const stream = `BT /F1 24 Tf 40 100 Td (${words}) Tj ET`;
  const objs = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', '<</Type/Page/Parent 2 0 R/MediaBox[0 0 500 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'];
  let pdf = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
const run = (cmd: string, args: string[]) => new Promise<string>((resolve, reject) => execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (e, out, err) => (e ? reject(new Error(`${cmd}: ${err || e.message}`)) : resolve(out))));
const installed = (cmd: string, arg: string) => { try { execFileSync(cmd, [arg], { stdio: 'ignore' }); return true; } catch { return false; } };

test('a folder downloads as a zip any unzip reads: names, bytes and empty files intact', { skip: !installed('unzip', '-v') && 'unzip is not installed' }, async () => {
  const ann = await signIn('Ann');
  const c = await collection(ann, 'Trip photos');
  const blob = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 7) % 256));
  await c.put('trip/day 1/Été.bin', blob);
  await c.put('trip/day 1/notes.md', '# Day one');
  await c.put('trip/empty.txt', '');
  await c.put('elsewhere.txt', 'not in the folder');
  const res = await fetch(`${S.base}/api/docs/${c.id}/zip?folder=trip`, { headers: { Cookie: ann } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename="trip\.zip"/);
  const dir = mkdtempSync(join(tmpdir(), 'adocs-zip-'));
  writeFileSync(join(dir, 'trip.zip'), Buffer.from(await res.arrayBuffer()));
  assert.match(await run('unzip', ['-t', join(dir, 'trip.zip')]), /No errors detected/);
  await run('unzip', ['-q', join(dir, 'trip.zip'), '-d', join(dir, 'out')]);
  assert.ok(readFileSync(join(dir, 'out/day 1/Été.bin')).equals(blob));
  assert.equal(readFileSync(join(dir, 'out/day 1/notes.md'), 'utf8'), '# Day one');
  assert.equal(readFileSync(join(dir, 'out/empty.txt')).length, 0);
  // The whole collection is named after it.
  const all = await fetch(`${S.base}/api/docs/${c.id}/zip`, { headers: { Cookie: ann } });
  assert.match(all.headers.get('content-disposition') ?? '', /^attachment; filename="Trip photos\.zip"/);
  writeFileSync(join(dir, 'all.zip'), Buffer.from(await all.arrayBuffer()));
  assert.match(await run('unzip', ['-l', join(dir, 'all.zip')]), /elsewhere\.txt[\s\S]*4 files/);
  assert.equal((await fetch(`${S.base}/api/docs/${c.id}/zip?folder=nowhere`, { headers: { Cookie: ann } })).status, 404);
  assert.equal((await fetch(`${S.base}/api/docs/${c.id}/zip`)).status, 401);
  rmSync(dir, { recursive: true, force: true });
});

test('agents read the text of a PDF by page, and search a collection by name and by what its files say', { skip: !installed('pdftotext', '-v') && 'pdftotext is not installed' }, async () => {
  const agent = S.token('Reader');
  const op = async (name: string, args: unknown) => (await (await fetch(`${S.base}/api/operations/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${agent}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) })).json()).content[0].text as string;
  const id = /\((d[A-Za-z0-9]+)\)/.exec(await op('create_document', { title: 'Reports', type: 'files' }))![1];
  await op('attach_file', { document: id, path: 'reports/Heron survey 2026.pdf', content: pdfSaying('Seventeen herons were counted at low tide').toString('base64'), encoding: 'base64' });
  await op('attach_file', { document: id, path: 'notes/field.md', content: 'Tide tables\n\nThe herons arrive at dusk.' });
  await op('attach_file', { document: id, path: 'photo.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64'), encoding: 'base64' });
  const read = await op('read_file', { document: id, path: 'reports/Heron survey 2026.pdf' });
  assert.ok(read.startsWith('reports/Heron survey 2026.pdf: PDF, 1 page; pages 1–1:') && read.includes('— page 1 —\nSeventeen herons were counted at low tide'), read);
  assert.ok((await op('read_file', { document: id, path: 'photo.png' })).includes('(binary)'));
  const found = await op('search', { document: id, query: 'HERON' });
  assert.deepEqual(found.split('\n'), ['reports/Heron survey 2026.pdf  (name)', 'notes/field.md:3  The herons arrive at dusk.', 'reports/Heron survey 2026.pdf  p.1  Seventeen herons were counted at low tide']);
  assert.equal(await op('search', { document: id, query: 'albatross' }), 'No matches.');
});

test('agents see a collection’s history and bring back what was removed', async () => {
  const agent = S.token('Keeper');
  const op = async (name: string, args: unknown) => (await (await fetch(`${S.base}/api/operations/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${agent}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) })).json()).content[0].text as string;
  const id = /\((d[A-Za-z0-9]+)\)/.exec(await op('create_document', { title: 'Ledger', type: 'files' }))![1];
  await op('attach_file', { document: id, path: 'a.md', content: 'kept' });
  await op('attach_file', { document: id, path: 'old/b.md', content: 'to be removed' });
  const before = await op('versions', { document: id });
  assert.ok(before.includes('Keeper: Add 2 files') && before.includes('+ old/b.md') && before.includes(`/git/${id}.git`), before);
  const added = /^ {2}([0-9a-f]{10}) /m.exec(before)![1];
  await op('remove_file', { document: id, path: 'old', folder: true });
  const after = await op('versions', { document: id });
  assert.ok(after.includes('Keeper: Remove old/b.md') && after.includes('− old/b.md'), after);
  assert.equal(await op('restore_version', { document: id, version: added, path: 'old/b.md' }), `Restored old/b.md as of ${added}.`);
  assert.equal(await op('read_file', { document: id, path: 'old/b.md' }), 'to be removed');
  assert.ok((await op('restore_version', { document: id, version: 'abcdef1' })).includes('No change abcdef1'));
});
