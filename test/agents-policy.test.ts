// Who may bring agents into a document — per document, set by its owner — and the retirement of
// "everyone signed in" access (schema v12).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { core, tmpDir } from './helpers.js';
import { startServer, rawHost, until, sleep } from './server-harness.js';
import { openDatabase } from '../src/db.js';
import { Groups } from '../src/groups.js';

test('sharing with an agent follows the document’s setting; a group counts if an agent is in it', () => {
  const { db, docs, principals, actor } = core();
  const ann = actor('Ann'), ed = actor('Ed'), bo = actor('Bo');
  const bot = actor('Bot', 'agent');
  const d = docs.create(ann, 'Plan');
  docs.share(d.id, ann, ed.sub, 'editor');
  assert.equal(docs.agentsBy(d.id), 'editors', 'default: the owner and editors');
  docs.share(d.id, ed, bot.sub, 'viewer'); // an editor may
  docs.share(d.id, ann, bot.sub, 'none');

  docs.setAgentsBy(d.id, ann, 'owner');
  assert.throws(() => docs.share(d.id, ed, bot.sub, 'viewer'), /only the owner can bring agents in/);
  docs.share(d.id, ed, bo.sub, 'viewer'); // people are unaffected
  // a group with an agent in it is the same as the agent
  const groups = new Groups(db, principals);
  const crew = groups.create(ed, 'Crew');
  groups.addMember(ed, crew.sub, bot.sub);
  assert.throws(() => docs.share(d.id, ed, crew.sub, 'viewer'), /bring agents in/);
  docs.share(d.id, ann, crew.sub, 'viewer'); // the owner may
  // only the owner sets it
  assert.throws(() => docs.setAgentsBy(d.id, ed, 'everyone'), /owner/);
  assert.throws(() => docs.setAgentsBy(d.id, ann, 'nobody' as any), /owner, editors or everyone/);
});

test('mentions and assignments: a commenter is told the agent won’t hear; the owner agent always can be reached', () => {
  const { docs, comments, actor } = core();
  const ann = actor('Ann'), cy = actor('Cy');
  const bot = actor('Bot', 'agent');
  const d = docs.create(ann, 'Notes', 'one two three\n');
  docs.share(d.id, ann, cy.sub, 'commenter');
  docs.share(d.id, ann, bot.sub, 'editor');
  const r = comments.create(d.id, cy, { body: '@Bot have a look?' });
  assert.ok(r.warnings.some((w) => /Bot won't be notified/.test(w) && /owner and editors/.test(w)), r.warnings.join(' | '));
  assert.throws(() => comments.create(d.id, cy, { body: 'for you', assignee: '@Bot' }), /bring agents in/);
  docs.setAgentsBy(d.id, ann, 'everyone');
  assert.deepEqual(comments.create(d.id, cy, { body: '@Bot now?' }).warnings, []);

  // an agent that owns the document chose who may reach it there
  const own = docs.create(bot, 'Bot’s own', 'x\n');
  docs.share(own.id, bot, cy.sub, 'commenter');
  assert.deepEqual(comments.create(own.id, cy, { body: '@Bot hello' }).warnings, []);
});

test('a section follows the strictest of the documents it sits in', () => {
  const { docs, actor } = core();
  const ann = actor('Ann');
  const parent = docs.create(ann, 'Parent');
  const section = docs.createNode(ann, { title: '' });
  docs.setParents((id) => (id === section.id ? [parent.id] : []));
  assert.equal(docs.agentsBy(section.id), 'editors');
  docs.setAgentsBy(parent.id, ann, 'owner');
  assert.equal(docs.agentsBy(section.id), 'owner');
  docs.setAgentsBy(parent.id, ann, 'everyone');
  assert.equal(docs.agentsBy(section.id), 'editors', 'its own setting still counts when it is stricter');
});

test('v12: "everyone signed in" is retired; the people who used such a document keep their role there', () => {
  const file = join(tmpDir('adocs-v12-'), 'docs.db');
  const db0 = openDatabase(file);
  const ins = db0.prepare(`INSERT INTO principals (sub, name, kind, issuer, color, first_seen, last_seen) VALUES (?, ?, ?, 'x', '#000', 1, 1)`);
  ins.run('human:x:owner', 'Owner', 'human'); ins.run('human:x:used', 'Used', 'human'); ins.run('human:x:said', 'Said', 'human'); ins.run('human:x:never', 'Never', 'human');
  ins.run('guest:abc', 'G (guest)', 'guest');
  db0.prepare(`INSERT INTO documents (id, title, owner_sub, general_access, created_at, updated_at) VALUES ('dopen', 'Open', 'human:x:owner', 'commenter', 1, 1), ('dshut', 'Shut', 'human:x:owner', 'restricted', 1, 1)`).run();
  db0.prepare(`INSERT INTO doc_activity (doc_id, sub, minute, added, removed) VALUES ('dopen', 'human:x:used', 1, 5, 0), ('dopen', 'guest:abc', 1, 1, 0), ('dopen', 'human:x:owner', 1, 1, 0)`).run();
  db0.prepare(`INSERT INTO comments (id, doc_id, thread_id, author_sub, body, created_at) VALUES ('c1', 'dopen', 'c1', 'human:x:said', 'hi', 1)`).run();
  db0.exec(`ALTER TABLE documents DROP COLUMN agents_by`);
  db0.pragma('user_version = 11');
  db0.close();

  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
  let db: InstanceType<typeof Database>;
  try { db = openDatabase(file); } finally { console.log = orig; }
  assert.equal(db.pragma('user_version', { simple: true }), 12);
  assert.deepEqual(db.prepare(`SELECT id, general_access, agents_by FROM documents ORDER BY id`).all(),
    [{ id: 'dopen', general_access: 'restricted', agents_by: 'editors' }, { id: 'dshut', general_access: 'restricted', agents_by: 'editors' }]);
  assert.deepEqual(db.prepare(`SELECT sub, role FROM doc_acl WHERE doc_id = 'dopen' ORDER BY sub`).all(),
    [{ sub: 'human:x:said', role: 'commenter' }, { sub: 'human:x:used', role: 'commenter' }], 'editors and commenters keep it; guests, the owner and bystanders get nothing');
  assert.ok(logs.some((l) => /dopen had general access commenter → restricted; 2 who used it keep it/.test(l)), logs.join('\n'));
  // re-opening changes nothing
  db.close();
  assert.equal(openDatabase(file).pragma('user_version', { simple: true }), 12);
});

// ---------------------------------------------------------------- end to end

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.close(); });

