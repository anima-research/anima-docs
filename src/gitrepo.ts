// Every file collection is also a git repository: its history, and the way to
// copy it out, work on it with ordinary tools and copy it back.
//
// The collection's files (doc_files → media) are what people and agents see;
// the repository's `main` is the same tree, kept in step in both directions:
//
//   - a change made in the browser or by a tool becomes a commit, a few
//     seconds after the last change (so an upload of 200 files is one commit);
//   - a push is checked before it is accepted (a pre-receive hook asks this
//     process), then its tree becomes the collection's files.
//
// git_tree is the bridge: the tree of the commit last taken in, as
// path → (git object, stored file). Whatever differs between it and doc_files
// is a change waiting to be committed; whatever differs between it and `main`
// is a push waiting to be taken in.
//
// Large and binary files are Git LFS pointers in the tree and stored files in
// the media store, as .gitattributes says (git's own rule decides; a default
// set of patterns is written with the first commit, and a file too large to
// be a plain blob gets a line of its own).

import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, chmodSync, constants, createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.js';
import { Fault, type Identity } from './auth.js';
import { MAX_FILES_PER_COLLECTION, checkCollectionPath, mimeFor, type DocFiles } from './files.js';
import type { Media } from './media.js';

const NUL = '\x00';
const ZERO = '0'.repeat(40);
const BRANCH = 'refs/heads/main';
export const ATTRIBUTES = '.gitattributes';
/** The largest file kept as a plain git blob; anything larger is a Git LFS object. */
export const BLOB_MAX = 10 * 1024 * 1024;
const POINTER_MAX = 1024;
const LFS_ATTR = 'filter=lfs diff=lfs merge=lfs -text';
/** Kinds of file that are LFS objects from the start: already compressed, never diffed. */
const LFS_EXTS = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'heif', 'tif', 'tiff', 'bmp', 'psd', 'ai', 'raw', 'dng', 'cr2', 'nef', 'arw',
  'mp3', 'm4a', 'wav', 'flac', 'ogg', 'aac', 'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi',
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'dmg', 'iso',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'epub', 'mobi',
  'parquet', 'feather', 'npy', 'npz', 'h5', 'hdf5', 'sqlite', 'db', 'bin', 'woff', 'woff2', 'ttf', 'otf'];
/** `*.[pP][dD][fF]`: an extension in any case (IMG_0001.JPG is as common as .jpg). */
const anyCase = (ext: string) => [...ext].map((c) => (/[a-z]/.test(c) ? `[${c}${c.toUpperCase()}]` : c)).join('');
export const DEFAULT_ATTRIBUTES = `# Files of these kinds are kept with Git LFS (https://git-lfs.com): install it before cloning.\n# Anima Docs adds a line here for any other file over ${BLOB_MAX / 1024 / 1024} MB.\n${LFS_EXTS.map((e) => `*.${anyCase(e)} ${LFS_ATTR}`).join('\n')}\n`;
/**
 * A line that makes exactly this path an LFS object, written the way `git lfs track` writes one: glob characters
 * escaped, and each space as [[:space:]] (a space would end the pattern).
 */
const exactAttribute = (path: string) => `/${path.replace(/[\\*?[]/g, '\\$&').replace(/\s/g, '[[:space:]]')} ${LFS_ATTR}`;

export const lfsPointer = (oid: string, size: number) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;
export function parsePointer(b: Buffer): { oid: string; size: number } | null {
  if (b.length > POINTER_MAX) return null;
  const m = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n(?:[a-z0-9.-]+ [^\n]*\n)*?oid sha256:([0-9a-f]{64})\n(?:[a-z0-9.-]+ [^\n]*\n)*?size (\d+)\n/.exec(b.toString('utf8'));
  return m ? { oid: m[1], size: Number(m[2]) } : null;
}

