// Groups: sharing with a group, membership resolved at read time, mentions fan out, scoped visibility.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './server-harness.js';

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
const api = async (cookie: string, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${S.base}${path}`, { method, headers: H({ Cookie: cookie }), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, json, text };
};

test('a group is shared with and mentioned like a person; membership changes apply at once; it is visible only to its people', async () => {
  const ann = await signIn('Ann'), bob = await signIn('Bob'), cid = await signIn('Cid');
  // Ann makes a group with Bob in it.
  const g = (await api(ann, 'POST', '/api/groups', { name: 'Research team' })).json;
  assert.equal(g.you, 'owner'); assert.equal(g.members.length, 1, 'the owner is the first member');
  const added = await api(ann, 'POST', `/api/groups/${g.sub}/members`, { who: 'Bob' });
  assert.equal(added.status, 200, added.text);
  assert.deepEqual(added.json.members.map((m: any) => m.name).sort(), ['Ann', 'Bob']);
  // Bob sees the group; Cid cannot.
  assert.ok((await api(bob, 'GET', '/api/groups')).json.groups.some((x: any) => x.sub === g.sub));
  assert.equal((await api(cid, 'GET', `/api/groups/${g.sub}`)).status, 404);
  assert.equal((await api(cid, 'POST', `/api/groups/${g.sub}/members`, { who: 'Cid' })).status, 404, 'strangers cannot touch it');
  assert.equal((await api(bob, 'POST', `/api/groups/${g.sub}/members`, { who: 'Cid' })).status, 403, 'members do not manage it');
  // A document shared with the group: Bob can open it as a viewer; Cid cannot.
  const d = (await api(ann, 'POST', '/api/docs', { title: 'Plan', content: '# Plan\n\nhello\n' })).json;
  assert.equal((await api(bob, 'GET', `/api/docs/${d.id}`)).status, 404);
  const sh = await api(ann, 'POST', `/api/docs/${d.id}/share`, { who: 'Research team', role: 'commenter' });
  assert.equal(sh.status, 200, sh.text);
  const bobView = await api(bob, 'GET', `/api/docs/${d.id}`);
  assert.equal(bobView.status, 200); assert.equal(bobView.json.role, 'commenter');
  assert.ok(bobView.json.acl.some((e: any) => e.sub === g.sub && e.kind === 'group' && e.role === 'commenter'), 'the ACL shows the group');
  assert.ok((await api(bob, 'GET', '/api/docs')).json.docs.some((x: any) => x.id === d.id), 'listed for the member');
  assert.equal((await api(cid, 'GET', `/api/docs/${d.id}`)).status, 404);
  // Cid joins: immediate access. Cid leaves: immediate loss.
  await api(ann, 'POST', `/api/groups/${g.sub}/members`, { who: 'Cid' });
  assert.equal((await api(cid, 'GET', `/api/docs/${d.id}`)).json.role, 'commenter');
  await api(ann, 'DELETE', `/api/groups/${g.sub}/members`, { who: 'Cid' });
  assert.equal((await api(cid, 'GET', `/api/docs/${d.id}`)).status, 404);
  // Direct share beats the group's when higher; the group's when direct is lower.
  await api(ann, 'POST', `/api/docs/${d.id}/share`, { who: 'Bob', role: 'editor' });
  assert.equal((await api(bob, 'GET', `/api/docs/${d.id}`)).json.role, 'editor');
  // A group cannot own a document.
  assert.equal((await api(ann, 'POST', `/api/docs/${d.id}/share`, { who: 'Research team', role: 'owner' })).status, 400);
  // People scoping: Bob and Ann see each other through the group; the group itself appears for pickers.
  const bobPeople = (await api(bob, 'GET', '/api/people')).json.people.map((p: any) => p.name);
  assert.ok(bobPeople.includes('Ann') && bobPeople.includes('Research team'), bobPeople.join(','));
  assert.ok(!(await api(cid, 'GET', '/api/people')).json.people.some((p: any) => p.name === 'Research team'), 'outsiders do not see the group');
  // Mentioning the group addresses its members: an agent with access comments "@Research team" and gets no "has no access" warning.
  const agent = S.token('Scribe');
  await fetch(`${S.base}/api/operations/whoami`, { method: 'POST', headers: { Authorization: `Bearer ${agent}`, 'Content-Type': 'application/json' }, body: '{}' });
  await api(ann, 'POST', `/api/docs/${d.id}/share`, { who: 'agent:scribe@test.local', role: 'commenter' });
  const c = await (await fetch(`${S.base}/api/operations/add_comment`, { method: 'POST', headers: { Authorization: `Bearer ${agent}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ document: d.id, text: 'Please review, @Research team' }) })).json();
  const ctext = c.content?.[0]?.text ?? JSON.stringify(c);
  assert.ok(!c.isError && !/no access/.test(ctext), ctext);
  // Rename and delete.
  assert.equal((await api(ann, 'PATCH', `/api/groups/${encodeURIComponent(g.sub)}`, { name: 'Core team' })).json.name, 'Core team', 'an encoded colon in the path works');
  assert.equal((await api(ann, 'DELETE', `/api/groups/${g.sub}`)).status, 200);
  assert.equal((await api(cid, 'GET', `/api/docs/${d.id}`)).status, 404);
  assert.equal((await api(bob, 'GET', `/api/docs/${d.id}`)).json.role, 'editor', 'direct share survives the group');
});
