// Image storage: content-addressed files under <data>/media, metadata in SQLite.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import type { DB } from './db.js';
import { Fault } from './auth.js';

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export interface MediaInfo { id: string; mime: string; size: number; width: number | null; height: number | null; url: string }

const TYPES: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: 'image/png', ext: 'png', test: (b) => b.length > 24 && b.readUInt32BE(0) === 0x89504e47 },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', ext: 'gif', test: (b) => b.length > 10 && b.toString('ascii', 0, 4) === 'GIF8' },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
];

export function sniff(b: Buffer) {
  return TYPES.find((t) => t.test(b)) ?? null;
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

  put(bytes: Buffer, uploader: string, docId: string | null): MediaInfo {
    if (bytes.length === 0) throw new Fault(400, 'Empty image.');
    if (bytes.length > MAX_IMAGE_BYTES) throw new Fault(413, `Image too large (max ${MAX_IMAGE_BYTES / 1024 / 1024} MB).`);
    const type = sniff(bytes);
    if (!type) throw new Fault(415, 'Only PNG, JPEG, GIF and WebP images are accepted.');
    const id = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${type.ext}`;
    const file = join(this.dir, id);
    if (!existsSync(file)) writeFileSync(file, bytes);
    const dim = dimensions(bytes, type.mime);
    this.db.prepare(`INSERT OR IGNORE INTO media (id, mime, size, width, height, uploader_sub, doc_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, type.mime, bytes.length, dim?.width ?? null, dim?.height ?? null, uploader, docId, Date.now());
    return this.info(id)!;
  }

  info(id: string): MediaInfo | null {
    const r = this.db.prepare('SELECT * FROM media WHERE id = ?').get(id) as any;
    return r ? { id: r.id, mime: r.mime, size: r.size, width: r.width, height: r.height, url: `/media/${r.id}` } : null;
  }

  read(id: string): { info: MediaInfo; bytes: Buffer } | null {
    if (!/^[0-9a-f]{32}\.(png|jpg|gif|webp)$/.test(id)) return null;
    const info = this.info(id);
    if (!info) return null;
    return { info, bytes: readFileSync(join(this.dir, id)) };
  }

  /** Media id from a URL or path referring to this service ("/media/<id>", "https://host/media/<id>", or a bare id). */
  static idFrom(ref: string): string | null {
    const s = String(ref ?? '').trim();
    if (!s || s.length > 2048) return null;
    const ID = /^[0-9a-f]{32}\.(?:png|jpg|gif|webp)$/;
    if (ID.test(s)) return s;
    let path: string;
    try { path = new URL(s, 'http://x').pathname; } catch { return null; }
    const m = /^\/media\/([0-9a-f]{32}\.(?:png|jpg|gif|webp))$/.exec(path);
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