export interface GitEntry { mode: string; type: string; oid: string; size: number; path: string }
export interface GitChange { status: 'A' | 'M' | 'D'; path: string }
export interface GitCommit { oid: string; parent: string | null; author: string; at: number; message: string; changes: GitChange[] }
interface TreeRow { oid: string; mediaId: string; lfs: boolean }
const plural = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export class GitRepos {
  /** Whether git is installed here; without it collections work, with no history and nothing to clone. */
  readonly available: boolean;
  private root: string;
  private hooks: string;
  private chains = new Map<string, Promise<unknown>>();
  /** Collections with changes not yet committed: who made them, and the timer that will commit. */
  private waiting = new Map<string, { by: Set<string>; timer: NodeJS.Timeout }>();
  /** Pushes being received: the key their hook presents → the collection. */
  private pushes = new Map<string, string>();

  constructor(private db: DB, private media: Media, private files: DocFiles, private label: (sub: string) => string,
    private opts: { dataDir: string; host: string; maxBytes: number; settleMs?: number; requiredScopes?: string[]; passwordDays?: number }) {
    this.root = join(opts.dataDir, 'git');
    this.hooks = join(this.root, 'hooks');
    this.available = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
    if (!this.available) { console.warn('[git] git is not installed: file collections have no history and cannot be cloned.'); return; }
    // The hook of every repository: it hands the push to this process to be checked (see preReceive).
    mkdirSync(this.hooks, { recursive: true });
    writeFileSync(join(this.hooks, 'pre-receive.cjs'), HOOK);
    writeFileSync(join(this.hooks, 'pre-receive'), `#!/bin/sh\nexec "${process.execPath}" "${join(this.hooks, 'pre-receive.cjs')}"\n`);
    chmodSync(join(this.hooks, 'pre-receive'), 0o755);
  }

  dir(docId: string): string { return join(this.root, `${docId}.git`); }

  /** Whether a push can be checked: the hook must be runnable (a volume mounted without exec permission makes it not). */
  get canReceive(): boolean {
    try { accessSync(join(this.hooks, 'pre-receive'), constants.X_OK); return true; } catch { return false; }
  }

  /** Commit whatever is waiting, everywhere (shutting down: the next start would otherwise fold it into a later commit). */
  flushAll(): Promise<void> {
    return Promise.all([...this.waiting.keys()].map((id) => this.flush(id).catch((e) => console.error('[git] commit failed', id, (e as Error).message)))).then(() => undefined);
  }

  /** Configuration for a git process serving a push. */
  get receiveConfig(): string[] {
    return ['-c', `core.hooksPath=${this.hooks}`, '-c', 'receive.denyNonFastForwards=true', '-c', 'receive.denyDeletes=true', '-c', `receive.maxInputSize=${512 * 1024 * 1024}`];
  }

  private run(dir: string | null, args: string[], o: { input?: Buffer | string; env?: Record<string, string> } = {}): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = execFile('git', ['-c', 'safe.directory=*', ...args], {
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...(dir ? { GIT_DIR: dir } : {}), ...o.env }, encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024,
      }, (err, stdout, stderr) => (err ? reject(Object.assign(new Error(`git ${args[0]}: ${String(stderr).trim() || err.message}`), { exit: (err as { code?: unknown }).code })) : resolve(stdout)));
      child.stdin!.on('error', () => undefined);
      child.stdin!.end(o.input ?? '');
    });
  }

  /** A git process for the smart HTTP protocol (upload-pack, receive-pack), to be piped to and from the client. */
  serve(docId: string, args: string[], env: Record<string, string> = {}): ChildProcessWithoutNullStreams {
    return spawn('git', ['-c', 'safe.directory=*', ...args, this.dir(docId)], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...env } });
  }

  /** One thing at a time per collection. */
  private lock<T>(docId: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(docId) ?? Promise.resolve()).then(fn, fn);
    const settled = next.catch(() => undefined);
    this.chains.set(docId, settled);
    void settled.then(() => { if (this.chains.get(docId) === settled) this.chains.delete(docId); });
    return next;
  }

  private async ensure(docId: string): Promise<string> {
    const dir = this.dir(docId);
    if (!existsSync(join(dir, 'HEAD'))) await this.run(null, ['init', '--bare', '--quiet', '--initial-branch=main', dir]);
    return dir;
  }
  private head(dir: string): Promise<string | null> {
    // Exit 1 is git saying there is no such ref (a repository with no commits yet); anything else is a failure, not an empty repository.
    return this.run(dir, ['rev-parse', '--verify', '--quiet', BRANCH]).then((b) => b.toString().trim() || null, (e) => { if ((e as { exit?: unknown }).exit === 1) return null; throw e; });
  }
  private tree(docId: string): Map<string, TreeRow> {
    const rows = this.db.prepare('SELECT path, oid, media_id, lfs FROM git_tree WHERE doc_id = ?').all(docId) as { path: string; oid: string; media_id: string; lfs: number }[];
    return new Map(rows.map((r) => [r.path, { oid: r.oid, mediaId: r.media_id, lfs: !!r.lfs }]));
  }
  private async lsTree(dir: string, rev: string, path?: string, env?: Record<string, string>): Promise<GitEntry[]> {
    const out = (await this.run(dir, ['ls-tree', '-r', '-z', '--long', rev, ...(path ? ['--', path] : [])], { env })).toString('utf8');
    return out.split(NUL).filter(Boolean).map((line) => {
      const tab = line.indexOf('\t');
      const [mode, type, oid, size] = line.slice(0, tab).split(/ +/);
      return { mode, type, oid, size: Number(size) || 0, path: line.slice(tab + 1) };
    });
  }
  /** The contents of blobs, read in one process. */
  private async blobs(dir: string, oids: string[], env?: Record<string, string>): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>();
    if (!oids.length) return out;
    const b = await this.run(dir, ['cat-file', '--batch'], { input: `${oids.join('\n')}\n`, env });
    for (let at = 0; at < b.length;) {
      const nl = b.indexOf(0x0a, at);
      const [oid, type, size] = b.toString('utf8', at, nl).split(' ');
      if (type === 'missing') { at = nl + 1; continue; }
      out.set(oid, b.subarray(nl + 1, nl + 1 + Number(size)));
      at = nl + 1 + Number(size) + 1;
    }
    return out;
  }

  // ------------------------------------------------------------------ changes made here → commits

  /** A collection's files changed (the browser, a tool): commit once things have been quiet for a moment. */
  changed(docId: string, by: string) {
    if (!this.available) return;
    const was = this.waiting.get(docId);
    if (was) clearTimeout(was.timer);
    const timer = setTimeout(() => void this.flush(docId).catch((e) => console.error('[git] commit failed', docId, (e as Error).message)), this.opts.settleMs ?? 5000);
    timer.unref();
    const who = was?.by ?? new Set<string>();
    if (by) who.add(by);
    this.waiting.set(docId, { by: who, timer });
  }

  /** Bring the repository and the collection in step now. Returns the head commit. */
  flush(docId: string, o: { by?: string; message?: string } = {}): Promise<string | null> {
    if (!this.available) return Promise.resolve(null);
    return this.lock(docId, () => this.sync(docId, o));
  }

  private async sync(docId: string, o: { by?: string; message?: string } = {}): Promise<string | null> {
    const waiting = this.waiting.get(docId);
    if (waiting) { clearTimeout(waiting.timer); this.waiting.delete(docId); }
    // The commit names everyone whose changes it holds (several people within one quiet spell share one).
    const authors = waiting?.by.size ? [...waiting.by] : o.by ? [o.by] : [];
    const by = o.by ?? authors[authors.length - 1] ?? '';
    const dir = await this.ensure(docId);
    const head = await this.head(dir);
    const synced = (this.db.prepare('SELECT head FROM git_head WHERE doc_id = ?').get(docId) as { head: string } | undefined)?.head ?? null;
    // No commits (a new collection, or a repository lost and made again): nothing of an earlier one is assumed.
    if (!head && synced) { this.db.prepare('DELETE FROM git_tree WHERE doc_id = ?').run(docId); this.db.prepare('DELETE FROM git_head WHERE doc_id = ?').run(docId); }
    // A push that has not been taken in yet (this is how every push arrives; also one cut short by a restart).
    if (head && head !== synced) await this.takeIn(docId, dir, head, by);

    const rows = this.files.list(docId);
    const tree = this.tree(docId);
    const byPath = new Map(rows.map((r) => [r.path, r]));
    const changed = rows.filter((r) => tree.get(r.path)?.mediaId !== r.mediaId && r.path !== ATTRIBUTES);
    const removed = [...tree.keys()].filter((p) => !byPath.has(p));
    const attrsRow = byPath.get(ATTRIBUTES);
    const attrsChanged = !!attrsRow && tree.get(ATTRIBUTES)?.mediaId !== attrsRow.mediaId;
    if (!changed.length && !removed.length && !attrsChanged && (attrsRow || !rows.length)) return head;

    const index = join(dir, `index-${randomBytes(6).toString('hex')}`);
    const tmp = mkdtempSync(join(dir, 'tmp-'));
    const env = { GIT_INDEX_FILE: index };
    const stage = (lines: string[]) => (lines.length ? this.run(dir, ['update-index', '-z', '--index-info'], { env, input: lines.join('') }).then(() => undefined) : Promise.resolve());
    try {
      if (head) await this.run(dir, ['read-tree', head], { env });
      // The attributes first: they decide which of the other files are LFS pointers.
      let attrs = attrsRow ? this.files.text(docId, ATTRIBUTES) ?? '' : rows.length ? DEFAULT_ATTRIBUTES : null;
      let attrsOid: string | null = null;
      const stageAttrs = async () => {
        attrsOid = (await this.run(dir, ['hash-object', '-w', '--no-filters', '--stdin'], { input: attrs! })).toString().trim();
        await stage([`100644 ${attrsOid}\t${ATTRIBUTES}${NUL}`]);
      };
      if (attrs !== null) await stageAttrs();
      const lfs = new Set<string>();
      if (changed.length) {
        const out = (await this.run(dir, ['check-attr', '--cached', '-z', '--stdin', 'filter'], { env, input: changed.map((r) => r.path + NUL).join('') })).toString('utf8').split(NUL);
        for (let i = 0; i + 2 < out.length; i += 3) if (out[i + 2] === 'lfs') lfs.add(out[i]);
        // Too large for a plain blob, and no pattern says LFS: a line for exactly this file.
        const large = changed.filter((r) => r.size > BLOB_MAX && !lfs.has(r.path));
        if (large.length) {
          attrs = `${attrs!.replace(/\n?$/, '\n')}${large.map((r) => exactAttribute(r.path)).join('\n')}\n`;
          await stageAttrs();
          for (const r of large) lfs.add(r.path);
        }
      }
      // An empty file is itself in LFS's terms: never a pointer.
      const isLfs = (r: { path: string; size: number }) => lfs.has(r.path) && r.size > 0;

      // The git object of each changed file: one already known for the same stored file, or a new one.
      const known = this.db.prepare('SELECT oid FROM git_tree WHERE doc_id = ? AND media_id = ? AND lfs = ? LIMIT 1');
      const oidOf = new Map<string, string>();
      const make: { path: string; file: string }[] = [];
      for (const [n, r] of changed.entries()) {
        const have = known.get(docId, r.mediaId, isLfs(r) ? 1 : 0) as { oid: string } | undefined;
        if (have) { oidOf.set(r.path, have.oid); continue; }
        const at = this.media.locate(r.mediaId);
        if (!at) throw new Error(`The stored file of ${r.path} is missing.`);
        if (!isLfs(r)) { make.push({ path: r.path, file: at.file }); continue; }
        const sha = (this.db.prepare('SELECT oid FROM lfs_objects WHERE media_id = ? LIMIT 1').get(r.mediaId) as { oid: string } | undefined)?.oid ?? await sha256(at.file);
        this.db.prepare('INSERT OR IGNORE INTO lfs_objects (doc_id, oid, media_id, size) VALUES (?, ?, ?, ?)').run(docId, sha, r.mediaId, at.size);
        const file = join(tmp, `p${n}`);
        writeFileSync(file, lfsPointer(sha, at.size));
        make.push({ path: r.path, file });
      }
      if (make.length) {
        const oids = (await this.run(dir, ['hash-object', '-w', '--no-filters', '--stdin-paths'], { input: make.map((m) => `${m.file}\n`).join('') })).toString().trim().split('\n');
        make.forEach((m, i) => oidOf.set(m.path, oids[i]));
      }
      await stage([...removed.filter((p) => !(p === ATTRIBUTES && attrs !== null)).map((p) => `0 ${ZERO}\t${p}${NUL}`), ...changed.map((r) => `100644 ${oidOf.get(r.path)}\t${r.path}${NUL}`)]);

      // The attributes file, when this commit wrote or changed it, is a file of the collection like any other.
      let attrsMedia = attrsRow?.mediaId ?? null;
      if (attrs !== null && (!attrsRow || attrs !== (this.files.text(docId, ATTRIBUTES) ?? ''))) attrsMedia = this.files.put(docId, ATTRIBUTES, Buffer.from(attrs), by, { maxBytes: this.opts.maxBytes }).mediaId;

      const treeOid = (await this.run(dir, ['write-tree'], { env })).toString().trim();
      let commit = head;
      if (!head || treeOid !== (await this.run(dir, ['rev-parse', `${head}^{tree}`])).toString().trim()) {
        const names = authors.map((sub) => this.label(sub).replace(/[<>\n]/g, '').trim()).filter(Boolean);
        const name = names.length > 3 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} others` : names.join(', ') || 'Anima Docs';
        const who = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `noreply@${this.opts.host}`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `noreply@${this.opts.host}` };
        const message = o.message ?? describe(changed.map((r) => ({ path: r.path, mediaId: r.mediaId, isNew: !tree.has(r.path) })), removed.filter((p) => p !== ATTRIBUTES).map((p) => ({ path: p, mediaId: tree.get(p)!.mediaId })));
        commit = (await this.run(dir, ['commit-tree', treeOid, ...(head ? ['-p', head] : []), '-m', message], { env: who })).toString().trim();
        await this.run(dir, ['update-ref', BRANCH, commit, head ?? ZERO]);
      }
      this.db.transaction(() => {
        const del = this.db.prepare('DELETE FROM git_tree WHERE doc_id = ? AND path = ?');
        const put = this.db.prepare('INSERT INTO git_tree (doc_id, path, oid, media_id, lfs) VALUES (?, ?, ?, ?, ?) ON CONFLICT(doc_id, path) DO UPDATE SET oid = excluded.oid, media_id = excluded.media_id, lfs = excluded.lfs');
        for (const p of removed) del.run(docId, p);
        for (const r of changed) put.run(docId, r.path, oidOf.get(r.path), r.mediaId, isLfs(r) ? 1 : 0);
        if (attrs !== null && attrsOid && attrsMedia) put.run(docId, ATTRIBUTES, attrsOid, attrsMedia, 0);
        this.db.prepare('INSERT INTO git_head (doc_id, head) VALUES (?, ?) ON CONFLICT(doc_id) DO UPDATE SET head = excluded.head').run(docId, commit);
      })();
      void this.run(dir, ['gc', '--auto', '--quiet']).catch(() => undefined);
      return commit;
    } finally {
      rmSync(index, { force: true });
      rmSync(`${index}.lock`, { force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ------------------------------------------------------------------ a commit's tree → the collection's files

  /** The stored file of each of these tree entries: known already, an LFS object uploaded before, or the blob itself. */
  private async materialize(docId: string, dir: string, entries: GitEntry[], by: string): Promise<Map<string, { mediaId: string; lfs: boolean }>> {
    const out = new Map<string, { mediaId: string; lfs: boolean }>();
    const known = this.db.prepare('SELECT media_id, lfs FROM git_tree WHERE doc_id = ? AND oid = ? LIMIT 1');
    const need: GitEntry[] = [];
    for (const e of entries) {
      if (out.has(e.oid) || need.some((n) => n.oid === e.oid)) continue;
      const k = known.get(docId, e.oid) as { media_id: string; lfs: number } | undefined;
      if (k) out.set(e.oid, { mediaId: k.media_id, lfs: !!k.lfs }); else need.push(e);
    }
    // Read in batches: a push may bring many megabytes of plain files.
    for (let i = 0; i < need.length;) {
      let j = i, bytes = 0;
      while (j < need.length && (j === i || bytes + need[j].size <= 64 * 1024 * 1024)) bytes += need[j++].size;
      const blobs = await this.blobs(dir, need.slice(i, j).map((e) => e.oid));
      for (const e of need.slice(i, j)) {
        const b = blobs.get(e.oid);
        if (!b) throw new Fault(409, `${e.path} is missing from the repository.`);
        const p = parsePointer(b);
        if (!p) { out.set(e.oid, { mediaId: this.media.put(b, by || 'git', docId, { name: baseName(e.path), imagesOnly: false, maxBytes: BLOB_MAX, asFile: true }).id, lfs: false }); continue; }
        const o = this.db.prepare('SELECT media_id FROM lfs_objects WHERE doc_id = ? AND oid = ?').get(docId, p.oid) as { media_id: string } | undefined;
        if (!o) throw new Fault(409, `The Git LFS object of ${e.path} is not on the server.`);
        out.set(e.oid, { mediaId: o.media_id, lfs: true });
      }
      i = j;
    }
    return out;
  }

  /** Write tree entries into the collection's files (and, when they are the head's, into the bridge). */
  private record(docId: string, entries: GitEntry[], made: Map<string, { mediaId: string; lfs: boolean }>, by: string, bridge: boolean) {
    const now = Date.now();
    const file = this.db.prepare(`INSERT INTO doc_files (doc_id, path, media_id, mime, size, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc_id, path) DO UPDATE SET media_id = excluded.media_id, mime = excluded.mime, size = excluded.size, updated_at = excluded.updated_at, updated_by = excluded.updated_by`);
    const have = this.db.prepare('SELECT media_id FROM doc_files WHERE doc_id = ? AND path = ?');
    const link = this.db.prepare('INSERT INTO git_tree (doc_id, path, oid, media_id, lfs) VALUES (?, ?, ?, ?, ?) ON CONFLICT(doc_id, path) DO UPDATE SET oid = excluded.oid, media_id = excluded.media_id, lfs = excluded.lfs');
    for (const e of entries) {
      const m = made.get(e.oid)!;
      if ((have.get(docId, e.path) as { media_id: string } | undefined)?.media_id !== m.mediaId) {
        const info = this.media.info(m.mediaId);
        file.run(docId, e.path, m.mediaId, mimeFor(e.path, info?.mime ?? null), info?.size ?? 0, now, by || 'git');
      }
      if (bridge) link.run(docId, e.path, e.oid, m.mediaId, m.lfs ? 1 : 0);
    }
    this.db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').run(now, docId);
  }

  /** `main` moved (a push): what it changed becomes the collection's files. */
  private async takeIn(docId: string, dir: string, commit: string, by: string) {
    const entries = await this.lsTree(dir, commit);
    const tree = this.tree(docId);
    const next = new Set(entries.map((e) => e.path));
    const fresh = entries.filter((e) => tree.get(e.path)?.oid !== e.oid);
    const gone = [...tree.keys()].filter((p) => !next.has(p));
    const made = await this.materialize(docId, dir, fresh, by);
    this.db.transaction(() => {
      // Out first: a push may turn a file into a folder, or a folder into a file.
      for (const p of gone) {
        this.db.prepare('DELETE FROM doc_files WHERE doc_id = ? AND path = ?').run(docId, p);
        this.db.prepare('DELETE FROM git_tree WHERE doc_id = ? AND path = ?').run(docId, p);
      }
      this.record(docId, fresh, made, by, true);
      this.db.prepare('INSERT INTO git_head (doc_id, head) VALUES (?, ?) ON CONFLICT(doc_id) DO UPDATE SET head = excluded.head').run(docId, commit);
    })();
  }

  // ------------------------------------------------------------------ pushes

  /**
   * Receive a push: everything waiting is committed first (the client must see it to build on it), the
   * push runs with a key its hook presents back here, and what it brought is taken in. The caller has
   * checked canReceive: git skips a hook it cannot run, and an unchecked push must not be received.
   */
  push(docId: string, by: string, receive: (hookKey: string) => Promise<void>): Promise<void> {
    return this.lock(docId, async () => {
      await this.sync(docId);
      const key = randomBytes(24).toString('hex');
      this.pushes.set(key, docId);
      try { await receive(key); } finally { this.pushes.delete(key); }
      await this.sync(docId, { by });
    });
  }

  /**
   * The pre-receive hook asks: may these refs move? The new objects are still in quarantine (the hook
   * passes where). Only `main` exists; it moves forward only; plain files stay small; every LFS pointer
   * has its object here; names are ones a collection can hold.
   */
  async preReceive(key: string, body: { updates?: string; objects?: string; alternates?: string }): Promise<{ ok: boolean; message?: string }> {
    const docId = this.pushes.get(key);
    if (!docId) return { ok: false, message: 'This push is not expected.' };
    const dir = this.dir(docId);
    const env: Record<string, string> = body.objects ? { GIT_OBJECT_DIRECTORY: body.objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: body.alternates ?? '' } : {};
    const no = (message: string) => ({ ok: false, message });
    for (const line of String(body.updates ?? '').split('\n').filter(Boolean)) {
      const [old, tip, ref] = line.split(' ');
      if (ref !== BRANCH) return no(`A collection has one branch, main: ${ref.replace(/^refs\/(heads|tags)\//, '')} cannot be pushed.`);
      if (tip === ZERO) return no('main cannot be deleted.');
      const listed = (await this.run(dir, ['rev-list', '--objects', tip, ...(old === ZERO ? [] : ['--not', old])], { env })).toString('utf8').split('\n').filter(Boolean)
        .map((l) => ({ oid: l.slice(0, 40), path: l.slice(41) }));
      const sizes = (await this.run(dir, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { env, input: listed.map((o) => `${o.oid}\n`).join('') })).toString().split('\n').filter(Boolean)
        .map((l) => { const [oid, type, size] = l.split(' '); return { oid, type, size: Number(size) }; });
      const pathOf = new Map(listed.map((o) => [o.oid, o.path]));
      const big = sizes.find((o) => o.type === 'blob' && o.size > BLOB_MAX);
      if (big) return no(`${pathOf.get(big.oid)} (${fmtSize(big.size)}) is too large to push as a plain file (the limit is ${BLOB_MAX / 1024 / 1024} MB). Keep it with Git LFS:\n  git lfs migrate import --include="${pathOf.get(big.oid)}" && git push`);
      // Every LFS pointer among the new files needs its object on the server (git-lfs uploads them before it pushes).
      const small = sizes.filter((o) => o.type === 'blob' && o.size <= POINTER_MAX && o.size > 0);
      const blobs = await this.blobs(dir, small.map((o) => o.oid), env);
      const has = this.db.prepare('SELECT size FROM lfs_objects WHERE doc_id = ? AND oid = ?');
      for (const o of small) {
        const p = parsePointer(blobs.get(o.oid) ?? Buffer.alloc(0));
        const stored = p ? has.get(docId, p.oid) as { size: number } | undefined : undefined;
        if (p && stored && stored.size !== p.size) return no(`${pathOf.get(o.oid)} is a Git LFS pointer that gives its file's size as ${p.size} bytes; the file uploaded is ${stored.size}.`);
        if (p && !stored) return no(`${pathOf.get(o.oid)} is a Git LFS pointer, but its file was not uploaded. With git-lfs installed (git lfs install), run:\n  git lfs push --all origin main && git push`);
      }
      const problem = treeProblem(await this.lsTree(dir, tip, undefined, env));
      if (problem) return no(problem);
    }
    return { ok: true };
  }

  // ------------------------------------------------------------------ history

  async log(docId: string, o: { limit?: number; before?: string } = {}): Promise<GitCommit[]> {
    const head = await this.flush(docId);
    if (!head) return [];
    if (o.before && !/^[0-9a-f]{40}$/.test(o.before)) throw new Fault(400, 'Not a commit.');
    const out = (await this.run(this.dir(docId), ['log', '-z', '--first-parent', '--diff-merges=first-parent', '--no-renames', '--name-status', '--format=%x1e%H%x1f%P%x1f%an%x1f%at%x1f%s',
      '-n', String(Math.min(200, Math.max(1, o.limit ?? 50))), ...(o.before ? ['--skip=1', o.before] : [BRANCH])])).toString('utf8');
    return out.split('\x1e').filter(Boolean).map((rec) => {
      const end = rec.indexOf(NUL);
      const [oid, parents, author, at, message] = rec.slice(0, end).split('\x1f');
      const rest = rec.slice(end + 1).replace(/^\n/, '').split(NUL).filter((s) => s !== '');
      const changes: GitChange[] = [];
      for (let i = 0; i + 1 < rest.length; i += 2) changes.push({ status: (rest[i][0] === 'A' || rest[i][0] === 'D' ? rest[i][0] : 'M') as GitChange['status'], path: rest[i + 1] });
      return { oid, parent: parents.split(' ')[0] || null, author, at: Number(at) * 1000, message, changes };
    });
  }

  /**
   * Bring back what a commit held: the whole collection, or one file or folder of it. Nothing is rewritten:
   * the restored state is a new commit on top.
   */
  restore(docId: string, version: string, path: string | null, by: string, when: 'after' | 'before' = 'after'): Promise<string | null> {
    if (!this.available) throw new Fault(409, 'This server keeps no history of collections.');
    const id = version.trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(id)) throw new Fault(400, 'A version is a change id from the history (at least its first 7 characters).');
    return this.lock(docId, async () => {
      const head = await this.sync(docId);
      const dir = this.dir(docId);
      // git resolves the id: a prefix that fits two changes, or none, is refused by it.
      const resolve = (rev: string) => this.run(dir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).then((b) => b.toString().trim(), () => null);
      const named = head ? await resolve(id) : null;
      if (!named || !(await this.run(dir, ['merge-base', '--is-ancestor', named, head!]).then(() => true, () => false))) throw new Fault(404, `No change ${version} in this collection's history (or the id fits more than one: give more of it).`);
      const commit = when === 'before' ? await resolve(`${named}~1`) : named;
      if (!commit) throw new Fault(404, 'There is nothing before the first change.');
      const at = path === null ? null : checkCollectionPath(path);
      const entries = await this.lsTree(dir, commit, at ?? undefined);
      if (at !== null && !entries.length) throw new Fault(404, `${at} is not in that version.`);
      // A push is checked at its tip; an earlier commit of it may hold what a collection cannot.
      const problem = treeProblem(at === null ? entries : await this.lsTree(dir, commit));
      if (problem) throw new Fault(409, `That version cannot be restored: ${problem}`);
      const made = await this.materialize(docId, dir, entries, by);
      const keep = new Set(entries.map((e) => e.path));
      this.db.transaction(() => {
        // What is there now and was not then goes: of the whole collection, or of the folder restored.
        const isFolder = at !== null && !keep.has(at);
        for (const f of this.files.list(docId, isFolder ? at! : undefined)) if (at === null || isFolder) { if (!keep.has(f.path)) this.db.prepare('DELETE FROM doc_files WHERE doc_id = ? AND path = ?').run(docId, f.path); }
        for (const e of entries) this.files.checkFree(docId, e.path);
        this.record(docId, entries, made, by, false);
      })();
      const short = commit.slice(0, 7);
      return this.sync(docId, { by, message: at === null ? `Restore the collection as of ${short}` : `Restore ${at} as of ${short}` });
    });
  }

  // ------------------------------------------------------------------ LFS objects

  lfsObject(docId: string, oid: string): { mediaId: string; size: number } | null {
    const r = this.db.prepare('SELECT media_id, size FROM lfs_objects WHERE doc_id = ? AND oid = ?').get(docId, oid) as { media_id: string; size: number } | undefined;
    return r ? { mediaId: r.media_id, size: r.size } : null;
  }
  /** Store an uploaded LFS object: the bytes must hash to the name they were sent under. */
  async lfsPut(docId: string, oid: string, body: AsyncIterable<Uint8Array>, by: string): Promise<void> {
    const hash = createHash('sha256');
    const tee = async function* () { for await (const c of body) { hash.update(c); yield c; } };
    const info = await this.media.putStream(tee(), by, docId, { name: null, maxBytes: this.opts.maxBytes, asFile: true });
    if (hash.digest('hex') !== oid) throw new Fault(422, 'The object does not match its name.');
    this.db.prepare('INSERT OR IGNORE INTO lfs_objects (doc_id, oid, media_id, size) VALUES (?, ?, ?, ?)').run(docId, oid, info.id, info.size);
  }

  // ------------------------------------------------------------------ passwords for git

  /** A person's password for git (one each; making a new one ends the old). Shown once. */
  mintToken(who: Identity): string {
    const token = `adg_${randomBytes(24).toString('base64url')}`;
    this.db.prepare('INSERT INTO git_tokens (sub, token_hash, identity, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(sub) DO UPDATE SET token_hash = excluded.token_hash, identity = excluded.identity, created_at = excluded.created_at')
      .run(who.sub, createHash('sha256').update(token).digest('hex'), JSON.stringify({ ...who, scopes: who.scopes.filter((s) => s !== 'docs:admin') }), Date.now());
    return token;
  }
  tokenInfo(sub: string): { createdAt: number; expiresAt: number } | null {
    const r = this.db.prepare('SELECT created_at FROM git_tokens WHERE sub = ?').get(sub) as { created_at: number } | undefined;
    return r ? { createdAt: r.created_at, expiresAt: r.created_at + (this.opts.passwordDays ?? 90) * 86400_000 } : null;
  }
  dropToken(sub: string) { this.db.prepare('DELETE FROM git_tokens WHERE sub = ?').run(sub); }
  identityOf(token: string): Identity | null {
    const r = this.db.prepare('SELECT identity, created_at FROM git_tokens WHERE token_hash = ?').get(createHash('sha256').update(token).digest('hex')) as { identity: string; created_at: number } | undefined;
    // Like a session, it ends a fixed time after it was made: the person signs in again (their roles are re-read) and makes another.
    if (!r || Date.now() - r.created_at > (this.opts.passwordDays ?? 90) * 86400_000) return null;
    try {
      const who = JSON.parse(r.identity) as Identity;
      return (this.opts.requiredScopes ?? []).every((s) => who.scopes.includes(s)) ? who : null;
    } catch { return null; }
  }

  close() { for (const w of this.waiting.values()) clearTimeout(w.timer); this.waiting.clear(); }
}

