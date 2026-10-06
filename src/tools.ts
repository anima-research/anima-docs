// The agent tool surface, shared by network MCPL and the HTTP operations API.

import type { App } from './app.js';
import type { Actor } from './principals.js';
import { Fault } from './auth.js';
import { applyEdits, type AgentEdit } from './edits.js';
import { atLeast, type Role } from './documents.js';
import { Media, fetchImage } from './media.js';
import { textChanges } from './diff.js';
import { findSections, lineOf, lineStarts, outline, withLineNumbers, images } from './markdown.js';
import { BASE_SETTINGS, WATCH_PRESET, type WatchSettings } from './attention.js';

export type FeatureSet = 'docs.read' | 'docs.write' | 'docs.comment' | 'docs.share' | 'docs.watch';

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export interface ToolResult { content: ToolContent[]; isError?: boolean }

export interface ToolDef {
  name: string;
  featureSet: FeatureSet;
  description: string;
  inputSchema: Record<string, unknown>;
  /** RFC-008 tool class. */
  toolClass: string;
  run(app: App, actor: Actor, args: Record<string, any>): Promise<ToolResult> | ToolResult;
}

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const S = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const docArg = { document: S('Document id (e.g. "dAbc12345"), its URL, or a share link someone gave you. list_documents shows ids.') };

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function need(args: Record<string, any>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new Fault(400, `${key} is required.`);
  return v.trim();
}

function threadText(app: App, t: ReturnType<App['comments']['threads']>[number]): string {
  const p = (s: string) => app.principals.label(s);
  const where = t.anchor
    ? (t.anchor.orphaned ? `on “${t.root.quote ?? ''}” (text deleted)` : `on “${clip(t.anchor.text, 120)}” (line ${t.anchor.line})`)
    : 'on the whole document';
  const head = `Thread ${t.root.id} ${where}${t.root.resolvedAt ? ` — RESOLVED by ${p(t.root.resolvedBy!)}` : ''}${t.root.assignee ? ` — assigned to ${p(t.root.assignee)}` : ''}`;
  const msgs = [t.root, ...t.replies].map((c) => `  ${p(c.author)} (${ago(c.createdAt)}${c.editedAt ? ', edited' : ''}) [${c.id}]: ${c.body.replace(/\n/g, '\n    ')}`);
  return [head, ...msgs].join('\n');
}

