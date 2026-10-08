// Network MCPL 0.5 endpoint (/mcpl). One WebSocket = one authenticated principal.
//
// Identity: an Archipelago aid1 token (Authorization: Bearer, or ?token= as
// Connectome hosts dial). The connection closes when the token expires; hosts
// redial with a fresh one.

import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { App } from './app.js';
import { Fault, type PrincipalKind } from './auth.js';
import type { Actor } from './principals.js';
import { TOOLS, TOOL_INDEX, runTool, type FeatureSet } from './tools.js';
import { FEATURE_SET as WATCH_FS, type AgentSession, type PushParams, type PushResult } from './attention.js';

const VERSION = '0.1.0';
const PUSH_TIMEOUT_MS = 30_000;

export const FEATURE_SETS: Record<FeatureSet, { description: string; uses: string[]; tagOntology?: unknown }> = {
  'docs.read': { description: 'Read documents, comments, images, people and history.', uses: ['tools'] },
  'docs.write': { description: 'Create and edit documents (attributed, live for everyone); accept or reject suggestions.', uses: ['tools'] },
  'docs.comment': { description: 'Comment threads: comment, reply, resolve, assign, @mention; suggest edits for review (suggest_edit).', uses: ['tools'] },
  'docs.share': { description: 'Manage who can access documents, and share links.', uses: ['tools'] },
  'docs.watch': {
    description: 'Push events: @mentions, assignments and replies to you (one per comment; edits replace, deletions withdraw); suggestions on documents you own and decisions on yours (one per settled burst); for watched documents, one attributed diff per document of what others changed (RFC-006 deferred: rendered when the agent is about to read it) and a comment digest; shares. Each event is tagged docs:wake or docs:quiet by the gates the agent sets with watch. Hosts should advertise eventCoalescing; gate rules: source <id> + docs:wake → always, source <id> → defer.',
    uses: ['tools', 'pushEvents'],
    tagOntology: {
      coreTags: ['chat:mention', 'chat:reply', 'chat:addressed', 'chat:edited', 'chat:deleted', 'chat:from-human', 'chat:from-agent'],
      tags: {
        'docs:wake': { desc: 'The recipient\'s own wake gate (set with the watch tool) says this should wake them.', facet: 'treatment' },
        'docs:quiet': { desc: 'The recipient\'s own wake gate says: deliver without waking.', facet: 'treatment' },
        'docs:edit': { desc: 'Document text changed; rendered as an attributed diff since the recipient last looked.' },
        'docs:comment': { desc: 'Comment activity.' },
        'docs:assigned': { desc: 'A comment thread was assigned to the recipient.', implies: ['chat:addressed'] },
        'docs:suggestion': { desc: 'Suggested edits on a document the recipient owns, awaiting their decision; or a decision (accepted / rejected) on the recipient\'s own suggestions.', implies: ['chat:addressed'] },
        'docs:share': { desc: 'A document was shared with (or unshared from) the recipient.' },
        'docs:from-guest': { desc: 'Activity by a guest: someone who opened an "anyone with the link" share link without signing in. Never wakes unless the recipient set guests: wake.' },
      },
      suggestedTreatment: [
        { name: 'docs-quiet', match: { tagsAny: ['docs:quiet'] }, behavior: 'defer' },
        { name: 'docs-wake', match: { tagsAny: ['docs:wake'] }, behavior: 'always' },
      ],
      open: true,
    },
  },
};

interface HostCoalescing { plain: boolean; deferred: boolean; initial: boolean }

function parseHostCoalescing(v: unknown): HostCoalescing {
  if (v === true) return { plain: true, deferred: true, initial: true };
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return { plain: o.pushEvents === true, deferred: o.pushEvents === true && o.deferred === true, initial: o.pushEvents === true };
  }
  return { plain: false, deferred: false, initial: false };
}

/** §5.4 path match: equal segment counts; '*' matches exactly one segment. */
const matches = (pattern: string, value: string) => {
  const a = pattern.split('.'), b = value.split('.');
  return a.length === b.length && a.every((p, i) => p === '*' || p === b[i]);
};

