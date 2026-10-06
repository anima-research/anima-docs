// End-to-end against the real Connectome host (agent-framework), over the wire.
//
// AF_PATH points at an agent-framework checkout with dist/ built (main ≥ RFC-006
// coalescing). The model is scripted; everything else is real: WebSocket MCPL,
// featureSets/update, push/event with coalescing, push/render at assembly, the
// host gate evaluating our docs:wake / docs:quiet tags, and tool dispatch.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { testIssuer } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { createApp, type App } from '../src/app.js';
import { createHttp } from '../src/http.js';
import { publicKeyFromString } from '../src/auth.js';

const AF = process.env.AF_PATH ?? '';
const available = !!AF && existsSync(join(AF, 'dist/src/index.js'));

let app: App, http: ReturnType<typeof createHttp>, framework: any, membrane: any, dir: string;
let script: any[][] = [];
let ok: () => any, toolCall: (name: string, input: Record<string, unknown>) => any;
const iss = testIssuer('test.local');
const settleLog: string[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(20); }
}
const calls = () => membrane.calls.length as number;
const request = (i = -1) => JSON.stringify(membrane.calls.at(i)?.messages ?? []);
const human = (name: string) => app.principals.admit({ sub: `human:test:${name.toLowerCase()}`, name, kind: 'human', issuer: 'test.local', scopes: [], claims: {}, exp: Date.now() / 1000 + 3600 }, 'web');

before(async () => {
  if (!available) return;
  dir = mkdtempSync(join(tmpdir(), 'adocs-e2e-'));
  const config = { ...loadConfig({ DOCS_DATA_DIR: dir, PORT: '0', DOCS_ORIGIN: 'http://127.0.0.1', DOCS_ISSUERS: `test.local=${iss.publicKey}` } as any) };
  app = createApp(config, new Map([['test.local', publicKeyFromString(iss.publicKey)]]), { commentSettleMs: 50, attentionLog: (m) => settleLog.push(m) });
  http = createHttp(app);
  await new Promise<void>((r) => http.server.listen(0, '127.0.0.1', () => r()));
  const port = (http.server.address() as AddressInfo).port;

  const { AgentFramework } = await import(pathToFileURL(join(AF, 'dist/src/index.js')).href);
  const mm = await import(pathToFileURL(join(AF, 'test/helpers/mock-membrane.ts')).href);
  ok = () => mm.createMockResponse([{ type: 'text', text: 'ok' }]);
  let n = 0;
  toolCall = (name, input) => mm.createMockResponse([{ type: 'tool_use', id: `toolu_01${String(++n).padStart(22, 'A')}`, name, input }], 'tool_use');
  membrane = new mm.MockMembrane();
  membrane.streamYielding = (req: unknown) => { membrane.calls.push(req); return new mm.MockYieldingStream(script.shift() ?? [ok()]); };

  framework = await AgentFramework.create({
    storePath: join(dir, 'host-store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test', systemPrompt: 'You collaborate on documents.' }],
    modules: [],
    gate: {
      configPath: join(dir, 'gate.json'),
      config: {
        policies: [
          { name: 'docs-quiet', match: { scope: ['mcpl:push-event'], source: 'docs', tagsAny: ['docs:quiet'] }, behavior: 'defer' },
          { name: 'docs-wake', match: { scope: ['mcpl:push-event'], source: 'docs', tagsAny: ['docs:wake'] }, behavior: 'always' },
          { name: 'docs-other', match: { source: 'docs' }, behavior: 'defer' },
        ],
        default: 'defer',
      },
    },
    mcplServers: [{ id: 'docs', toolPrefix: 'docs', url: `ws://127.0.0.1:${port}/mcpl`, token: iss.mint('Scout', 'agent'), reconnect: false }],
  });
  framework.start();
  await until(() => (app.attention as any).live('agent:scout@test.local').length > 0, 'agent connected with push granted');
});

after(async () => {
  if (!available) return;
  await framework?.stop();
  http.mcpl.clients.forEach((c: any) => c.terminate());
  http.realtime.close();
  await new Promise((r) => http.server.close(() => r(undefined)));
  app.close();
  rmSync(dir, { recursive: true, force: true });
});

test('host handshake: coalescing negotiated, tools listed under the docs prefix', { skip: !available && `AF_PATH not built (${AF})` }, async () => {
  const s = [...(app.attention as any).sessions.get('agent:scout@test.local')][0];
  assert.deepEqual(s.coalescing(), { plain: true, deferred: true, initial: true });
  const servers = framework.listMcplServers();
  const docs = servers.find((x: any) => x.id === 'docs');
  assert.ok(docs, 'docs server listed');
  const tools = framework.listToolClasses('scout').map((t: any) => t.tool);
  for (const t of ['docs--read_document', 'docs--edit_document', 'docs--add_comment', 'docs--watch']) assert.ok(tools.includes(t), `${t} available`);
});

test('share wakes the agent; agent reads, watches, and edits through real tool dispatch', { skip: !available }, async () => {
  const ada = human('Ada');
  const d = app.docs.create(ada, 'Q4 plan', '# Q4 plan\n\n## Goals\n\nShip the beta in Q4.\n\n## Risks\n\nNone yet.\n');
  const before = calls();
  script.push([
    toolCall('docs--read_document', { document: d.id }),
    toolCall('docs--watch', { document: d.id, edits: 'quiet', comments: 'wake', settle_seconds: 0.1 }),
    toolCall('docs--edit_document', { document: d.id, edits: [{ old_text: 'None yet.', new_text: '- Hiring may slip.' }] }),
    ok(),
  ]);
  app.docs.share(d.id, ada, 'agent:scout@test.local', 'editor');
  try { await until(() => calls() > before, 'share push woke the agent'); } catch (e) { console.log('ATTENTION LOG', settleLog); throw e; }
  assert.match(request(), /shared “Q4 plan”/);
  await until(() => app.docs.text(d.id).includes('Hiring may slip'), 'agent edit applied');
  await framework.runUntilIdle?.();
  const s = app.attention.settings('agent:scout@test.local', d.id);
  assert.equal(s.edits, 'quiet');
  assert.equal(s.settle_seconds, 0.1);
  (globalThis as any).__doc = d.id;
});

