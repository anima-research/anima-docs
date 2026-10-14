// Files attached to a document (an HTML page's data, scripts, styles, images;
// a markdown companion): stored through Media (content-addressed), named by a
// path under the document, served next to the page at /p/<id>/<path>.
//
// Pages run in a sandbox with an opaque origin, so a page cannot send the
// viewer's session for its own files. A page is therefore served under a
// signed path, /p/<id>/t/<token>/, and relative URLs inside it stay within that
// capability; the token is an HMAC of the document id and an expiry, minted
// after the usual access check, and the key lives in the data directory.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.js';
import { Fault } from './auth.js';
import type { Media, MediaInfo } from './media.js';

export interface DocFile { path: string; mime: string; size: number; mediaId: string; updatedAt: number; updatedBy: string }

export const PATH_RE = /^(?!\.)[A-Za-z0-9._-]+(?:\/(?!\.)[A-Za-z0-9._-]+)*$/;
export const MAX_FILES_PER_DOC = 500;
/** The markdown companion of an HTML page, by convention. */
export const COMPANION = 'index.md';

const MIME_BY_EXT: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', wasm: 'application/wasm', pdf: 'application/pdf', map: 'application/json; charset=utf-8',
};
export function mimeFor(path: string, sniffed: string | null): string {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(path)?.[1]?.toLowerCase();
  return (ext && MIME_BY_EXT[ext]) || (sniffed && sniffed !== 'application/octet-stream' ? sniffed : 'application/octet-stream');
}
export const isTextMime = (mime: string) => /^(text\/|application\/(json|xml|javascript|x-javascript))/.test(mime);

export function checkPath(path: string): string {
  const p = String(path ?? '').replace(/^\/+/, '');
  if (!p || p.length > 200 || !PATH_RE.test(p)) throw new Fault(400, 'File paths are like "data/sim.json": letters, digits, ".", "_", "-" and "/" between parts; no leading dots.');
  return p;
}

export class DocFiles {
  constructor(private db: DB, private media: Media) {}

  list(docId: string): DocFile[] {
    return (this.db.prepare('SELECT * FROM doc_files WHERE doc_id = ? ORDER BY path').all(docId) as any[]).map(rowToFile);
  }
  get(docId: string, path: string): DocFile | null {
    const r = this.db.prepare('SELECT * FROM doc_files WHERE doc_id = ? AND path = ?').get(docId, path) as any;
    return r ? rowToFile(r) : null;
  }
  /** The bytes of an attached file (null when it is gone). */
  read(docId: string, path: string): { file: DocFile; bytes: Buffer } | null {
    const f = this.get(docId, path);
    if (!f) return null;
    const m = this.media.read(f.mediaId);
    return m ? { file: f, bytes: m.bytes } : null;
  }
  text(docId: string, path: string): string | null {
    const r = this.read(docId, path);
    return r ? r.bytes.toString('utf8') : null;
  }

  /** Add or replace a file. The caller has checked edit access. */
  put(docId: string, path: string, bytes: Buffer, by: string, opts: { maxBytes: number }): DocFile {
    const p = checkPath(path);
    if (bytes.length === 0) throw new Fault(400, 'Empty file.');
    if (bytes.length > opts.maxBytes) throw new Fault(413, `File too large (max ${Math.round(opts.maxBytes / 1024 / 1024)} MB).`);
    const n = (this.db.prepare('SELECT count(*) AS n FROM doc_files WHERE doc_id = ?').get(docId) as { n: number }).n;
    if (n >= MAX_FILES_PER_DOC && !this.get(docId, p)) throw new Fault(400, `At most ${MAX_FILES_PER_DOC} files per document.`);
    const info: MediaInfo = this.media.put(bytes, by, docId, { name: p.split('/').pop()!, imagesOnly: false, maxBytes: opts.maxBytes });
    const mime = mimeFor(p, info.mime);
    this.db.prepare(`INSERT INTO doc_files (doc_id, path, media_id, mime, size, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc_id, path) DO UPDATE SET media_id = excluded.media_id, mime = excluded.mime, size = excluded.size, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(docId, p, info.id, mime, bytes.length, Date.now(), by);
    return this.get(docId, p)!;
  }

  remove(docId: string, path: string): boolean {
    return this.db.prepare('DELETE FROM doc_files WHERE doc_id = ? AND path = ?').run(docId, checkPath(path)).changes > 0;
  }
}

function rowToFile(r: any): DocFile {
  return { path: r.path, mime: r.mime, size: r.size, mediaId: r.media_id, updatedAt: r.updated_at, updatedBy: r.updated_by };
}

// ------------------------------------------------------------------ page tokens

export class PageKeys {
  private key: Buffer;
  constructor(dataDir: string | null) {
    if (!dataDir) { this.key = randomBytes(32); return; }
    mkdirSync(dataDir, { recursive: true });
    const file = join(dataDir, 'page-key');
    if (!existsSync(file)) writeFileSync(file, randomBytes(32), { mode: 0o600 });
    this.key = readFileSync(file);
  }
  /** A capability to read a page and its files until `ttlMs` from now. */
  mint(docId: string, ttlMs = 7 * 86400_000): string {
    const exp = Math.floor((Date.now() + ttlMs) / 1000);
    return `${exp.toString(36)}.${this.sig(docId, exp)}`;
  }
  verify(docId: string, token: string): boolean {
    const m = /^([0-9a-z]+)\.([A-Za-z0-9_-]{22})$/.exec(token ?? '');
    if (!m) return false;
    const exp = parseInt(m[1], 36);
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
    const want = Buffer.from(this.sig(docId, exp)), got = Buffer.from(m[2]);
    return want.length === got.length && timingSafeEqual(want, got);
  }
  private sig(docId: string, exp: number): string {
    return createHmac('sha256', this.key).update(`${docId}|${exp}`).digest('base64url').slice(0, 22);
  }
}

// ------------------------------------------------------------------ slices of data for agents

/** RFC 6901 JSON pointer ("/arms/0/name"); "" is the whole document. */
export function jsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === undefined) return value;
  if (!pointer.startsWith('/')) throw new Fault(400, 'A JSON pointer starts with "/" (e.g. "/arms/0/name").');
  let cur: any = value;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object') throw new Fault(404, `Nothing at ${pointer}.`);
    if (Array.isArray(cur)) { const i = Number(key); if (!Number.isInteger(i) || i < 0 || i >= cur.length) throw new Fault(404, `Nothing at ${pointer}.`); cur = cur[i]; }
    else { if (!(key in cur)) throw new Fault(404, `Nothing at ${pointer} (keys here: ${Object.keys(cur).slice(0, 30).join(', ')}).`); cur = cur[key]; }
  }
  return cur;
}
