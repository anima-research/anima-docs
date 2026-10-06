// Spin up a full server on a random port with a test issuer, plus raw clients.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { testIssuer } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { createApp, type App } from '../src/app.js';
import { createHttp } from '../src/http.js';
import { publicKeyFromString, type PrincipalKind } from '../src/auth.js';

export async function startServer(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adocs-srv-'));
  const iss = testIssuer('test.local');
  const logs: string[] = [];
  const config = loadConfig({ DOCS_DATA_DIR: dir, PORT: '0', DOCS_ORIGIN: 'http://127.0.0.1:1', DOCS_ISSUERS: `test.local=${iss.publicKey}`, ...env } as any);
  const app = createApp(config, new Map([['test.local', publicKeyFromString(iss.publicKey)]]), { commentSettleMs: 30, attentionLog: (m) => logs.push(m) });
  const http = createHttp(app);
  await new Promise<void>((r) => http.server.listen(0, '127.0.0.1', () => r()));
  const port = (http.server.address() as AddressInfo).port;
  // The origin check needs the real port.
  (app.config as any).origin = `http://127.0.0.1:${port}`;
  const base = `http://127.0.0.1:${port}`;
  return {
    app, http, port, base, iss, logs, dir,
    token: (name: string, kind: PrincipalKind = 'agent', extra: { scopes?: string[]; ttl?: number } = {}) => iss.mint(name, kind, 'docs', extra),
    async close() {
      http.mcpl.clients.forEach((c) => c.terminate());
      http.realtime.close();
      await new Promise((r) => http.server.close(() => r(undefined)));
      app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A minimal hand-rolled MCPL host for protocol tests. */
export async function rawHost(url: string, opts: { mcpl?: Record<string, unknown> | null; grant?: string[]; enabled?: string[]; render?: boolean } = {}) {
  const ws = new WebSocket(url);
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); ws.once('unexpected-response', (_q, r) => rej(new Error(`HTTP ${r.statusCode}`))); });
  let next = 1;
  const waiting = new Map<number, (m: any) => void>();
  const pushes: any[] = [];
  const renders: any[] = [];
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'push/event') { pushes.push(m.params); ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { accepted: true, ...(m.params.coalesce ? { coalesce: { outcome: 'first' } } : {}) } })); return; }
    if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id); }
  });
  const call = (method: string, params: unknown = {}) => new Promise<any>((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
  const mcpl = opts.mcpl === null ? undefined : (opts.mcpl ?? { version: '0.5', pushEvents: true, eventCoalescing: { pushEvents: true, deferred: true, channelScopedPush: true } });
  const init = await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'raw', version: '0' }, capabilities: mcpl ? { experimental: { mcpl } } : {} });
  ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  let policy: any = null;
  if (mcpl) policy = await call('featureSets/update', { effectiveCapabilities: opts.grant ?? ['tools', 'pushEvents'], ...(opts.enabled ? { enabled: opts.enabled } : {}) });
  return {
    ws, init, policy, pushes, renders, closed,
    call,
    tool: async (name: string, args: Record<string, unknown> = {}) => {
      const r = await call('tools/call', { name, arguments: args });
      if (r.error) throw new Error(`${r.error.code} ${r.error.message}`);
      return { text: r.result.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n'), isError: !!r.result.isError, raw: r.result };
    },
    render: async (key: string) => {
      const r = await call('push/render', { featureSet: 'docs.watch', key, eventId: 'x', notices: [], dropped: 0 });
      return r.result?.content?.map((c: any) => c.text).join('\n') ?? '';
    },
    close: () => ws.close(),
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(pred: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(15); }
}

/** A browser stand-in: Y.Doc + awareness over /ws. */
export async function browserClient(S: { base: string; port: number }, cookie: string, docId: string, origin = S.base) {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const ws = new WebSocket(`ws://127.0.0.1:${S.port}/ws?doc=${docId}`, { headers: { Cookie: cookie, Origin: origin } });
  const json: any[] = [];
  let synced = false;
  const opened = new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('unexpected-response', (_q, r) => rej(new Error(`HTTP ${r.statusCode}`))); ws.once('error', rej); });
  ws.on('message', (data, isBinary) => {
    if (!isBinary) { json.push(JSON.parse(data.toString())); return; }
    const dec = decoding.createDecoder(new Uint8Array(data as Buffer));
    const type = decoding.readVarUint(dec);
    if (type === 0) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      const kind = syncProtocol.readSyncMessage(dec, enc, doc, 'server');
      if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
      if (kind === 0) { // got step 1: also send ours so the server sends step 2
        const e2 = encoding.createEncoder(); encoding.writeVarUint(e2, 0); syncProtocol.writeSyncStep1(e2, doc); ws.send(encoding.toUint8Array(e2));
      }
      if (kind === 1) synced = true;
    } else if (type === 1) awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), 'server');
  });
  doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin === 'server' || ws.readyState !== ws.OPEN) return;
    const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0); syncProtocol.writeUpdate(enc, u); ws.send(encoding.toUint8Array(enc));
  });
  awareness.on('update', ({ added, updated, removed }: any, origin: unknown) => {
    if (origin === 'server' || ws.readyState !== ws.OPEN) return;
    const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 1);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]));
    ws.send(encoding.toUint8Array(enc));
  });
  try { await opened; } catch (e) { awareness.destroy(); throw e; }
  await until(() => synced, 'initial sync');
  let req = 0;
  const ask = (m: Record<string, unknown>) => new Promise<any>((resolve) => {
    const id = ++req;
    const start = json.length;
    ws.send(JSON.stringify({ ...m, reqId: id }));
    const t = setInterval(() => { const a = json.slice(start).find((x) => x.type === 'ack' && x.reqId === id); if (a) { clearInterval(t); resolve(a); } }, 5);
  });
  return { doc, text: () => doc.getText("body").toString(), awareness, ws, json, ask, close: () => { awareness.destroy(); ws.close(); } };
}