test('quiet edits do not wake; a mention does, and the pending diff is rendered at assembly', { skip: !available }, async () => {
  const d = (globalThis as any).__doc as string;
  const ada = human('Ada');
  const before = calls();
  // Two separate human edits while the agent is idle — they must coalesce into one rendered diff.
  app.docs.edit(d, { sub: ada.sub, via: 'web' }, (t) => { const s = t.toString(); t.insert(s.indexOf('in Q4') + 3, 'early '); });
  await sleep(250); // settle → deferred notice (docs:quiet) → host defers
  app.docs.edit(d, { sub: ada.sub, via: 'web' }, (t) => t.insert(t.length, '\n## Owners\n\nAda.\n'));
  await sleep(250);
  assert.equal(calls(), before, 'quiet edits must not wake the agent');

  const c = app.comments.create(d, ada, { body: '@Scout can you tighten the Goals sentence?', anchor: app.comments.anchorFromQuote(d, 'Ship the beta') });
  assert.deepEqual(c.comment.mentions, ['agent:scout@test.local']);
  await until(() => calls() > before, 'mention woke the agent');
  const req = request();
  if (process.env.E2E_DUMP) console.log('REQUEST3', JSON.stringify(membrane.calls.at(-1).messages.slice(-4), null, 1));
  assert.match(req, /Ada mentioned you in a comment/);
  assert.match(req, /can you tighten the Goals sentence/);
  // The deferred edit subject was rendered once, at assembly: one diff with both edits, attributed.
  assert.match(req, /changed since you last looked/);
  assert.match(req, /early Q4/);
  assert.match(req, /Owners/);
  assert.match(req, /Ada/);
  assert.equal((req.match(/changed since you last looked/g) ?? []).length, 1, 'both edits coalesced into one rendered occurrence');
  // The agent's own edit (Hiring may slip) must not be reported back to it as a change.
  assert.doesNotMatch(req.slice(req.indexOf('changed since you last looked')), /\+- Hiring may slip/);
  await framework.runUntilIdle?.();
});

test('a mention deleted before the agent sees it vanishes (retracted, not noted)', { skip: !available }, async () => {
  const d = (globalThis as any).__doc as string;
  const ada = human('Ada');
  app.attention.setWatch('agent:scout@test.local', d, { mentions: 'quiet' });
  const before = calls();
  const c = app.comments.create(d, ada, { body: '@Scout SECRET-DRAFT-REMARK please ignore' });
  await sleep(150);
  app.comments.remove(c.comment.id, ada);
  await sleep(150);
  assert.equal(calls(), before, 'quiet mention did not wake');
  app.attention.setWatch('agent:scout@test.local', d, { mentions: 'wake' });
  app.comments.create(d, ada, { body: '@Scout real question: are we on track?' });
  await until(() => calls() > before, 'second mention woke the agent');
  const req = request();
  assert.match(req, /real question/);
  assert.doesNotMatch(req, /SECRET-DRAFT-REMARK/, 'retracted mention left no trace');
  assert.doesNotMatch(req, /deleted the comment/, 'no deletion notice for something never seen');
  await framework.runUntilIdle?.();
});

test('agent replies in the thread via tools; human sees it attributed', { skip: !available }, async () => {
  const d = (globalThis as any).__doc as string;
  const ada = human('Ada');
  const root = app.comments.create(d, ada, { body: '@Scout please confirm the owners section', anchor: app.comments.anchorFromQuote(d, 'Owners') });
  const before = calls();
  script.push([toolCall('docs--reply_comment', { comment: root.comment.id, text: 'Confirmed — Ada owns it.', resolve: true }), ok()]);
  await until(() => calls() > before, 'mention woke the agent');
  await until(() => !!app.comments.thread(root.comment.id)?.root.resolvedAt, 'agent resolved the thread');
  const t = app.comments.thread(root.comment.id)!;
  assert.equal(t.replies.at(-1)?.author, 'agent:scout@test.local');
  assert.match(t.replies.at(-1)!.body, /Confirmed/);
  await framework.runUntilIdle?.();
});

test('reply in the agent\'s thread wakes it as chat:reply', { skip: !available }, async () => {
  const d = (globalThis as any).__doc as string;
  const ada = human('Ada');
  // The agent starts a thread (via a direct app call standing in for its tool) …
  const scout = app.principals.admit({ sub: 'agent:scout@test.local', name: 'Scout', kind: 'agent', issuer: 'test.local', scopes: [], claims: {}, exp: Date.now() / 1000 + 3600 }, 'mcpl');
  const t = app.comments.create(d, scout, { body: 'Should Risks mention budget?' });
  const before = calls();
  app.comments.reply(t.comment.id, ada, 'Yes, add a line about budget.');
  await until(() => calls() > before, 'reply woke the agent');
  assert.match(request(), /replied in a comment thread you're in/);
  assert.match(request(), /add a line about budget/);
  await framework.runUntilIdle?.();
});