const H = (extra: Record<string, string> = {}) => ({ Origin: S.base, 'Content-Type': 'application/json', ...extra });
async function signIn(name: string): Promise<string> {
  const r = await fetch(`${S.base}/auth/exchange`, { method: 'POST', headers: H({ Cookie: 'docs_login=x' }), body: JSON.stringify({ token: S.iss.mint(name, 'human') }) });
  assert.equal(r.status, 200);
  return `docs_session=${/docs_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')![1]}`;
}
const api = async (method: string, path: string, cookie: string | null, body?: unknown) => {
  const r = await fetch(`${S.base}${path}`, { method, headers: H(cookie ? { Cookie: cookie } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
};

test('end to end: a commenter’s mention and reply never reach the agent, nor may they ping it, until the owner allows everyone', async () => {
  const ann = await signIn('Ann');
  const cy = await signIn('Cy');
  const host = await rawHost(`ws://127.0.0.1:${S.port}/mcpl?token=${S.token('Helper')}`);
  try {
    const d = (await api('POST', '/api/docs', ann, { title: 'Draft', content: 'para\n' })).json;
    assert.equal(d.agentsBy, 'editors');
    await api('POST', `/api/docs/${d.id}/share`, ann, { who: '@Helper', role: 'editor' });
    await api('POST', `/api/docs/${d.id}/share`, ann, { who: '@Cy', role: 'commenter' });
    const view = (await api('GET', `/api/docs/${d.id}`, cy)).json;
    assert.equal(view.canInvolveAgents, false);
    const agents = (await api('GET', `/api/docs/${d.id}/agents`, cy)).json;
    assert.deepEqual(agents.agents, []);
    assert.match(agents.why, /only the owner and editors/);
    assert.equal((await api('POST', `/api/docs/${d.id}/ping`, cy, { who: 'agent:helper@test.local' })).status, 403);

    const cyActor = S.app.principals.get('human:test:cy') as any;
    S.app.comments.create(d.id, cyActor, { body: '@Helper can you check?' });
    // the agent starts a thread; Cy answers it
    const t = await host.tool('add_comment', { document: d.id, text: 'A question for whoever reads this.' });
    const tid = /(c\w+)/.exec(t.text)![1];
    S.app.comments.reply(tid, cyActor, 'Here is my answer.');
    await sleep(400);
    assert.equal(host.pushes.filter((p) => p.tags.includes('chat:mention') || p.tags.includes('chat:reply')).length, 0, 'nothing from a commenter reaches the agent');

    // Cy may not add the agent to a group that has documents shared with it either
    const annActor = S.app.principals.get('human:test:ann') as any;
    const g = S.app.groups.create(cyActor, 'Cy crew');
    S.app.docs.share(d.id, annActor, g.sub, 'viewer');
    assert.throws(() => S.app.groups.addMember(cyActor, g.sub, 'agent:helper@test.local'), /bring agents in/);

    assert.equal((await api('PATCH', `/api/docs/${d.id}`, cy, { agentsBy: 'everyone' })).status, 403, 'only the owner sets it');
    assert.equal((await api('PATCH', `/api/docs/${d.id}`, ann, { agentsBy: 'everyone' })).json.agentsBy, 'everyone');
    S.app.comments.create(d.id, cyActor, { body: '@Helper and now?' });
    await until(() => host.pushes.some((p) => p.tags.includes('chat:mention')), 'the mention arrives once allowed');
    assert.equal((await api('POST', `/api/docs/${d.id}/ping`, cy, { who: 'agent:helper@test.local' })).status, 200);
    S.app.groups.addMember(cyActor, g.sub, 'agent:helper@test.local');
  } finally { host.close(); }
});

test('MCPL: list_access names who may bring agents in; set_agent_access is for owners; set_general_access is gone', async () => {
  const host = await rawHost(`ws://127.0.0.1:${S.port}/mcpl?token=${S.token('Keeper2')}`);
  try {
    const made = await host.tool('create_document', { title: 'Kept', content: 'x\n' });
    const id = /\((d\w+)\)/.exec(made.text)![1];
    assert.match((await host.tool('list_access', { document: id })).text, /agents can be brought in by the owner and editors/);
    await host.tool('set_agent_access', { document: id, by: 'owner' });
    assert.match((await host.tool('list_access', { document: id })).text, /by the owner only/);
    const tools = await host.call('tools/list', {});
    const names = (tools.result.tools as { name: string }[]).map((t) => t.name);
    assert.ok(names.includes('set_agent_access'));
    assert.ok(!names.includes('set_general_access'));
  } finally { host.close(); }
});
