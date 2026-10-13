// Media storage: content-addressed files under <data>/media (images, audio,
// video, any file), metadata in SQLite. Types are sniffed, never trusted from
// the client; only images, audio, video and PDF are served inline, everything
// else is a download.

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import type { DB } from './db.js';
import { Fault } from './auth.js';

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export interface MediaInfo { id: string; mime: string; size: number; width: number | null; height: number | null; url: string; /** Original file name (uploads since v8). */ name: string | null; /** image | audio | video | file */ kind: MediaKind }
export type MediaKind = 'image' | 'audio' | 'video' | 'file';

export function kindOf(mime: string): MediaKind {
  return mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'file';
}
/** Served with its own Content-Type (inline); other types are downloads. */
export const inlineMime = (mime: string) => kindOf(mime) !== 'file' || mime === 'application/pdf';
const ID_RE = /^[0-9a-f]{32}\.[a-z0-9]{1,8}$/;

const ascii = (b: Buffer, from: number, to: number) => (b.length >= to ? b.toString('ascii', from, to) : '');
const ftyp = (b: Buffer) => (ascii(b, 4, 8) === 'ftyp' ? ascii(b, 8, 12) : null);
const TYPES: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: 'image/png', ext: 'png', test: (b) => b.length > 24 && b.readUInt32BE(0) === 0x89504e47 },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', ext: 'gif', test: (b) => b.length > 10 && ascii(b, 0, 4) === 'GIF8' },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.length > 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP' },
  { mime: 'audio/wav', ext: 'wav', test: (b) => b.length > 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE' },
  { mime: 'audio/mpeg', ext: 'mp3', test: (b) => b.length > 3 && (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe6) === 0xe2)) },
  { mime: 'audio/flac', ext: 'flac', test: (b) => ascii(b, 0, 4) === 'fLaC' },
  { mime: 'audio/ogg', ext: 'ogg', test: (b) => ascii(b, 0, 4) === 'OggS' },
  { mime: 'audio/mp4', ext: 'm4a', test: (b) => ftyp(b) === 'M4A ' },
  { mime: 'video/quicktime', ext: 'mov', test: (b) => ftyp(b) === 'qt  ' },
  { mime: 'video/mp4', ext: 'mp4', test: (b) => ftyp(b) !== null },
  { mime: 'video/webm', ext: 'webm', test: (b) => b.length > 4 && b.readUInt32BE(0) === 0x1a45dfa3 && b.subarray(0, 64).toString('latin1').includes('webm') },
  { mime: 'video/x-matroska', ext: 'mkv', test: (b) => b.length > 4 && b.readUInt32BE(0) === 0x1a45dfa3 },
  { mime: 'application/pdf', ext: 'pdf', test: (b) => ascii(b, 0, 4) === '%PDF' },
  { mime: 'application/zip', ext: 'zip', test: (b) => b.length > 4 && ascii(b, 0, 2) === 'PK' && b[2] === 3 && b[3] === 4 },
];

export function sniff(b: Buffer) {
  return TYPES.find((t) => t.test(b)) ?? null;
}
export const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** A file name safe to store and echo back: no paths, no control characters, bounded. */
export function cleanName(name: string | null | undefined): string | null {
  const n = String(name ?? '').replace(/[\\/]+/g, ' ').replace(/[\x00-\x1f\x7f"]/g, '').trim().slice(0, 200);
  return n || null;
}

export function dimensions(b: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === 'image/png') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (mime === 'image/gif') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (mime === 'image/webp') {
      const chunk = b.toString('ascii', 12, 16);
      if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (chunk === 'VP8L') { const v = b.readUInt32LE(21); return { width: 1 + (v & 0x3fff), height: 1 + ((v >> 14) & 0x3fff) }; }
      if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i < b.length - 9) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        const len = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        i += 2 + len;
      }
    }
  } catch { /* fall through */ }
  return null;
}

