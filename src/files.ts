// Files attached to a document (an HTML page's data, scripts, styles, images;
// a markdown companion): stored through Media (content-addressed), named by a
// path under the document, served next to the page at /p/<id>/<path>.
//
// A document of type 'files' is a file collection: its files are its content.
// A collection takes the names people's files really have (spaces, any script,
// dotfiles), holds many more of them, and has folders, which exist as the
// prefixes of its paths.
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
export const MAX_FILES_PER_COLLECTION = 20_000;
/** The type of a document whose content is its files. */
export const COLLECTION = 'files';
/** The markdown companion of an HTML page, by convention. */
export const COMPANION = 'index.md';

const MIME_BY_EXT: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', wasm: 'application/wasm', pdf: 'application/pdf', map: 'application/json; charset=utf-8',
  avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp', mov: 'video/quicktime', mkv: 'video/x-matroska', flac: 'audio/flac',
  tsv: 'text/tab-separated-values; charset=utf-8', yaml: 'text/yaml; charset=utf-8', yml: 'text/yaml; charset=utf-8', toml: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8', tex: 'text/x-tex; charset=utf-8', bib: 'text/plain; charset=utf-8',
  py: 'text/x-python; charset=utf-8', ts: 'text/plain; charset=utf-8', tsx: 'text/plain; charset=utf-8', jsx: 'text/plain; charset=utf-8', sh: 'text/x-shellscript; charset=utf-8', sql: 'text/plain; charset=utf-8', go: 'text/plain; charset=utf-8', rs: 'text/plain; charset=utf-8', c: 'text/plain; charset=utf-8', h: 'text/plain; charset=utf-8', cpp: 'text/plain; charset=utf-8', java: 'text/plain; charset=utf-8', rb: 'text/plain; charset=utf-8',
  zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', epub: 'application/epub+zip',
};
/** Files that are text whatever their name says nothing about (a collection's dotfiles and READMEs). */
const TEXT_NAMES = /^(readme|license|licence|notice|changelog|authors|makefile|dockerfile|\.gitignore|\.gitattributes|\.editorconfig|\.env\.example)$/i;
export function mimeFor(path: string, sniffed: string | null): string {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(path)?.[1]?.toLowerCase();
  if (ext && MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  if (sniffed && sniffed !== 'application/octet-stream') return sniffed;
  return TEXT_NAMES.test(path.split('/').pop()!) ? 'text/plain; charset=utf-8' : 'application/octet-stream';
}
export const isTextMime = (mime: string) => /^(text\/|application\/(json|xml|javascript|x-javascript))/.test(mime);

export function checkPath(path: string): string {
  const p = String(path ?? '').replace(/^\/+/, '');
  if (!p || p.length > 200 || !PATH_RE.test(p)) throw new Fault(400, 'File paths are like "data/sim.json": letters, digits, ".", "_", "-" and "/" between parts; no leading dots.');
  return p;
}

/**
 * A path in a collection: the names files have on people's disks. Parts are
 * separated by "/"; a part is anything but ".", "..", ".git", a control
 * character or a backslash, with no space at either end.
 */
export function checkCollectionPath(path: string): string {
  const p = String(path ?? '').normalize('NFC').replace(/^\/+|\/+$/g, '');
  const parts = p.split('/');
  const bad = !p || p.length > 1000 || parts.some((s) => !s || s.length > 255 || s === '.' || s === '..' || s.toLowerCase() === '.git' || s !== s.trim() || /[\x00-\x1f\x7f\\]/.test(s));
  if (bad) throw new Fault(400, 'File paths are like "papers/2024/Annual report.pdf": names separated by "/", none of them ".", ".." or ".git", no backslashes.');
  return p;
}
/**
 * Everything under a folder, as a range of paths: from "dir/" up to "dir0" ("0" is the character after "/").
 * Not LIKE: it ignores the case of ASCII letters, and Photos/ and photos/ are two folders.
 */
const UNDER = 'path >= ? AND path < ?';
const under = (dir: string): [string, string] => [`${dir}/`, `${dir}0`];

export class DocFiles {
  /** Told when a collection's files change, and by whom (its repository commits them: gitrepo.ts). */
  onChange: ((docId: string, by: string) => void) | null = null;
  /** Told when files of a collection got new paths (what points at a file by its path follows: signature fields). */
  onMoved: ((docId: string, moves: [from: string, to: string][]) => void) | null = null;
  constructor(private db: DB, private media: Media) {}

  isCollection(docId: string): boolean {
    return (this.db.prepare('SELECT type FROM documents WHERE id = ?').get(docId) as { type: string } | undefined)?.type === COLLECTION;
  }
  /** The path as this document stores it (a collection's rules are wider than a page's). */
  path(docId: string, path: string): string {
    return this.isCollection(docId) ? checkCollectionPath(path) : checkPath(path);
  }

  /** Every file, or those under a folder. */
  list(docId: string, dir?: string): DocFile[] {
    if (dir) return (this.db.prepare(`SELECT * FROM doc_files WHERE doc_id = ? AND ${UNDER} ORDER BY path`).all(docId, ...under(dir)) as any[]).map(rowToFile);
    return (this.db.prepare('SELECT * FROM doc_files WHERE doc_id = ? ORDER BY path').all(docId) as any[]).map(rowToFile);
  }
  count(docId: string): { files: number; bytes: number } {
    return this.db.prepare('SELECT count(*) AS files, coalesce(sum(size), 0) AS bytes FROM doc_files WHERE doc_id = ?').get(docId) as { files: number; bytes: number };
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
    const collection = this.isCollection(docId);
    const p = this.room(docId, path, collection);
    if (bytes.length === 0 && !collection) throw new Fault(400, 'Empty file.');
    if (bytes.length > opts.maxBytes) throw new Fault(413, `File too large (max ${Math.round(opts.maxBytes / 1024 / 1024)} MB).`);
    const info: MediaInfo = this.media.put(bytes, by, docId, { name: p.split('/').pop()!, imagesOnly: false, maxBytes: opts.maxBytes, asFile: collection });
    return this.record(docId, p, info, by, collection);
  }

  /** The same from a stream: the bytes go to disk as they arrive. */
  async putStream(docId: string, path: string, body: AsyncIterable<Uint8Array>, by: string, opts: { maxBytes: number; /** The stored version (media id) this save replaces; another by then is a conflict. */ expect?: string }): Promise<DocFile> {
    const collection = this.isCollection(docId);
    const p = this.room(docId, path, collection);
    const info = await this.media.putStream(body, by, docId, { name: p.split('/').pop()!, maxBytes: opts.maxBytes, asFile: collection });
    // While it streamed, another upload may have made this name a folder, or a folder above it a file;
    // or someone else saved this file first (nothing awaits between this check and the write).
    if (collection) this.checkFree(docId, p);
    if (opts.expect !== undefined && (this.get(docId, p)?.mediaId ?? '') !== opts.expect) throw new Fault(412, 'This file has changed since you opened it.');
    return this.record(docId, p, info, by, collection);
  }

  /** The checked path, once there is room for one more file under it. */
  private room(docId: string, path: string, collection: boolean): string {
    const p = collection ? checkCollectionPath(path) : checkPath(path);
    const max = collection ? MAX_FILES_PER_COLLECTION : MAX_FILES_PER_DOC;
    // (.gitattributes is the repository's own: a collection filled to the limit still gets one.)
    if (this.count(docId).files >= max && !this.get(docId, p) && !(collection && p === '.gitattributes')) throw new Fault(400, `At most ${max} files per ${collection ? 'collection' : 'document'}.`);
    if (collection) this.checkFree(docId, p);
    return p;
  }
  /** A file cannot sit where a folder is, nor a folder where a file is. */
  checkFree(docId: string, p: string) {
    if (this.db.prepare(`SELECT 1 FROM doc_files WHERE doc_id = ? AND ${UNDER} LIMIT 1`).get(docId, ...under(p))) throw new Fault(409, `${p} is a folder.`);
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) if (this.get(docId, parts.slice(0, i).join('/'))) throw new Fault(409, `${parts.slice(0, i).join('/')} is a file, not a folder.`);
  }
  private record(docId: string, p: string, info: MediaInfo, by: string, collection: boolean): DocFile {
    const now = Date.now();
    this.db.prepare(`INSERT INTO doc_files (doc_id, path, media_id, mime, size, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc_id, path) DO UPDATE SET media_id = excluded.media_id, mime = excluded.mime, size = excluded.size, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(docId, p, info.id, mimeFor(p, info.mime), info.size, now, by);
    if (collection) this.touch(docId, by, now);
    return this.get(docId, p)!;
  }
  /** A collection's files are its content: changing them is changing the document. */
  private touch(docId: string, by: string, now = Date.now()) {
    this.db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').run(now, docId);
    this.onChange?.(docId, by);
  }

  remove(docId: string, path: string, by = ''): boolean {
    const gone = this.db.prepare('DELETE FROM doc_files WHERE doc_id = ? AND path = ?').run(docId, this.path(docId, path)).changes > 0;
    if (gone && this.isCollection(docId)) this.touch(docId, by);
    return gone;
  }

  /** Remove a folder of a collection: every file under it. */
  removeFolder(docId: string, dir: string, by = ''): number {
    const n = this.db.prepare(`DELETE FROM doc_files WHERE doc_id = ? AND ${UNDER}`).run(docId, ...under(checkCollectionPath(dir))).changes;
    if (n) this.touch(docId, by);
    return n;
  }

  /** Move or rename a file, or a folder with everything under it. Nothing is overwritten. */
  move(docId: string, from: string, to: string, by: string): number {
    const src = this.path(docId, from), dst = this.path(docId, to);
    if (src === dst) return 0;
    const collection = this.isCollection(docId);
    const file = this.get(docId, src);
    const rows = file ? [file] : collection ? this.list(docId, src) : [];
    if (!rows.length) throw new Fault(404, `No file or folder ${src}.`);
    if (!file && dst.startsWith(`${src}/`)) throw new Fault(400, 'A folder cannot move into itself.');
    const now = Date.now();
    this.db.transaction(() => {
      // Out first, then in: a file may land where another moving file was.
      const del = this.db.prepare('DELETE FROM doc_files WHERE doc_id = ? AND path = ?');
      for (const r of rows) del.run(docId, r.path);
      const ins = this.db.prepare('INSERT INTO doc_files (doc_id, path, media_id, mime, size, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const r of rows) {
        const t = file ? dst : dst + r.path.slice(src.length);
        if (this.get(docId, t)) throw new Fault(409, `${t} already exists.`);
        if (collection) { checkCollectionPath(t); this.checkFree(docId, t); }
        ins.run(docId, t, r.mediaId, mimeFor(t, r.mime), r.size, now, by);
      }
    })();
    if (collection) this.onMoved?.(docId, rows.map((r) => [r.path, file ? dst : dst + r.path.slice(src.length)]));
    if (collection) this.touch(docId, by, now);
    return rows.length;
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
