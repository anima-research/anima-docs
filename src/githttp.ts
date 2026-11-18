// A collection's repository over HTTP: git's smart protocol (clone, fetch,
// push) and the Git LFS API beside it, at /git/<id>.git.
//
// A git client signs in with HTTP Basic: any user name, and as the password
// either an agent's Archipelago token or a person's git password (made in the
// collection's Clone dialog; gitrepo.ts keeps it hashed). Reading needs the
// viewer role on the collection, pushing the editor role.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { Fault } from './auth.js';
import type { App } from './app.js';
import { atLeast, type Role } from './documents.js';
import { COLLECTION } from './files.js';
import type { Actor } from './principals.js';

const pkt = (s: string) => (Buffer.byteLength(s) + 4).toString(16).padStart(4, '0') + s;
const LFS_JSON = 'application/vnd.git-lfs+json';

async function readJson(req: IncomingMessage, limit: number): Promise<any> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > limit) throw new Fault(413, 'Request too large.'); chunks.push(c as Buffer); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new Fault(400, 'Invalid JSON.'); }
}

/** Run a git process between the request and the response. */
function pipe(child: ChildProcessWithoutNullStreams, input: NodeJS.ReadableStream | null, res: ServerResponse, end: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.on('error', () => undefined);
    if (input) { input.on('error', () => child.kill()); input.pipe(child.stdin); } else child.stdin.end();
    child.stdout.pipe(res, { end });
    res.on('close', () => { if (child.exitCode === null) child.kill(); });
    child.on('error', reject);
    child.on('close', (code) => { if (code && err.trim()) console.error('[git]', err.trim().split('\n').slice(-3).join(' | ')); resolve(); });
  });
}