export class Media {
  private dir: string;
  constructor(private db: DB, dataDir: string) {
    this.dir = join(dataDir, 'media');
    mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Store an upload. `imagesOnly` is the image paths (toolbar, agents' insert_image): anything
   * else is refused there. Otherwise any file is kept: a sniffed type when known, or a plain
   * download named after the original file.
   */
  put(bytes: Buffer, uploader: string, docId: string | null, opts: { name?: string | null; imagesOnly?: boolean; maxBytes?: number } = {}): MediaInfo {
    if (bytes.length === 0) throw new Fault(400, 'Empty file.');
    const type = sniff(bytes);
    const name = cleanName(opts.name);
    if (opts.imagesOnly !== false) {
      if (!type || !IMAGE_MIMES.has(type.mime)) throw new Fault(415, 'Only PNG, JPEG, GIF and WebP images are accepted.');
      if (bytes.length > MAX_IMAGE_BYTES) throw new Fault(413, `Image too large (max ${MAX_IMAGE_BYTES / 1024 / 1024} MB).`);
    } else {
      const max = type && IMAGE_MIMES.has(type.mime) ? MAX_IMAGE_BYTES : (opts.maxBytes ?? MAX_IMAGE_BYTES);
      if (bytes.length > max) throw new Fault(413, `File too large (max ${Math.round(max / 1024 / 1024)} MB).`);
    }
    const ext = type ? type.ext : (/\.([a-z0-9]{1,8})$/i.exec(name ?? '')?.[1]?.toLowerCase() ?? 'bin');
    const mime = type ? type.mime : 'application/octet-stream';
    const id = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${ext}`;
    const file = join(this.dir, id);
    if (!existsSync(file)) writeFileSync(file, bytes);
    const dim = IMAGE_MIMES.has(mime) ? dimensions(bytes, mime) : null;
    this.db.prepare(`INSERT OR IGNORE INTO media (id, mime, size, width, height, uploader_sub, doc_id, created_at, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, mime, bytes.length, dim?.width ?? null, dim?.height ?? null, uploader, docId, Date.now(), name);
    return this.info(id)!;
  }

  /**
   * Store an upload from a stream without holding it in memory: bytes go to a temporary
   * file while being hashed; the type is sniffed from the head. Over `maxBytes` the
   * upload is dropped and refused.
   */
  async putStream(body: AsyncIterable<Uint8Array>, uploader: string, docId: string | null, opts: { name?: string | null; maxBytes: number }): Promise<MediaInfo> {
    const tmp = join(this.dir, `tmp-${randomBytes(8).toString('hex')}`);
    const out = createWriteStream(tmp, { flags: 'wx' });
    const hash = createHash('sha256');
    const headParts: Buffer[] = [];
    let headLen = 0, size = 0;
    try {
      for await (const chunk of body) {
        const c = Buffer.from(chunk);
        size += c.length;
        if (size > opts.maxBytes) throw new Fault(413, `File too large (max ${Math.round(opts.maxBytes / 1024 / 1024)} MB).`);
        hash.update(c);
        if (headLen < 1024 * 1024) { headParts.push(c); headLen += c.length; }
        if (!out.write(c)) await once(out, 'drain');
      }
      out.end();
      await once(out, 'finish');
    } catch (e) {
      out.destroy();
      rmSync(tmp, { force: true });
      throw e;
    }
    if (size === 0) { rmSync(tmp, { force: true }); throw new Fault(400, 'Empty file.'); }
    const head = Buffer.concat(headParts);
    const type = sniff(head);
    const name = cleanName(opts.name);
    if (type && IMAGE_MIMES.has(type.mime) && size > MAX_IMAGE_BYTES) { rmSync(tmp, { force: true }); throw new Fault(413, `Image too large (max ${MAX_IMAGE_BYTES / 1024 / 1024} MB).`); }
    const ext = type ? type.ext : (/\.([a-z0-9]{1,8})$/i.exec(name ?? '')?.[1]?.toLowerCase() ?? 'bin');
    const mime = type ? type.mime : 'application/octet-stream';
    const id = `${hash.digest('hex').slice(0, 32)}.${ext}`;
    const file = join(this.dir, id);
    if (existsSync(file)) rmSync(tmp, { force: true }); else renameSync(tmp, file);
    const dim = IMAGE_MIMES.has(mime) ? dimensions(head, mime) : null;
    this.db.prepare(`INSERT OR IGNORE INTO media (id, mime, size, width, height, uploader_sub, doc_id, created_at, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, mime, size, dim?.width ?? null, dim?.height ?? null, uploader, docId, Date.now(), name);
    return this.info(id)!;
  }

  info(id: string): MediaInfo | null {
    const r = this.db.prepare('SELECT * FROM media WHERE id = ?').get(id) as any;
    return r ? { id: r.id, mime: r.mime, size: r.size, width: r.width, height: r.height, url: `/media/${r.id}`, name: r.name ?? null, kind: kindOf(r.mime) } : null;
  }

  read(id: string): { info: MediaInfo; bytes: Buffer } | null {
    const f = this.locate(id);
    return f ? { info: f.info, bytes: readFileSync(f.file) } : null;
  }

  /** Where a stored file is (for streaming, with Range requests). */
  locate(id: string): { info: MediaInfo; file: string; size: number } | null {
    if (!ID_RE.test(id)) return null;
    const info = this.info(id);
    if (!info) return null;
    const file = join(this.dir, id);
    if (!existsSync(file)) return null;
    return { info, file, size: statSync(file).size };
  }

  /** Media id from a URL or path referring to this service ("/media/<id>", "https://host/media/<id>", or a bare id). */
  static idFrom(ref: string): string | null {
    const s = String(ref ?? '').trim();
    if (!s || s.length > 2048) return null;
    if (ID_RE.test(s)) return s;
    let path: string;
    try { path = new URL(s, 'http://x').pathname; } catch { return null; }
    const m = /^\/media\/([0-9a-f]{32}\.[a-z0-9]{1,8})$/.exec(path);
    return m ? m[1] : null;
  }
}

// ---------------------------------------------------------------------------
// Fetching an image by URL on an agent's behalf. The server sits on private
// networks, so the destination is checked at connect time (no DNS rebinding):
// only public unicast addresses, https only, bounded size and time.
// ---------------------------------------------------------------------------

function v4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 100 && b >= 64 && b <= 127)
    || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** Expand an IPv6 literal to 8 hextets (handles :: and a trailing dotted IPv4). */
function hextets(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const p = dotted[1].split('.').map(Number);
    s = s.slice(0, -dotted[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [], t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = s.includes('::') ? 8 - h.length - t.length : 0;
  const all = [...h, ...Array(Math.max(0, fill)).fill('0'), ...t].map((x) => parseInt(x || '0', 16));
  return all.length === 8 && all.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? all : null;
}

/** Anything not plainly public unicast is refused, including IPv6 forms that embed an IPv4 address. */
export function privateAddress(ipIn: string): boolean {
  const ip = ipIn.replace(/^\[|\]$/g, '');
  const fam = isIP(ip);
  if (fam === 4) return v4Private(ip);
  if (fam !== 6) return true;
  const h = hextets(ip);
  if (!h) return true;
  if (h.every((x) => x === 0)) return true;                                    // ::
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true;          // ::1
  if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) return true; // v4-mapped/compatible: never fetched via v6
  if (h[0] === 0x64 && h[1] === 0xff9b) return true;                            // NAT64
  if (h[0] === 0x2002) return true;                                            // 6to4
  if (h[0] === 0x2001 && h[1] === 0) return true;                              // Teredo
  if (h[0] === 0x2001 && h[1] === 0xdb8) return true;                          // documentation
  if ((h[0] & 0xfe00) === 0xfc00) return true;                                 // unique local
  if ((h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xffc0) === 0xfec0) return true;   // link-/site-local
  if ((h[0] & 0xff00) === 0xff00) return true;                                 // multicast
  return false;
}

const guardedAgent = new Agent({
  connect: {
    lookup(hostname, options, cb) {
      lookup(hostname, { ...options, all: true }, (err, addrs) => {
        if (err) return cb(err, '', 0);
        const list = (Array.isArray(addrs) ? addrs : [addrs]) as { address: string; family: number }[];
        const ok = list.find((a) => !privateAddress(a.address));
        if (!ok || list.some((a) => privateAddress(a.address))) return cb(new Error('destination is not a public address'), '', 0);
        if ((options as { all?: boolean }).all) (cb as unknown as (e: null, a: typeof list) => void)(null, [ok]);
        else cb(null, ok.address, ok.family);
      });
    },
  },
});

export async function fetchImage(url: string): Promise<Buffer> {
  let u: URL;
  try { u = new URL(url); } catch { throw new Fault(400, 'Not a valid URL.'); }
  if (u.protocol !== 'https:') throw new Fault(400, 'Only https image URLs can be imported.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  // IP literals skip DNS (and so the guarded lookup): check them here.
  if (isIP(host) && privateAddress(host)) throw new Fault(400, 'That address is not reachable from here.');
  const res = await undiciFetch(u, { dispatcher: guardedAgent, redirect: 'error', signal: AbortSignal.timeout(20_000) }).catch(() => {
    throw new Fault(502, 'Could not fetch the image.');
  });
  if (!res.ok) throw new Fault(502, `Image URL returned HTTP ${res.status}.`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_IMAGE_BYTES) throw new Fault(413, 'Image too large.');
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of res.body as AsyncIterable<Uint8Array>) {
    n += c.length;
    if (n > MAX_IMAGE_BYTES) throw new Fault(413, 'Image too large.');
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks);
}