function clip(s: string, n: number) {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function roleArg(v: unknown, allowNone = false): Role | 'none' {
  if (v === 'viewer' || v === 'commenter' || v === 'editor' || v === 'owner' || (allowNone && v === 'none')) return v;
  throw new Fault(400, `role must be viewer, commenter, editor, owner${allowNone ? ' or none' : ''}.`);
}

function describeSettings(s: WatchSettings): string {
  const parts = [
    `edits: ${s.edits}`, `comments: ${s.comments}`, `mentions: ${s.mentions}`, `replies: ${s.replies}`, `shares: ${s.shares}`,
    `from: ${Array.isArray(s.from) ? s.from.join('|') : s.from}`,
  ];
  if (s.guests !== 'quiet') parts.push(`guests: ${s.guests}`);
  if (s.min_chars) parts.push(`min_chars: ${s.min_chars}`);
  if (s.sections.length) parts.push(`sections: ${s.sections.join(' | ')}`);
  if (s.keywords.length) parts.push(`keywords: ${s.keywords.map((k) => JSON.stringify(k)).join(', ')}`);
  parts.push(`settle: ${s.settle_seconds}s`);
  if (s.cooldown_seconds) parts.push(`cooldown: ${s.cooldown_seconds}s`);
  if (s.quiet_until) parts.push(`quiet until ${s.quiet_until}`);
  return parts.join(', ');
}

const LEVEL = { type: 'string', enum: ['wake', 'quiet', 'off'] };

/** The key in a share link URL (or a bare key). Parsed with URL, never a backtracking regex. */
export function linkKey(ref: string): string | null {
  const s = String(ref ?? '').trim();
  if (!s || s.length > 2048) return null;
  if (/^[A-Za-z0-9_-]{24}$/.test(s)) return s;
  return pathMatch(s, /^\/l\/([A-Za-z0-9_-]{20,40})\/?$/);
}

/** Match a URL's (or bare path's) pathname against an anchored pattern. */
function pathMatch(ref: string, re: RegExp): string | null {
  let path: string;
  try { path = new URL(ref, 'http://x').pathname; } catch { return null; }
  return re.exec(path)?.[1] ?? null;
}
const linkUrl = (app: App, key: string) => `${app.config.origin}/l/${key}`;
function linkLine(app: App, l: { id: string; key: string; role: Role; audience: string; label: string | null; createdBy: string; expiresAt: number | null; holders: number }) {
  return `${l.id} — ${l.audience === 'anyone' ? 'anyone with the link (no sign-in)' : 'Archipelago members with the link'} can ${l.role === 'viewer' ? 'view' : l.role === 'commenter' ? 'comment' : 'edit'}`
    + `${l.label ? ` — “${l.label}”` : ''}; made by ${app.principals.label(l.createdBy)}; opened by ${l.holders}; ${l.expiresAt ? `expires ${new Date(l.expiresAt).toISOString().slice(0, 16)}Z` : 'no expiry'}; ${linkUrl(app, l.key)}`;
}

/**
 * Accept a document URL or a share link wherever a document id is expected.
 * A share link is opened on the way (as open_link would), so it simply works.
 */
function normalizeDocumentArg(app: App, actor: Actor, args: Record<string, any>) {
  const v = args.document;
  if (typeof v !== 'string' || v === '*') return;
  if (v.length > 2048) throw new Fault(400, 'document must be a document id, its URL, or a share link.');
  if (/^[A-Za-z0-9]{1,40}$/.test(v.trim())) return;
  const key = v.includes('/l/') ? linkKey(v) : null;
  if (key) { args.document = app.docs.redeemLink(key, actor).doc.id; return; }
  const id = pathMatch(v.trim(), /^\/d\/([A-Za-z0-9]{1,40})\/?$/);
  if (id) args.document = id;
}

export const TOOLS: ToolDef[] = [
  // ------------------------------------------------------------------ docs.read
  {
    name: 'whoami', featureSet: 'docs.read', toolClass: 'notes',
    description: 'Start here: who you are, what events will reach you and how, the two wake rules to add to your host, and whether your host coalesces events.',
    inputSchema: { type: 'object', properties: {} },
    run(app, actor) {
      const star = app.attention.settings(actor.sub, '*');
      return text([
        `You are ${actor.name} (${actor.sub}), ${actor.kind === 'agent' ? 'an agent' : `a ${actor.kind}`}${actor.admin ? ', workspace admin' : ''}.`,
        `Your defaults for every document: ${describeSettings(star)}.`,
        `Watched documents: ${app.attention.watches(actor.sub).filter((w) => w.docId !== '*').length}. See list_watches; change with watch.`,
        'Events labelled docs:wake are meant to wake you; docs:quiet ones arrive without waking you. Edits arrive as a diff of what changed since you last looked, with authors; your own edits are never reported back to you.',
      ].join('\n'));
    },
  },
  {
    name: 'open_link', featureSet: 'docs.read', toolClass: 'notes',
    description: 'Open a share link someone gave you (a URL with /l/ in it). You keep the access it grants while the link stays active; afterwards use the document id with the other tools.',
    inputSchema: { type: 'object', required: ['link'], properties: { link: S('The share link URL.') } },
    run(app, actor, a) {
      const key = linkKey(need(a, 'link'));
      if (!key) throw new Fault(400, 'That is not a share link. Links look like https://…/l/<key>.');
      const r = app.docs.redeemLink(key, actor);
      const open = app.comments.openCount(r.doc.id);
      return text(`Opened “${r.doc.title}” (${r.doc.id}); you are ${r.role === 'owner' ? 'its owner' : r.role === 'editor' ? 'an editor' : `a ${r.role}`}. Owner ${app.principals.label(r.doc.ownerSub)}; ${open} open comment${open === 1 ? '' : 's'}. Read it with read_document {"document":"${r.doc.id}"}.`);
    },
  },
  {
    name: 'list_documents', featureSet: 'docs.read', toolClass: 'notes',
    description: 'List documents you can access, newest activity first.',
    inputSchema: { type: 'object', properties: {
      query: S('Filter by title substring.'),
      filter: S('all (default), owned, or shared (shared with you by others).', { enum: ['all', 'owned', 'shared'] }),
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    } },
    run(app, actor, a) {
      const list = app.docs.list(actor, { query: a.query, filter: a.filter, limit: a.limit ?? 50 });
      if (!list.length) return text('No documents. Create one with create_document.');
      return text(list.map((d) => {
        const open = app.comments.openCount(d.id);
        return `${d.id}  “${d.title}” — you: ${d.role}; owner ${app.principals.label(d.ownerSub)}; updated ${ago(d.updatedAt)}; rev ${d.rev}${open ? `; ${open} open comment${open === 1 ? '' : 's'}` : ''}`;
      }).join('\n'));
    },
  },
  {
    name: 'read_document', featureSet: 'docs.read', toolClass: 'notes',
    description: 'Read a document\'s markdown. A full read also resets what "changed since you last looked" is measured from. Use section or from_line/to_line for part of a long document.',
    inputSchema: { type: 'object', required: ['document'], properties: {
      ...docArg,
      section: S('Read only this section: heading text, "## Heading", or "Parent > Child".'),
      from_line: { type: 'integer', minimum: 1 }, to_line: { type: 'integer', minimum: 1 },
      line_numbers: { type: 'boolean', description: 'Prefix lines with numbers (default false; quote text without them when editing).' },
      comments: { type: 'boolean', description: 'Append open comment threads (default true).' },
    } },
    run(app, actor, a) {
      const id = need(a, 'document');
      const { doc, role } = app.docs.require(id, actor, 'viewer');
      const full = app.docs.text(id);
      const starts = lineStarts(full);
      let body = full, first = 1, partial = false;
      if (a.section) {
        const secs = findSections(full, String(a.section));
        if (!secs.length) throw new Fault(404, `No section "${a.section}". Headings: ${outline(full).map((h) => h.text).slice(0, 40).join(' | ')}`);
        const s = secs[0];
        body = full.slice(s.start, s.end); first = s.heading.line; partial = true;
      } else if (a.from_line || a.to_line) {
        const from = Math.max(1, a.from_line ?? 1), to = Math.min(starts.length, a.to_line ?? starts.length);
        body = full.split('\n').slice(from - 1, to).join('\n'); first = from; partial = true;
      }
      const last = first + body.split('\n').length - 1;
      const header = `# “${doc.title}” (${doc.id}) — rev ${doc.rev}, ${starts.length} lines${partial ? `, showing lines ${first}–${last}` : ''}; you are ${role}; owner ${app.principals.label(doc.ownerSub)}; updated ${ago(doc.updatedAt)}`;
      const content = a.line_numbers ? withLineNumbers(body, first) : body;
      const out = [header, '<<<DOCUMENT', content, 'DOCUMENT>>>'];
      const wantComments = a.comments !== false;
      if (wantComments) {
        const threads = app.comments.threads(id).filter((t) => !partial || (t.anchor && t.anchor.line <= last && t.anchor.endLine >= first));
        if (threads.length) out.push(`\nOpen comments (${threads.length}):\n${threads.map((t) => threadText(app, t)).join('\n\n')}`);
      }
      if (!partial) app.attention.markRead(actor.sub, id, { comments: wantComments });
      return text(out.join('\n'));
    },
  },
  {
    name: 'outline', featureSet: 'docs.read', toolClass: 'notes',
    description: 'Headings of a document with line numbers.',
    inputSchema: { type: 'object', required: ['document'], properties: { ...docArg } },
    run(app, actor, a) {
      const id = need(a, 'document');
      const { doc } = app.docs.require(id, actor, 'viewer');
      const t = app.docs.text(id);
      const h = outline(t);
      return text(`“${doc.title}” (${doc.id}), ${lineStarts(t).length} lines\n` + (h.length ? h.map((x) => `${'  '.repeat(x.level - 1)}${'#'.repeat(x.level)} ${x.text}  (line ${x.line})`).join('\n') : '(no headings)'));
    },
  },
  {
    name: 'search', featureSet: 'docs.read', toolClass: 'notes',
    description: 'Search document text (case-insensitive substring) across everything you can access, or within one document.',
    inputSchema: { type: 'object', required: ['query'], properties: { query: S('Text to find.'), ...docArg, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
    run(app, actor, a) {
      const q = need(a, 'query');
      if (a.document) {
        app.docs.require(a.document, actor, 'viewer');
        const lines = app.docs.text(a.document).split('\n');
        const hits = lines.map((l, i) => [i + 1, l] as const).filter(([, l]) => l.toLowerCase().includes(q.toLowerCase())).slice(0, a.limit ?? 30);
        return text(hits.length ? hits.map(([n, l]) => `${a.document}:${n}  ${clip(l, 240)}`).join('\n') : 'No matches.');
      }
      const hits = app.docs.search(actor, q, a.limit ?? 30);
      return text(hits.length ? hits.map((h) => `${h.doc.id}:${h.line}  “${h.doc.title}”  ${h.snippet}`).join('\n') : 'No matches.');
    },
  },
  {
    name: 'list_comments', featureSet: 'docs.read', toolClass: 'notes',
    description: 'Comment threads on a document (open ones by default), with where each is anchored.',
    inputSchema: { type: 'object', required: ['document'], properties: {
      ...docArg, thread: S('Only this thread (any comment id in it).'), include_resolved: { type: 'boolean' },
    } },
    run(app, actor, a) {
      const id = need(a, 'document');
      app.docs.require(id, actor, 'viewer');
      let threads = app.comments.threads(id, { includeResolved: !!a.include_resolved || !!a.thread });
      if (a.thread) {
        const c = app.comments.get(a.thread);
        threads = threads.filter((t) => t.root.id === (c?.threadId ?? a.thread));
      }
      app.attention.markCommentsRead(actor.sub, id);
      return text(threads.length ? threads.map((t) => threadText(app, t)).join('\n\n') : 'No comment threads.');
    },
  },
  {
    name: 'changes', featureSet: 'docs.read', toolClass: 'notes',
    description: 'What changed in a document since you last looked (or since a saved version), as an attributed diff. Useful if your host does not deliver push events.',
    inputSchema: { type: 'object', required: ['document'], properties: {
      ...docArg, since_version: S('Diff from this saved version id instead (see versions).'),
      mark_read: { type: 'boolean', description: 'Advance your "last looked" point to now (default true; ignored with since_version).' },
    } },
    async run(app, actor, a) {
      const id = need(a, 'document');
      const { doc } = app.docs.require(id, actor, 'viewer');
      if (a.since_version) {
        const c = textChanges(app.docs, app.principals, id, app.docs.versionSnapshot(id, a.since_version), { title: doc.title, maxChars: 20_000 });
        return text(c.changed ? c.text.replace('since you last looked', `since version ${a.since_version}`) : 'No changes since that version.');
      }
      const base = app.attention.baseline(actor.sub, id);
      if (!base) {
        if (a.mark_read !== false) app.attention.markRead(actor.sub, id);
        return text('You have no recorded read of this document yet, so there is nothing to diff against. Read it with read_document.');
      }
      const c = textChanges(app.docs, app.principals, id, base.snapshot, { title: doc.title, maxChars: 20_000 });
      if (a.mark_read !== false) app.attention.markRead(actor.sub, id);
      return text(c.changed ? c.text : 'Nothing changed since you last looked (other than your own edits).');
    },
  },
  {
    name: 'view_image', featureSet: 'docs.read', toolClass: 'media',
    description: 'Look at an image embedded in a document. Pass the image URL/path as written in the markdown, or list the document\'s images by passing only document.',
    inputSchema: { type: 'object', properties: { ...docArg, image: S('Image reference from the markdown, e.g. /media/<id>.png') } },
    run(app, actor, a) {
      if (!a.image) {
        const id = need(a, 'document');
        app.docs.require(id, actor, 'viewer');
        const t = app.docs.text(id);
        const starts = lineStarts(t);
        const imgs = images(t);
        return text(imgs.length ? imgs.map((i) => `line ${lineOf(starts, i.offset)}: ![${i.alt}](${i.url})`).join('\n') : 'No images in this document.');
      }
      const mid = Media.idFrom(String(a.image));
      if (!mid) return text(`That image is hosted elsewhere (${a.image}); only images uploaded here can be viewed through this tool.`);
      // Same policy as GET /media: content-addressed (unguessable) ids, any signed-in principal.
      const f = app.media.read(mid);
      if (!f) throw new Fault(404, 'No such image.');
      return { content: [
        { type: 'text', text: `${mid} — ${f.info.mime}, ${f.info.width ?? '?'}×${f.info.height ?? '?'}, ${Math.round(f.info.size / 1024)} KB` },
        { type: 'image', data: f.bytes.toString('base64'), mimeType: f.info.mime },
      ] };
    },
  },
  {
    name: 'people', featureSet: 'docs.read', toolClass: 'notes',
    description: 'Humans and agents known to this service (for mentions and sharing). Mention someone in a comment with @Name.',
    inputSchema: { type: 'object', properties: { query: S('Name or id substring.'), kind: S('human, agent or service', { enum: ['human', 'agent', 'service'] }) } },
    run(app, _actor, a) {
      const list = app.principals.list({ query: a.query, kind: a.kind, limit: 100 });
      return text(list.length ? list.map((p) => `${p.name} — ${p.kind}, ${p.sub}${p.role !== 'member' ? ` (${p.role})` : ''}; last seen ${ago(p.lastSeen)}`).join('\n') : 'No one matches.');
    },
  },
  {
    name: 'versions', featureSet: 'docs.read', toolClass: 'notes',
    description: 'Named versions of a document and recent editing activity by person.',
    inputSchema: { type: 'object', required: ['document'], properties: { ...docArg } },
    run(app, actor, a) {
      const id = need(a, 'document');
      app.docs.require(id, actor, 'viewer');
      const v = app.docs.versions(id);
      const act = app.docs.activity(id, Date.now() - 7 * 86400_000);
      const bySub = new Map<string, { added: number; removed: number; last: number }>();
      for (const r of act) {
        const x = bySub.get(r.sub) ?? { added: 0, removed: 0, last: 0 };
        x.added += r.added; x.removed += r.removed; x.last = Math.max(x.last, r.minute * 60_000);
        bySub.set(r.sub, x);
      }
      return text([
        v.length ? `Versions:\n${v.map((x) => `  ${x.id}  “${x.name}” — rev ${x.rev}, by ${app.principals.label(x.createdBy)}, ${ago(x.createdAt)}`).join('\n')}` : 'No named versions (save_version creates one).',
        bySub.size ? `Editing in the last 7 days:\n${[...bySub].sort((x, y) => y[1].last - x[1].last).map(([s, x]) => `  ${app.principals.label(s)}: +${x.added}/−${x.removed} chars, last ${ago(x.last)}`).join('\n')}` : 'No edits in the last 7 days.',
      ].join('\n\n'));
    },
  },

  // ------------------------------------------------------------------ docs.write
  {
    name: 'create_document', featureSet: 'docs.write', toolClass: 'notes',
    description: 'Create a markdown document. You become its owner and start watching it (edits quiet, comments wake). Optionally share it at once.',
    inputSchema: { type: 'object', required: ['title'], properties: {
      title: S('Document title.'), content: S('Initial markdown.'),
      share_with: { type: 'array', items: { type: 'object', required: ['who', 'role'], properties: { who: S('@Name or principal id'), role: S('viewer, commenter or editor', { enum: ['viewer', 'commenter', 'editor'] }) } } },
      general_access: S('Access for everyone signed in: restricted (default), viewer, commenter, editor.', { enum: ['restricted', 'viewer', 'commenter', 'editor'] }),
    } },
    run(app, actor, a) {
      const d = app.docs.create(actor, need(a, 'title'), typeof a.content === 'string' ? a.content : '');
      const notes: string[] = [];
      for (const s of Array.isArray(a.share_with) ? a.share_with : []) {
        try { const p = app.principals.resolve(String(s.who)); app.docs.share(d.id, actor, p.sub, roleArg(s.role)); notes.push(`shared with ${p.name} as ${s.role}`); }
        catch (e) { notes.push(`could not share with ${s.who}: ${(e as Error).message}`); }
      }
      if (a.general_access) { app.docs.setGeneralAccess(d.id, actor, a.general_access); notes.push(`general access: ${a.general_access}`); }
      app.attention.setWatch(actor.sub, d.id, {}, { preset: true });
      app.attention.markRead(actor.sub, d.id, { comments: true });
      return text(`Created “${d.title}” (${d.id}).${notes.length ? ` ${notes.join('; ')}.` : ''}\nWeb: ${app.config.origin}/d/${d.id}`);
    },
  },
  {
    name: 'edit_document', featureSet: 'docs.write', toolClass: 'notes',
    description: [
      'Edit a document. Edits are anchored on exact text (not line numbers), so they stay correct while others type. All edits in one call apply atomically: if one fails, none apply. Each edit is ONE of:',
      '  {"old_text": "...", "new_text": "..."}  replace (old_text must occur once, or pass "occurrence": n, or "replace_all": true)',
      '  {"insert_after": "...", "text": "..."} / {"insert_before": "...", "text": "..."}',
      '  {"append": "..."} / {"prepend": "..."}',
      '  {"replace_section": "Heading", "content": "..."}  replace a section body (keep_heading: false replaces the heading too)',
      '  {"append_to_section": "Heading", "text": "..."}',
      '  {"replace_all_content": "..."}  rewrite everything (applied as a minimal diff so comments on unchanged text survive)',
      'Text is markdown: tables, images (![alt](url)), lists, code. Others see your edits live, attributed to you.',
    ].join('\n'),
    inputSchema: { type: 'object', required: ['document', 'edits'], properties: {
      ...docArg,
      edits: { type: 'array', minItems: 1, items: { type: 'object', properties: {
        old_text: { type: 'string' }, new_text: { type: 'string' }, occurrence: { type: 'integer', minimum: 1 }, replace_all: { type: 'boolean' },
        insert_after: { type: 'string' }, insert_before: { type: 'string' }, text: { type: 'string' },
        append: { type: 'string' }, prepend: { type: 'string' },
        replace_section: { type: 'string' }, content: { type: 'string' }, keep_heading: { type: 'boolean' },
        append_to_section: { type: 'string' }, replace_all_content: { type: 'string' },
      } } },
    } },
    run(app, actor, a) {
      const id = need(a, 'document');
      app.docs.require(id, actor, 'editor');
      const { report, client, deleteSet } = applyEdits(app.docs, id, { sub: actor.sub, via: 'mcpl' }, a.edits as AgentEdit[]);
      app.attention.noteOwnEdit(actor.sub, id, client, deleteSet);
      const doc = app.docs.get(id)!;
      return text(`Applied to “${doc.title}” (rev ${doc.rev}):\n${report.applied.join('\n')}${report.lines.length ? `\n\nResult:\n${report.lines.join('\n…\n')}` : ''}`);
    },
  },
  {
    name: 'rename_document', featureSet: 'docs.write', toolClass: 'notes',
    description: 'Change a document\'s title.',
    inputSchema: { type: 'object', required: ['document', 'title'], properties: { ...docArg, title: S('New title.') } },
    run(app, actor, a) {
      const d = app.docs.rename(need(a, 'document'), actor, need(a, 'title'));
      return text(`Renamed to “${d.title}”.`);
    },
  },
  {
    name: 'insert_image', featureSet: 'docs.write', toolClass: 'notes',
    description: 'Upload an image (base64, or an https URL to import) and insert it as markdown. Without a position it goes at the end.',
    inputSchema: { type: 'object', required: ['document'], properties: {
      ...docArg,
      data_base64: S('Image bytes (PNG, JPEG, GIF or WebP), base64.'),
      url: S('https URL to import instead of data_base64.'),
      alt: S('Alt text / caption.'),
      insert_after: S('Insert after this exact text (on a new line).'),
      insert_before: S('Insert before this exact text (on its own line).'),
    } },
    async run(app, actor, a) {
      const id = need(a, 'document');
      app.docs.require(id, actor, 'editor');
      let bytes: Buffer;
      if (typeof a.data_base64 === 'string' && a.data_base64) bytes = Buffer.from(a.data_base64.replace(/^data:[^,]*,/, ''), 'base64');
      else if (typeof a.url === 'string' && a.url) bytes = await fetchImage(a.url);
      else throw new Fault(400, 'Pass data_base64 or url.');
      const m = app.media.put(bytes, actor.sub, id);
      const md = `![${String(a.alt ?? '').replace(/[[\]]/g, '')}](${m.url})`;
      const edit: AgentEdit = a.insert_after ? { insert_after: a.insert_after, text: `\n\n${md}\n` }
        : a.insert_before ? { insert_before: a.insert_before, text: `${md}\n\n` }
        : { append: `\n${md}\n` };
      const { client, deleteSet } = applyEdits(app.docs, id, { sub: actor.sub }, [edit]);
      app.attention.noteOwnEdit(actor.sub, id, client, deleteSet);
      return text(`Inserted ${md} (${m.mime}, ${m.width ?? '?'}×${m.height ?? '?'}).`);
    },
  },
  {
    name: 'save_version', featureSet: 'docs.write', toolClass: 'notes',
    description: 'Name the current state of a document so it can be compared against or restored later.',
    inputSchema: { type: 'object', required: ['document', 'name'], properties: { ...docArg, name: S('Version name, e.g. "Draft sent to review".') } },
    run(app, actor, a) {
      const v = app.docs.saveVersion(need(a, 'document'), actor, need(a, 'name'));
      return text(`Saved version ${v.id} at rev ${v.rev}.`);
    },
  },
  {
    name: 'restore_version', featureSet: 'docs.write', toolClass: 'notes',
    description: 'Make the document text equal to a saved version (as a new, attributed edit; history is kept).',
    inputSchema: { type: 'object', required: ['document', 'version'], properties: { ...docArg, version: S('Version id from versions.') } },
    run(app, actor, a) {
      const id = need(a, 'document');
      app.docs.restoreVersion(id, actor, need(a, 'version'));
      app.attention.markRead(actor.sub, id);
      return text(`Restored ${a.version}. Current rev ${app.docs.get(id)!.rev}.`);
    },
  },
  {
    name: 'delete_document', featureSet: 'docs.write', toolClass: 'notes',
    description: 'Delete a document you own.',
    inputSchema: { type: 'object', required: ['document'], properties: { ...docArg } },
    run(app, actor, a) {
      const id = need(a, 'document');
      const d = app.docs.require(id, actor, 'owner').doc;
      app.docs.remove(id, actor);
      return text(`Deleted “${d.title}”.`);
    },
  },

  // ------------------------------------------------------------------ docs.comment
  {
    name: 'add_comment', featureSet: 'docs.comment', toolClass: 'comms',
    description: 'Start a comment thread, anchored to quoted text (like selecting text in Google Docs) or on the whole document. @Name in the text notifies that person or agent; assign_to makes it their action item.',
    inputSchema: { type: 'object', required: ['document', 'text'], properties: {
      ...docArg,
      quote: S('Exact text to comment on. Omit to comment on the whole document.'),
      occurrence: { type: 'integer', minimum: 1, description: 'Which occurrence of quote, if it appears more than once.' },
      near_line: { type: 'integer', minimum: 1, description: 'Or: pick the occurrence closest to this line.' },
      text: S('Comment (markdown). Mention with @Name.'),
      assign_to: S('@Name or principal id to assign this thread to.'),
    } },
    run(app, actor, a) {
      const id = need(a, 'document');
      app.docs.require(id, actor, 'commenter');
      const anchor = a.quote ? app.comments.anchorFromQuote(id, String(a.quote), { occurrence: a.occurrence, nearLine: a.near_line }) : null;
      const { comment, warnings } = app.comments.create(id, actor, { body: need(a, 'text'), anchor, assignee: a.assign_to ?? null });
      const t = app.comments.thread(comment.id)!;
      return text(`Comment thread ${comment.id} created${t.anchor ? ` on line ${t.anchor.line}` : ''}.${comment.mentions.length ? ` Notified: ${comment.mentions.map((s) => app.principals.label(s)).join(', ')}.` : ''}${warnings.length ? `\nNote: ${warnings.join(' ')}` : ''}`);
    },
  },
  {
    name: 'reply_comment', featureSet: 'docs.comment', toolClass: 'comms',
    description: 'Reply in a comment thread (pass any comment id in the thread). Optionally resolve it in the same step.',
    inputSchema: { type: 'object', required: ['comment', 'text'], properties: {
      comment: S('Thread or comment id.'), text: S('Reply (markdown). @Name notifies.'),
      resolve: { type: 'boolean', description: 'Also mark the thread resolved.' },
      reopen: { type: 'boolean', description: 'Also reopen a resolved thread.' },
    } },
    run(app, actor, a) {
      const { comment, warnings } = app.comments.reply(need(a, 'comment'), actor, need(a, 'text'), { resolve: !!a.resolve, reopen: !!a.reopen });
      return text(`Replied in thread ${comment.threadId} (${comment.id})${a.resolve ? ' and resolved it' : ''}.${warnings.length ? `\nNote: ${warnings.join(' ')}` : ''}`);
    },
  },
  {
    name: 'resolve_comment', featureSet: 'docs.comment', toolClass: 'comms',
    description: 'Resolve a comment thread (or reopen it with reopen: true).',
    inputSchema: { type: 'object', required: ['comment'], properties: { comment: S('Thread or comment id.'), reopen: { type: 'boolean' } } },
    run(app, actor, a) {
      const c = app.comments.resolve(need(a, 'comment'), actor, !a.reopen);
      return text(`Thread ${c.id} ${c.resolvedAt ? 'resolved' : 'reopened'}.`);
    },
  },
  {
    name: 'edit_comment', featureSet: 'docs.comment', toolClass: 'comms',
    description: 'Change the text of your own comment.',
    inputSchema: { type: 'object', required: ['comment', 'text'], properties: { comment: S('Comment id.'), text: S('New text.') } },
    run(app, actor, a) {
      const { comment, warnings } = app.comments.editBody(need(a, 'comment'), actor, need(a, 'text'));
      return text(`Edited ${comment.id}.${warnings.length ? `\nNote: ${warnings.join(' ')}` : ''}`);
    },
  },
  {
    name: 'delete_comment', featureSet: 'docs.comment', toolClass: 'comms',
    description: 'Delete your comment (deleting a thread\'s first comment deletes the thread). Document owners can delete any comment.',
    inputSchema: { type: 'object', required: ['comment'], properties: { comment: S('Comment id.') } },
    run(app, actor, a) {
      app.comments.remove(need(a, 'comment'), actor);
      return text('Deleted.');
    },
  },
  {
    name: 'assign_comment', featureSet: 'docs.comment', toolClass: 'comms',
    description: 'Assign a comment thread to someone (they are notified), or unassign with to: null.',
    inputSchema: { type: 'object', required: ['comment'], properties: { comment: S('Thread or comment id.'), to: { type: ['string', 'null'], description: '@Name, principal id, or null.' } } },
    run(app, actor, a) {
      const { comment } = app.comments.assign(need(a, 'comment'), actor, a.to ?? null);
      return text(comment.assignee ? `Assigned thread ${comment.id} to ${app.principals.label(comment.assignee)}.` : `Unassigned thread ${comment.id}.`);
    },
  },

  // ------------------------------------------------------------------ docs.share
  {
    name: 'list_access', featureSet: 'docs.share', toolClass: 'control',
    description: 'Who can access a document, and the access everyone signed in has.',
    inputSchema: { type: 'object', required: ['document'], properties: { ...docArg } },
    run(app, actor, a) {
      const id = need(a, 'document');
      const { doc } = app.docs.require(id, actor, 'viewer');
      const acl = app.docs.acl(id);
      const links = app.docs.links(id, actor);
      return text([`“${doc.title}”: owner ${app.principals.label(doc.ownerSub)}; everyone signed in: ${doc.generalAccess === 'restricted' ? 'no access' : doc.generalAccess}.`,
        ...acl.map((x) => `  ${app.principals.label(x.sub)} (${app.principals.get(x.sub)?.kind ?? '?'}) — ${x.role}`),
        ...(links.length ? ['Share links (yours, or all of them if you own it):', ...links.map((l) => `  ${linkLine(app, l)}`)] : [])].join('\n'));
    },
  },
  {
    name: 'share_document', featureSet: 'docs.share', toolClass: 'control',
    description: 'Give a person or agent access to a document (viewer, commenter, editor; owners can also transfer ownership or remove access with none). They are notified.',
    inputSchema: { type: 'object', required: ['document', 'with', 'role'], properties: {
      ...docArg, with: S('@Name or principal id.'), role: S('viewer | commenter | editor | owner | none', { enum: ['viewer', 'commenter', 'editor', 'owner', 'none'] }),
    } },
    run(app, actor, a) {
      const id = need(a, 'document');
      const p = app.principals.resolve(need(a, 'with'));
      app.docs.share(id, actor, p.sub, roleArg(a.role, true));
      return text(a.role === 'none' ? `Removed ${p.name}'s access.` : `${p.name} (${p.kind}) is now ${a.role}.`);
    },
  },
  {
    name: 'set_general_access', featureSet: 'docs.share', toolClass: 'control',
    description: 'Set what everyone signed in to this service can do with a document (owners only).',
    inputSchema: { type: 'object', required: ['document', 'access'], properties: { ...docArg, access: S('restricted | viewer | commenter | editor', { enum: ['restricted', 'viewer', 'commenter', 'editor'] }) } },
    run(app, actor, a) {
      app.docs.setGeneralAccess(need(a, 'document'), actor, a.access);
      return text(`General access is now ${a.access}.`);
    },
  },
  {
    name: 'create_link', featureSet: 'docs.share', toolClass: 'control',
    description: 'Make a share link for a document. who: "anyone" — works without signing in (visitors appear as guests; owners only); "members" — anyone signed in with Archipelago who has the link. Access through a link lasts while the link is active; revoke_link ends it for everyone who used it.',
    inputSchema: { type: 'object', required: ['document', 'role', 'who'], properties: {
      ...docArg,
      role: S('What the link lets people do.', { enum: ['viewer', 'commenter', 'editor'] }),
      who: S('anyone (no sign-in needed) or members (Archipelago sign-in needed).', { enum: ['anyone', 'members'] }),
      label: S('Optional note to remember what the link is for, e.g. "for the reading group".'),
      expires_in_days: { type: 'number', minimum: 0.05, maximum: 365, description: 'Optional; the link stops working after this many days.' },
    } },
    run(app, actor, a) {
      const l = app.docs.createLink(need(a, 'document'), actor, { role: roleArg(a.role) as Role, audience: a.who, label: a.label ?? null, expiresInDays: a.expires_in_days ?? null });
      return text(`Link ${l.id}: ${linkUrl(app, l.key)}\n${linkLine(app, l)}`);
    },
  },
  {
    name: 'revoke_link', featureSet: 'docs.share', toolClass: 'control',
    description: 'Turn off a share link (by its id or URL). Everyone who came in through it loses that access at once.',
    inputSchema: { type: 'object', required: ['link'], properties: { link: S('Link id (from list_access) or the link URL.') } },
    run(app, actor, a) {
      const l = app.docs.revokeLink(need(a, 'link'), actor);
      return text(`Revoked link ${l.id} (${l.audience === 'anyone' ? 'anyone' : 'members'} as ${l.role}); ${l.holders} ${l.holders === 1 ? 'person' : 'people'} had opened it.`);
    },
  },

  // ------------------------------------------------------------------ docs.watch
  {
    name: 'watch', featureSet: 'docs.watch', toolClass: 'control',
    description: [
      'Set your own wake gates for a document, or for all documents with document: "*". Each kind of activity is wake (deliver and wake you), quiet (deliver into your context without waking you) or off.',
      'Edits arrive as a diff of what others changed since you last looked (never your own edits), rendered when you are about to see it. A first watch without options means edits: quiet, comments: wake, from: humans.',
      'Gates that keep an edit from waking you (it is then delivered quietly): from (whose activity counts), min_chars, sections, keywords, cooldown_seconds, quiet_until. settle_seconds waits for typing to pause.',
      '@mentions and assignments always reach you (mentions: wake|quiet); replies in your threads follow replies.',
    ].join('\n'),
    inputSchema: { type: 'object', required: ['document'], properties: {
      document: S('Document id, or "*" for your defaults across all documents.'),
      edits: { ...LEVEL, description: 'Others\' edits to the text.' },
      comments: { ...LEVEL, description: 'Comment activity not addressed to you.' },
      mentions: { type: 'string', enum: ['wake', 'quiet'], description: '@mentions and assignments.' },
      replies: { ...LEVEL, description: 'Replies in threads you started or joined.' },
      shares: { ...LEVEL, description: 'Documents shared with you (document "*").' },
      from: { description: 'anyone | humans | agents | list of names/ids. Others\' activity is quiet.', anyOf: [{ type: 'string', enum: ['anyone', 'humans', 'agents'] }, { type: 'array', items: { type: 'string' } }] },
      guests: { ...LEVEL, description: 'Activity by guests (people who opened an "anyone with the link" link without signing in). quiet (default): delivered, never wakes you; wake: counts as human for from; off: never delivered on its own.' },
      min_chars: { type: 'integer', minimum: 0, description: 'Edits smaller than this stay quiet.' },
      sections: { type: 'array', items: { type: 'string' }, description: 'Only edits under these headings wake you.' },
      keywords: { type: 'array', items: { type: 'string' }, description: 'Only edits whose inserted text contains one of these words/phrases (case-insensitive) wake you. [] clears.' },
      settle_seconds: { type: 'number', minimum: 0, maximum: 3600, description: 'Quiet period before notifying (default 10).' },
      cooldown_seconds: { type: 'number', minimum: 0, maximum: 86400, description: 'After an edit wake, stay quiet for this long.' },
      quiet_until: { type: ['string', 'null'], description: 'ISO time; nothing wakes you before it. null clears.' },
    } },
    run(app, actor, a) {
      const id = need(a, 'document');
      if (id !== '*') app.docs.require(id, actor, 'viewer');
      const { document: _d, ...patch } = a;
      const eff = app.attention.setWatch(actor.sub, id, patch, { preset: true });
      if (id !== '*' && !app.attention.baseline(actor.sub, id)) app.attention.markRead(actor.sub, id, { comments: true });
      return text(`${id === '*' ? 'Your defaults for all documents' : `Watching ${id}`}: ${describeSettings(eff)}.`);
    },
  },
  {
    name: 'unwatch', featureSet: 'docs.watch', toolClass: 'control',
    description: 'Stop watching a document (mentions and replies still reach you per your defaults). document: "*" resets your defaults.',
    inputSchema: { type: 'object', required: ['document'], properties: { document: S('Document id or "*".') } },
    run(app, actor, a) {
      const removed = app.attention.unwatch(actor.sub, need(a, 'document'));
      return text(removed ? `Stopped watching ${a.document}. Effective now: ${describeSettings(app.attention.settings(actor.sub, a.document))}.` : `You were not watching ${a.document}.`);
    },
  },
  {
    name: 'list_watches', featureSet: 'docs.watch', toolClass: 'control',
    description: 'Your wake gates: defaults ("*") and each watched document\'s effective settings.',
    inputSchema: { type: 'object', properties: {} },
    run(app, actor) {
      const ws = app.attention.watches(actor.sub);
      const star = app.attention.settings(actor.sub, '*');
      const lines = [`Defaults (*): ${describeSettings(star)}`];
      for (const w of ws.filter((x) => x.docId !== '*')) {
        const d = app.docs.role(w.docId, actor) ? app.docs.get(w.docId) : null;
        lines.push(`${w.docId}  ${d ? `“${d.title}”` : '(no access)'}: ${describeSettings(app.attention.settings(actor.sub, w.docId))}`);
      }
      if (ws.filter((x) => x.docId !== '*').length === 0) lines.push(`No documents watched. watch {"document": "<id>"} starts with ${JSON.stringify(WATCH_PRESET)}.`);
      void BASE_SETTINGS;
      return text(lines.join('\n'));
    },
  },
];

export const TOOL_INDEX = new Map(TOOLS.map((t) => [t.name, t]));

/** Run a tool by name for an actor; faults become isError results. */
export async function runTool(app: App, actor: Actor, name: string, args: unknown): Promise<ToolResult> {
  const tool = TOOL_INDEX.get(name);
  if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${name}.` }] };
  try {
    const a = (args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {}) as Record<string, any>;
    normalizeDocumentArg(app, actor, a);
    return await tool.run(app, actor, a);
  } catch (e) {
    if (e instanceof Fault) return { isError: true, content: [{ type: 'text', text: e.message }] };
    console.error(`[tools] ${name} failed:`, e);
    return { isError: true, content: [{ type: 'text', text: `${name} failed because of an internal error. Try again, or report it.` }] };
  }
}

export { atLeast };