export function gitHttp(app: App, deps: {
  streamFile(req: IncomingMessage, res: ServerResponse, file: string, size: number, headers: Record<string, string | number>): void;
  /** Where a push's hook reaches this process. */
  hookUrl(key: string): string;
}) {
  const actorOf = (req: IncomingMessage): Actor | null => {
    const h = String(req.headers.authorization ?? '');
    const basic = /^Basic\s+(.+)$/i.exec(h), bearer = /^Bearer\s+(.+)$/i.exec(h);
    const plain = basic ? Buffer.from(basic[1], 'base64').toString('utf8') : '';
    const secret = basic ? plain.slice(plain.indexOf(':') + 1) : bearer ? bearer[1] : '';
    if (!secret) return null;
    try {
      if (secret.startsWith('adg_')) { const who = app.git.identityOf(secret); return who ? app.principals.admit(who, 'http') : null; }
      return app.principals.admit(app.verify(secret), 'http');
    } catch { return null; }
  };

  /** True when the request was one of git's and has been answered. */
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const method = req.method ?? 'GET';
    const hook = /^\/git-hook\/([0-9a-f]{48})$/.exec(url.pathname);
    if (hook && method === 'POST') {
      const verdict = await app.git.preReceive(hook[1], await readJson(req, 4 * 1024 * 1024)).catch((e) => { console.error('[git] push check failed', e); return { ok: false, message: 'The push could not be checked.' }; });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(verdict));
      return true;
    }
    const m = /^\/git\/([A-Za-z0-9]+)\.git\/(.+)$/.exec(url.pathname);
    if (!m) return false;
    const [, id, rest] = m;
    const lfs = rest.startsWith('info/lfs/');
    if (!app.git.available) throw new Fault(404, 'Not found.');
    const actor = actorOf(req);
    if (!actor) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Anima Docs"', ...(lfs ? { 'LFS-Authenticate': 'Basic realm="Anima Docs"', 'Content-Type': LFS_JSON } : { 'Content-Type': 'text/plain; charset=utf-8' }) });
      res.end(lfs ? JSON.stringify({ message: 'Credentials needed.' }) : 'Sign in with any user name and, as the password, a git password from the collection’s “Clone with git” dialog (agents: your Archipelago token).\n');
      return true;
    }
    const doc = app.docs.get(id);
    const role = doc && doc.type === COLLECTION ? app.docs.role(id, actor) : null;
    if (!doc || !role) throw new Fault(404, 'No such repository.');
    const need = (r: Role) => { if (!atLeast(role, r)) throw new Fault(403, 'You can read this collection, not change it.'); };
    // A push is refused outright when its check cannot run, rather than received and undone.
    const canReceive = () => { if (!app.git.canReceive) { console.error('[git] pushes are refused: the pre-receive hook is not executable'); throw new Fault(503, 'This server cannot take pushes at the moment.'); } };

    try {
      // ------------------------------------------------ git: refs, then one of the two services
      if (rest === 'info/refs' && method === 'GET') {
        const service = url.searchParams.get('service');
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') throw new Fault(403, 'This address is for git clients.');
        const receive = service === 'git-receive-pack';
        if (receive) { need('editor'); canReceive(); }
        await app.git.flush(id);
        const proto = String(req.headers['git-protocol'] ?? '');
        res.writeHead(200, { 'Content-Type': `application/x-${service}-advertisement`, 'Cache-Control': 'no-cache' });
        // Protocol v2 (fetches only) answers with its capabilities and no preamble.
        if (receive || !/version=2/.test(proto)) res.write(`${pkt(`# service=${service}\n`)}0000`);
        await pipe(app.git.serve(id, [...(receive ? app.git.receiveConfig : []), service.slice(4), '--stateless-rpc', '--advertise-refs'], proto ? { GIT_PROTOCOL: proto } : {}), null, res, true);
        return true;
      }
      if ((rest === 'git-upload-pack' || rest === 'git-receive-pack') && method === 'POST') {
        if (rest === 'git-receive-pack') { need('editor'); canReceive(); }
        const body = req.headers['content-encoding'] === 'gzip' ? req.pipe(createGunzip()) : req;
        const proto = String(req.headers['git-protocol'] ?? '');
        res.writeHead(200, { 'Content-Type': `application/x-${rest}-result`, 'Cache-Control': 'no-cache' });
        if (rest === 'git-upload-pack') {
          await app.git.flush(id);
          await pipe(app.git.serve(id, ['upload-pack', '--stateless-rpc'], proto ? { GIT_PROTOCOL: proto } : {}), body, res, true);
          return true;
        }
        // The answer ends once the push has become the collection's files: whoever pushed and then looks, sees them.
        await app.git.push(id, actor.sub, (key) => pipe(app.git.serve(id, [...app.git.receiveConfig, 'receive-pack', '--stateless-rpc'], { DOCS_GIT_HOOK: deps.hookUrl(key) }), body, res, false));
        res.end();
        return true;
      }

      // ------------------------------------------------ Git LFS: the batch API, and objects by their SHA-256
      if (rest === 'info/lfs/objects/batch' && method === 'POST') {
        const b = await readJson(req, 8 * 1024 * 1024);
        const upload = b.operation === 'upload';
        if (!upload && b.operation !== 'download') throw new Fault(422, 'operation is upload or download.');
        if (upload) need('editor');
        const header = { Authorization: String(req.headers.authorization) };
        const href = (oid: string) => `${app.config.origin}/git/${id}.git/info/lfs/objects/${oid}`;
        const objects = (Array.isArray(b.objects) ? b.objects : []).map((o: { oid?: unknown; size?: unknown }) => {
          const oid = String(o.oid ?? ''), size = Number(o.size) || 0;
          if (!/^[0-9a-f]{64}$/.test(oid)) return { oid, size, error: { code: 422, message: 'Not a SHA-256 object name.' } };
          const have = app.git.lfsObject(id, oid);
          if (!upload) return have ? { oid, size: have.size, authenticated: true, actions: { download: { href: href(oid), header, expires_in: 3600 } } } : { oid, size, error: { code: 404, message: 'This object is not here.' } };
          if (have) return { oid, size };
          if (size > app.config.uploadMaxBytes) return { oid, size, error: { code: 422, message: `A file may be up to ${Math.round(app.config.uploadMaxBytes / 1024 / 1024)} MB.` } };
          return { oid, size, authenticated: true, actions: { upload: { href: href(oid), header, expires_in: 3600 } } };
        });
        res.writeHead(200, { 'Content-Type': LFS_JSON, 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ transfer: 'basic', objects, hash_algo: 'sha256' }));
        return true;
      }
      const obj = /^info\/lfs\/objects\/([0-9a-f]{64})$/.exec(rest);
      if (obj && method === 'PUT') {
        need('editor');
        await app.git.lfsPut(id, obj[1], req, actor.sub);
        res.writeHead(200, { 'Content-Type': LFS_JSON });
        res.end('{}');
        return true;
      }
      if (obj && (method === 'GET' || method === 'HEAD')) {
        const have = app.git.lfsObject(id, obj[1]);
        const at = have ? app.media.locate(have.mediaId) : null;
        if (!at) throw new Fault(404, 'This object is not here.');
        deps.streamFile(req, res, at.file, at.size, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store' });
        return true;
      }
      throw new Fault(404, 'Not found.');
    } catch (e) {
      // Past the first byte there is no status left to change: end the answer, the client reports the cut.
      if (!res.headersSent) throw e;
      console.error('[git]', req.method, url.pathname, (e as Error).message);
      res.end();
      return true;
    }
  };
}