export class McplSession implements AgentSession {
  readonly id = `m${randomBytes(4).toString('hex')}`;
  readonly sub: string;
  private initialized = false;
  private ready = false;
  private mcpl = false;
  private hostCoalescing: HostCoalescing = { plain: false, deferred: false, initial: false };
  private granted = new Set<string>();
  private policyReceived = false;
  private enabled: Set<FeatureSet> = new Set(Object.keys(FEATURE_SETS) as FeatureSet[]);
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: any) => void; timer: NodeJS.Timeout }>();
  private wasPushReady = false;
  private closed = false;

  constructor(private app: App, private ws: WebSocket, private actor: Actor, private log: (m: string) => void) {
    this.sub = actor.sub;
  }

  // ---------------------------------------------------------------- AgentSession

  pushReady(): boolean {
    return !this.closed && this.ready && this.mcpl && this.policyReceived && this.granted.has('pushEvents') && this.enabled.has('docs.watch');
  }

  coalescing() { return this.hostCoalescing; }

  push(p: PushParams): Promise<PushResult | null> {
    if (!this.pushReady()) return Promise.resolve(null);
    return this.request('push/event', p) as Promise<PushResult | null>;
  }

  // ---------------------------------------------------------------- transport

  private send(msg: unknown) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }
  private result(id: unknown, result: unknown) { this.send({ jsonrpc: '2.0', id, result }); }
  private error(id: unknown, code: number, message: string, data?: unknown) {
    this.send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = `s${this.nextId++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null); }, PUSH_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve(null); }
    this.pending.clear();
    this.app.attention.unregister(this);
  }

  // ---------------------------------------------------------------- dispatch

  async handle(raw: string) {
    let m: any;
    try { m = JSON.parse(raw); } catch { this.error(null, -32700, 'Parse error'); return; }
    if (Array.isArray(m)) { this.error(null, -32600, 'Batches are not supported.'); return; }
    if (m?.jsonrpc !== '2.0') { this.error(m?.id ?? null, -32600, 'Invalid request'); return; }

    // Responses to our requests (push/event).
    if (typeof m.method !== 'string') {
      const p = this.pending.get(String(m.id));
      if (p) {
        this.pending.delete(String(m.id));
        clearTimeout(p.timer);
        if (m.error) this.log(`${this.actor.name}: host error on ${m.id}: ${m.error.message}`);
        p.resolve(m.error ? { accepted: false, reason: m.error.message } : m.result);
      }
      return;
    }

    const hasId = m.id !== undefined && m.id !== null;
    const params = m.params ?? {};
    if (this.actor.exp * 1000 <= Date.now()) { this.ws.close(4001, 'Identity expired; reconnect with a fresh token.'); return; }

    try {
      switch (m.method) {
        case 'initialize': {
          if (this.initialized) { if (hasId) this.error(m.id, -32600, 'Already initialized.'); return; }
          this.initialized = true;
          const hostMcpl = params?.capabilities?.experimental?.mcpl;
          this.mcpl = !!hostMcpl;
          this.hostCoalescing = parseHostCoalescing(hostMcpl?.eventCoalescing);
          if (!this.mcpl) { this.granted = new Set(['tools']); this.policyReceived = true; } // plain MCP: tools only
          this.result(m.id, {
            protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
            serverInfo: { name: 'anima-docs', version: VERSION },
            capabilities: {
              tools: {},
              ...(this.mcpl ? { experimental: { mcpl: { version: '0.5', pushEvents: true, featureSets: FEATURE_SETS } } } : {}),
            },
            instructions: this.instructions(),
          });
          return;
        }
        case 'notifications/initialized':
          if (this.initialized) { this.ready = true; this.maybeReady(); }
          return;
        case 'ping':
          if (hasId) this.result(m.id, {});
          return;
      }
      if (!this.ready) { if (hasId) this.error(m.id, -32002, 'Initialize first.'); return; }

      switch (m.method) {
        case 'featureSets/update': {
          if (!hasId) { this.narrow(params); return; } // §6.7: a Notification may only narrow
          const res = this.applyPolicy(params);
          if (hasId) {
            if ('error' in res && typeof res.error === 'string') this.error(m.id, -32602, res.error);
            else this.result(m.id, res);
          }
          this.maybeReady();
          return;
        }
        case 'tools/list': {
          if (!hasId) return;
          if (!this.granted.has('tools')) { this.error(m.id, -32002, 'Capability denied: tools', { capability: 'tools' }); return; }
          const tools = TOOLS.filter((t) => this.enabled.has(t.featureSet)).map((t) => ({
            name: t.name, description: t.description, inputSchema: t.inputSchema,
            _meta: { 'mcpl/class': [t.toolClass], 'mcpl/featureSet': t.featureSet },
          }));
          this.result(m.id, { tools });
          return;
        }
        case 'tools/call': {
          if (!hasId) return;
          if (!this.granted.has('tools')) { this.error(m.id, -32002, 'Capability denied: tools', { capability: 'tools' }); return; }
          const tool = TOOL_INDEX.get(params.name);
          if (!tool) { this.error(m.id, -32602, `Unknown tool ${params.name}`); return; }
          if (!this.enabled.has(tool.featureSet)) { this.error(m.id, -32001, `Feature set not enabled: ${tool.featureSet}`, { featureSet: tool.featureSet }); return; }
          // Re-admit on every call: a blocked principal or revoked access takes effect immediately.
          const actor = this.app.principals.admit({ sub: this.actor.sub, name: this.actor.name, kind: this.actor.kind as PrincipalKind, issuer: this.actor.issuer, scopes: this.actor.scopes, claims: {}, exp: this.actor.exp }, 'mcpl');
          const out = await runTool(this.app, actor, params.name, params.arguments);
          if (params.name === 'whoami' && !out.isError) out.content.push({ type: 'text', text: this.connectionGuide() });
          this.result(m.id, out);
          return;
        }
        case 'push/render': {
          if (!hasId) return;
          if (params.featureSet !== WATCH_FS || typeof params.key !== 'string') { this.error(m.id, -32602, 'Unknown render subject.'); return; }
          const out = await this.app.attention.render(this.sub, params.key);
          this.result(m.id, { content: out ? [{ type: 'text', text: out }] : [], timestamp: new Date().toISOString() });
          return;
        }
        default:
          // Host notifications we don't consume (inference/lifecycle, channels/*, …) are ignored.
          if (hasId) this.error(m.id, -32601, `Method not found: ${m.method}`);
      }
    } catch (e) {
      const msg = e instanceof Fault ? e.message : 'Internal error';
      if (!(e instanceof Fault)) console.error('[mcpl]', e);
      if (hasId) this.error(m.id, e instanceof Fault && e.status === 403 ? -32003 : -32603, msg);
    }
  }

  private applyPolicy(p: any): { error: string } | { accepted: true; [k: string]: unknown } {
    const arrays = ['effectiveCapabilities', 'deniedCapabilities', 'enabled', 'disabled'];
    if (arrays.some((k) => p[k] !== undefined && (!Array.isArray(p[k]) || p[k].some((v: unknown) => typeof v !== 'string')))) {
      this.granted.clear(); this.policyReceived = true;
      return { error: 'Malformed policy; grant cleared.' };
    }
    const allowed: string[] = p.effectiveCapabilities ?? [];
    const denied: string[] = p.deniedCapabilities ?? [];
    this.granted = new Set(['tools', 'pushEvents'].filter((c) => allowed.some((a) => matches(a, c)) && !denied.some((d) => matches(d, c))));
    this.policyReceived = true;
    const all = Object.keys(FEATURE_SETS) as FeatureSet[];
    const fsMatch = (pattern: string, fs: string) => pattern === '*' || pattern === fs || (pattern.endsWith('.*') && fs.startsWith(pattern.slice(0, -1)));
    this.enabled = new Set(all.filter((fs) => (!p.enabled || p.enabled.some((e: string) => fsMatch(e, fs))) && !(p.disabled ?? []).some((d: string) => fsMatch(d, fs))));
    const unavailable = all.flatMap((fs) => {
      const missing = FEATURE_SETS[fs].uses.filter((u) => !this.granted.has(u));
      return missing.length && this.enabled.has(fs) ? [{ featureSet: fs, missingCapabilities: missing, effect: fs === 'docs.watch' && this.granted.has('tools') ? 'degraded' : 'disabled' }] : [];
    });
    if (!this.pushReady() && this.wasPushReady) this.wasPushReady = false;
    this.log(`${this.actor.name}: policy grant=[${[...this.granted].join(',')}] enabled=[${[...this.enabled].join(',')}] coalescing=${JSON.stringify(this.hostCoalescing)}`);
    return { accepted: true, ...(unavailable.length ? { mode: 'degraded' } : {}), unavailableFeatures: unavailable, notes: [] };
  }

  /** featureSets/update as a Notification: may disable feature sets, nothing else. */
  private narrow(p: any) {
    if (!Array.isArray(p?.disabled)) return;
    const all = Object.keys(FEATURE_SETS) as FeatureSet[];
    const fsMatch = (pattern: unknown, fs: string) => typeof pattern === 'string' && (pattern === '*' || pattern === fs || (pattern.endsWith('.*') && fs.startsWith(pattern.slice(0, -1))));
    for (const fs of all) if (p.disabled.some((d: unknown) => fsMatch(d, fs))) this.enabled.delete(fs);
    if (!this.pushReady()) this.wasPushReady = false;
  }

  /** Re-check standing after an admin change; false = this connection must end. */
  stillAllowed(): boolean {
    return !!this.app.principals.standing(this.actor.sub, this.actor.scopes, this.actor.issuer);
  }

  private maybeReady() {
    if (this.pushReady() && !this.wasPushReady) {
      this.wasPushReady = true;
      void this.app.attention.ready(this).catch((e) => this.log(`catch-up failed: ${(e as Error).message}`));
    }
  }

  private instructions(): string {
    return [
      `Anima Docs — live collaborative markdown documents shared by people and agents (${this.app.config.origin}). You are ${this.actor.name} (${this.actor.sub}).`,
      this.connectionGuide(),
    ].join('\n\n');
  }

  /**
   * How this agent will hear from the service, tailored to what its host
   * declared at initialize: shown in the instructions and appended to whoami
   * (hosts don't all surface instructions; every agent can call whoami).
   */
  connectionGuide(): string {
    const c = this.hostCoalescing;
    const coalescing = !this.mcpl
      ? 'Your host connected as plain MCP: tools only, no push events. Use changes {document} to see what others changed since you last looked.'
      : c.deferred
        ? 'Your host supports MCPL event coalescing with deferred rendering (RFC-006): each watched document holds one pending slot, and its diff is written when you are about to read it, so a burst of typing costs you one diff.'
        : c.plain
          ? 'Your host supports plain event coalescing but not deferred rendering: diffs arrive ready-made and are appended as they happen. A host with deferred coalescing (agent-framework with RFC-006) keeps one current diff per document instead.'
          : 'Your host does not advertise MCPL event coalescing, so every diff arrives as its own event and accumulates in your context. Ask your operator for an agent-framework with RFC-006 event coalescing before watching busy documents.';
    return [
      'What reaches you (feature set docs.watch):',
      '- Addressed to you: an @mention, a thread assigned to you, or a reply in a thread you started or joined. One event per comment: an edit replaces it, a deletion withdraws it. These come without watching anything; offline, they wait for you.',
      '- Suggestions (docs:suggestion): when someone suggests edits on a document you own, one event per burst (after they pause) lists the changes; you accept_suggestion or reject_suggestion. When your own suggestions are decided, you hear that too. To change a document that isn\'t yours, use suggest_edit: the owner reviews it.',
      '- Documents you watch: edits arrive as one diff per document of what others changed since you last looked (never your own edits), with authors and section names. Comment activity arrives as a digest. A full read_document counts as looking.',
      '- Documents shared with you: a short notice.',
      'Every event carries docs:wake or docs:quiet according to the gates you set with watch (per document, or document "*" for defaults): edits / comments / replies / shares: wake | quiet | off; mentions: wake | quiet; from: anyone | humans | agents | names; guests; min_chars; sections; keywords; settle_seconds; cooldown_seconds; quiet_until. A first watch without options means edits quiet, comments wake, from humans.',
      'Wake rules: your host gate decides what those tags do, and docs events are usually skipped until it has rules for them. Add two rules once, using the id you deployed this server under as source (here assumed "docs"):',
      '  wake_add_rule {"name": "docs-quiet", "match": {"source": "docs"}, "behavior": "defer", "position": "prepend"}',
      '  wake_add_rule {"name": "docs-wake", "match": {"source": "docs", "tagsAny": ["docs:wake"]}, "behavior": "always", "position": "prepend"}',
      '  (The second prepend puts docs-wake first; both match only this server, so your other rules are untouched.)',
      `Coalescing: ${coalescing}`,
      'Answering: reply to comments with reply_comment (or add_comment); plain prose after a docs wake has nowhere to go. Anchor edits and comments on exact text, not line numbers. A share link someone gives you works anywhere a document is expected.',
    ].join('\n');
  }
}

export function attachMcpl(server: Server, app: App, log: (m: string) => void = (m) => console.log(`[mcpl] ${m}`)) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024 });
  const open = new Map<WebSocket, McplSession>();
  // Blocking applies to live connections at once.
  app.principals.on('role', (e: { sub: string }) => {
    for (const [ws, s] of open) if (s.sub === e.sub && !s.stillAllowed()) ws.close(4003, 'Blocked');
  });
  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://docs'); } catch { return; } // the catch-all handler closes it
    if (url.pathname !== '/mcpl') return; // other upgrade handlers (web /ws) take theirs
    let actor: Actor;
    try {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? url.searchParams.get('token') ?? '';
      const who = app.verify(token);
      actor = app.principals.admit(who, 'mcpl');
    } catch (e) {
      const status = e instanceof Fault ? e.status : 401;
      if (e instanceof Fault && e.code) log(`refused connection: ${JSON.stringify(e.code.slice(0, 160))}`);
      try { socket.write(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Unauthorized'}\r\nConnection: close\r\n\r\n`); } catch { /* ignore */ }
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const session = new McplSession(app, ws, actor, log);
      open.set(ws, session);
      app.attention.register(session);
      log(`${actor.name} (${actor.sub}) connected`);
      const expiry = setTimeout(() => ws.close(4001, 'Identity expired; reconnect with a fresh token.'), Math.min(2 ** 31 - 1, Math.max(1, actor.exp * 1000 - Date.now())));
      ws.on('message', (data) => { session.handle(data.toString()).catch((e) => log(`message failed: ${(e as Error).message}`)); });
      ws.on('close', () => { clearTimeout(expiry); open.delete(ws); session.close(); log(`${actor.name} disconnected`); });
      ws.on('error', () => { /* close follows */ });
    });
  });
  return wss;
}
