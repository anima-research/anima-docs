// Signature and initials fields: comment threads that mark where someone is asked to sign a PDF.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { startServer } from './server-harness.js';

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.close(); });

const hasPdfText = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const H = (extra: Record<string, string> = {}) => ({ Origin: S.base, 'Content-Type': 'application/json', ...extra });
async function signIn(name: string): Promise<string> {
  const r = await fetch(`${S.base}/auth/exchange`, { method: 'POST', headers: H({ Cookie: 'docs_login=x' }), body: JSON.stringify({ token: S.iss.mint(name, 'human') }) });
  assert.equal(r.status, 200, await r.clone().text());
  return `docs_session=${/docs_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')![1]}`;
}
/** A one-page PDF with lines of text, each at its own height. */
function pdfWith(lines: string[]): Buffer {
  const stream = `BT /F1 12 Tf ${lines.map((l, i) => `1 0 0 1 72 ${700 - i * 60} Tm (${l}) Tj`).join(' ')} ET`;
  const objs = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'];
  let pdf = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('an agent asks a person to sign a PDF: a field beside the words it names, assigned to them, answered when signed', { skip: !hasPdfText && 'pdftotext is not installed' }, async () => {
  const ann = await signIn('Ann');
  const scout = S.token('Scout');
  const op = async (name: string, args: unknown) => (await (await fetch(`${S.base}/api/operations/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${scout}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) })).json()).content[0].text as string;
  await op('whoami', {});
  const doc = await (await fetch(`${S.base}/api/docs`, { method: 'POST', headers: H({ Cookie: ann }), body: JSON.stringify({ title: 'Contracts', type: 'files' }) })).json();
  const id = doc.id as string;
  assert.equal((await fetch(`${S.base}/api/docs/${id}/share`, { method: 'POST', headers: H({ Cookie: ann }), body: JSON.stringify({ who: '@Scout', role: 'editor' }) })).status, 200);
  await op('attach_file', { document: id, path: 'deals/Lease 2026.pdf', content: pdfWith(['Lease agreement', 'Signature: ____________________', 'Initial here', 'Signature: (witness)']).toString('base64'), encoding: 'base64' });
  await op('attach_file', { document: id, path: 'notes.md', content: 'not a pdf' });

  const placed = await op('add_comment', { document: id, field: 'signature', file: 'deals/Lease 2026.pdf', near: 'Signature:', assign_to: '@Ann', text: 'The lease for the new office.' });
  assert.match(placed, /^Signature field on page 1 of deals\/Lease 2026\.pdf placed beside “Signature:” \(thread (c\w+)\)\. Assigned to Ann/);
  assert.ok(placed.includes(`/d/${id}?at=deals%2FLease%202026.pdf`), placed);
  const thread = /thread (c\w+)/.exec(placed)![1];
  // Where it went: to the right of the words, on their line (the second line of four, 60 points apart from 700 up).
  const stored = S.app.comments.get(thread)!.field!;
  assert.equal(stored.kind, 'signature');
  assert.equal(stored.page, 1);
  assert.ok(stored.x > 0.11 && stored.x < 0.45 && Math.abs(stored.y + stored.h - (792 - 640) / 792) < 0.03, JSON.stringify(stored));
  // The second "Signature:" on the page, and initials by a box.
  const witness = await op('add_comment', { document: id, field: 'signature', file: 'deals/Lease 2026.pdf', near: 'Signature:', occurrence: 2 });
  assert.ok(witness.includes('It is assigned to nobody'), witness);
  assert.ok(S.app.comments.get(/thread (c\w+)/.exec(witness)![1])!.field!.y > stored.y + 0.1);
  const initials = await op('add_comment', { document: id, field: 'initials', file: 'deals/Lease 2026.pdf', page: 1, box: [0.8, 0.9, 0.1, 0.04], assign_to: '@Ann' });
  assert.match(initials, /^Initials field on page 1/);

  // What cannot be: words that are not there, a page that is not there, a file that is not a PDF, a document that is not a collection.
  assert.match(await op('add_comment', { document: id, field: 'signature', file: 'deals/Lease 2026.pdf', near: 'Countersigned by' }), /“Countersigned by” is not in the text/);
  assert.match(await op('add_comment', { document: id, field: 'signature', file: 'deals/Lease 2026.pdf', near: 'Signature:', occurrence: 3 }), /appears 2 times/);
  assert.match(await op('add_comment', { document: id, field: 'signature', file: 'deals/Lease 2026.pdf', page: 4, box: [0.1, 0.1, 0.3, 0.05] }), /has 1 page; there is no page 4/);
  assert.match(await op('add_comment', { document: id, field: 'signature', file: 'notes.md', near: 'pdf' }), /notes\.md is not a PDF/);
  assert.match(await op('add_comment', { document: id, field: 'signature', file: 'deals/Lease 2026.pdf' }), /Say where the field goes/);
  const page = /\((d[A-Za-z0-9]+)\)/.exec(await op('create_document', { title: 'A page' }))![1];
  assert.match(await op('add_comment', { document: page, field: 'signature', file: 'x.pdf', near: 'x' }), /go on PDFs in a file collection/);
  assert.match(await op('add_comment', { document: page }), /text is required/);
  assert.match(await op('add_comment', { document: id, field: 'initial', file: 'deals/Lease 2026.pdf', near: 'Signature:' }), /field is "signature" or "initials"/);
  assert.match(await op('add_comment', { document: id, field: 'signature', file: 'deals/Lease 2026.pdf', near: 'Signature:', page: 3 }), /has 1 page; there is no page 3/);
  assert.match(await op('add_comment', { document: id, field: 'signature', file: 'deals/Lease 2026.pdf', page: 1, box: [1, 0.5, 0.2, 0.05] }), /a box inside the page/);
  // Who is asked must be able to sign: a person, with edit access (the signed PDF is a new version of the file).
  const bob = await signIn('Bob');
  assert.equal((await fetch(`${S.base}/api/docs/${id}/share`, { method: 'POST', headers: H({ Cookie: ann }), body: JSON.stringify({ who: '@Bob', role: 'commenter' }) })).status, 200, bob);
  assert.match(await op('add_comment', { document: id, field: 'initials', file: 'deals/Lease 2026.pdf', near: 'Initial here', assign_to: '@Bob' }), /Assigned to Bob\. They cannot edit this collection.*share it with them as an editor/s);
  assert.match(await op('add_comment', { document: id, field: 'initials', file: 'deals/Lease 2026.pdf', near: 'Initial here', assign_to: '@Scout' }), /who is not a person/);

  // A file that is renamed, or whose folder is, takes its places to sign with it.
  assert.equal(await op('move_file', { document: id, from: 'deals', to: 'signed deals' }), 'Moved deals to signed deals.');
  assert.equal(S.app.comments.get(thread)!.field!.path, 'signed deals/Lease 2026.pdf');
  await op('move_file', { document: id, from: 'signed deals/Lease 2026.pdf', to: 'deals/Lease 2026.pdf' });
  assert.equal(S.app.comments.get(thread)!.field!.path, 'deals/Lease 2026.pdf');

  // The agent sees its requests; when the person has signed, the thread is answered and closed.
  const open = await op('list_comments', { document: id });
  assert.ok(open.includes(`Thread ${thread} — Signature field on page 1 of deals/Lease 2026.pdf (open: not signed yet) — assigned to Ann`) && open.includes('The lease for the new office.'), open);
  S.app.comments.reply(thread, S.app.principals.admit({ ...S.app.verify(S.iss.mint('Ann', 'human')) }, 'web'), 'Signed.', { resolve: true });
  const done = await op('list_comments', { document: id, thread });
  assert.ok(done.includes('RESOLVED by Ann') && done.includes('Ann') && done.includes('Signed.') && !done.includes('not signed yet'), done);
});

test('a signature is kept for its owner alone: their browser session reads and writes it, no token does', async () => {
  const ann = await signIn('Ann'), bob = await signIn('Bob');
  const put = (cookie: string, kind: string, body: Buffer) => fetch(`${S.base}/api/me/${kind}`, { method: 'PUT', headers: { Cookie: cookie, Origin: S.base, 'Content-Type': 'image/png' }, body });
  assert.equal((await fetch(`${S.base}/api/me/signature`, { headers: { Cookie: ann } })).status, 404);
  assert.equal((await put(ann, 'signature', PNG)).status, 200);
  assert.equal((await put(ann, 'initials', Buffer.from('not an image at all, just text'))).status, 415);
  const got = await fetch(`${S.base}/api/me/signature`, { headers: { Cookie: ann } });
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal(got.headers.get('cache-control'), 'private, no-store');
  assert.ok(Buffer.from(await got.arrayBuffer()).equals(PNG));
  // Bob has none of his own, and Ann's is not his to see; there is no address for someone else's.
  assert.equal((await fetch(`${S.base}/api/me/signature`, { headers: { Cookie: bob } })).status, 404);
  // An agent, or Ann's own token outside a browser session: refused.
  for (const token of [S.token('Scout'), S.iss.mint('Ann', 'human')]) {
    assert.equal((await fetch(`${S.base}/api/me/signature`, { headers: { Authorization: `Bearer ${token}` } })).status, 403);
    assert.equal((await fetch(`${S.base}/api/me/signature`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' }, body: PNG })).status, 403);
  }
  // A token beside a session does not make it a browser's request.
  assert.equal((await fetch(`${S.base}/api/me/signature`, { headers: { Cookie: ann, Authorization: `Bearer ${S.token('Scout')}` } })).status, 403);
  assert.equal((await fetch(`${S.base}/api/me/signature`)).status, 401);
  assert.equal((await fetch(`${S.base}/api/me/signature`, { method: 'DELETE', headers: { Cookie: ann, Origin: S.base } })).status, 200);
  assert.equal((await fetch(`${S.base}/api/me/signature`, { headers: { Cookie: ann } })).status, 404);
});

test('two saves made from the same version: the one that lands second is refused, however the uploads overlap', async () => {
  const ann = await signIn('Ann');
  const doc = await (await fetch(`${S.base}/api/docs`, { method: 'POST', headers: H({ Cookie: ann }), body: JSON.stringify({ title: 'Race', type: 'files' }) })).json();
  const url = `${S.base}/api/docs/${doc.id}/files/form.pdf`;
  const first = await (await fetch(url, { method: 'PUT', headers: { Cookie: ann, Origin: S.base }, body: 'version one' })).json();
  const from = { Cookie: ann, Origin: S.base, 'If-Match': `"f${first.mediaId}"` };
  // A slow upload starts (and passes the check made before its bytes are taken)…
  let finish!: () => void;
  const held = new Promise<void>((r) => { finish = r; });
  const slow = fetch(url, { method: 'PUT', headers: from, duplex: 'half', body: new ReadableStream({ async start(c) { c.enqueue(new TextEncoder().encode('the slow ')); await held; c.enqueue(new TextEncoder().encode('one')); c.close(); } }) } as RequestInit);
  await new Promise((r) => setTimeout(r, 150));
  // …a quick one from the same version lands meanwhile…
  assert.equal((await fetch(url, { method: 'PUT', headers: from, body: 'the quick one' })).status, 201);
  // …and the slow one, arriving second, does not replace it.
  finish();
  assert.equal((await slow).status, 412);
  assert.equal(await (await fetch(`${S.base}/p/${doc.id}/form.pdf`, { headers: { Cookie: ann } })).text(), 'the quick one');
});