/** Why a tree cannot be a collection's files, or null: plain files only, names a collection holds, within its size. */
function treeProblem(entries: GitEntry[]): string | null {
  if (entries.length > MAX_FILES_PER_COLLECTION) return `A collection holds at most ${MAX_FILES_PER_COLLECTION} files; this has ${entries.length}.`;
  for (const e of entries) {
    if (e.type !== 'blob' || (e.mode !== '100644' && e.mode !== '100755')) return `${e.path} is a ${e.mode === '120000' ? 'symbolic link' : e.type === 'commit' ? 'submodule' : 'special file'}: a collection holds plain files only.`;
    let fits = false;
    try { fits = checkCollectionPath(e.path) === e.path; } catch { /* not a name a collection takes */ }
    if (!fits) return `${JSON.stringify(e.path)} is not a file name a collection can hold (no backslashes, no names ending or starting with a space, composed Unicode).`;
  }
  return null;
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (c) => hash.update(c)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

/** The subject of a commit made here: what changed, in words. */
function describe(changed: { path: string; mediaId: string; isNew: boolean }[], removed: { path: string; mediaId: string }[]): string {
  const added = changed.filter((c) => c.isNew), modified = changed.filter((c) => !c.isNew);
  // The same stored files under new names, and nothing else: a move.
  if (added.length && added.length === removed.length && !modified.length) {
    const left = removed.map((r) => r.mediaId).sort().join(), right = added.map((a) => a.mediaId).sort().join();
    if (left === right) return added.length === 1 ? `Move ${removed[0].path} to ${added[0].path}` : `Move ${plural(added.length)}`;
  }
  const part = (verb: string, list: { path: string }[]) => (list.length === 0 ? null : list.length === 1 ? `${verb} ${list[0].path}` : `${verb} ${plural(list.length)}`);
  const parts = [part('Add', added), part('Change', modified), part('Remove', removed)].filter(Boolean) as string[];
  if (!parts.length) return 'Update .gitattributes';
  return parts.map((p, i) => (i ? p[0].toLowerCase() + p.slice(1) : p)).join(', ');
}

const HOOK = `// Written by Anima Docs at start-up. Hands a push to the server to be checked before it is accepted.
const http = require('node:http');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const url = process.env.DOCS_GIT_HOOK;
  if (!url) { process.stderr.write('Push to this repository through Anima Docs.\\n'); process.exit(1); }
  const body = JSON.stringify({ updates: input, objects: process.env.GIT_OBJECT_DIRECTORY || '', alternates: process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES || '' });
  const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
    let out = '';
    res.on('data', (d) => { out += d; });
    res.on('end', () => {
      let r = {};
      try { r = JSON.parse(out); } catch (e) { /* refused below */ }
      if (r.ok) process.exit(0);
      process.stderr.write((r.message || 'The push was refused.') + '\\n');
      process.exit(1);
    });
  });
  req.on('error', (e) => { process.stderr.write('The push could not be checked: ' + e.message + '\\n'); process.exit(1); });
  req.end(body);
});
`;
