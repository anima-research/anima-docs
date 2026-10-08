// JSON API client and the shapes the server returns.

export type Kind = 'human' | 'agent' | 'service' | 'guest';
export type Role = 'viewer' | 'commenter' | 'editor' | 'owner';
export type GeneralAccess = 'restricted' | 'viewer' | 'commenter' | 'editor';

export interface Me { sub: string; name: string; kind: Kind; color: string; admin: boolean; issuer: string }
export interface Config { audience: string; issuer: string | null; dev: boolean; origin: string }

export interface Presence { name: string; kind: Kind; color: string }

/** Guests: people who opened an "anyone with the link" share link without signing in. */
export const isGuestMe = (me: Pick<Me, 'kind'> | null | undefined) => me?.kind === 'guest';

export interface DocSummary {
  id: string;
  title: string;
  owner: { sub: string; label: string; kind?: Kind; color?: string };
  generalAccess: GeneralAccess;
  role: Role;
  rev: number;
  updatedAt: number;
  createdAt: number;
  openComments: number;
  present: Presence[];
  /** An active "anyone with the link" share link exists. */
  publicLink?: boolean;
}

export interface AclEntry { sub: string; role: Role; label: string; kind?: Kind; name?: string; grantedBy: string; grantedAt: number }
export interface DocDetail extends DocSummary { acl: AclEntry[] }

export interface Person { sub: string; name: string; kind: Kind; color: string; label: string; issuer: string; role: 'member' | 'admin' | 'blocked'; lastSeen: number }
export interface AdminPrincipal extends Person { firstSeen: number; docs: number; watches: number }

export interface Version { id: string; name: string; rev: number; createdBy: string; createdAt: number; by: string }
export interface ActivityRow { sub: string; label: string; kind?: Kind; color?: string; minute: number; added: number; removed: number }
/** An agent that can open a document (for pinging). */
export interface PingableAgent { sub: string; name: string; kind: Kind; color: string; online: boolean }
/** A recorded change: the end of one stretch of editing (history.ts). */
export interface Checkpoint {
  seq: number;
  start: number;
  end: number;
  authors: { sub: string; name: string; kind: Kind; color: string }[];
  added: number;
  removed: number;
  label: string | null;
  /** Where the recorded history begins (no change of its own). */
  baseline: boolean;
}

export interface ThreadPerson { sub: string; name: string; kind: Kind; color: string; label: string }
export interface ThreadComment { id: string; author: ThreadPerson; body: string; createdAt: number; editedAt: number | null; mentions: string[] }
export interface Thread {
  id: string;
  rel: { start: string; end: string } | null;
  quote: string | null;
  orphaned: boolean;
  resolved: boolean;
  resolvedBy: ThreadPerson | null;
  assignee: ThreadPerson | null;
  comments: ThreadComment[];
  /** Set when the thread is a suggestion: replace the anchored original with text. */
  suggestion: ThreadSuggestion | null;
}
export interface ThreadSuggestion {
  original: string;
  text: string;
  status: 'open' | 'accepted' | 'rejected';
  /** The anchored text no longer matches the original: it can only be rejected. */
  outdated: boolean;
  /** An insertion at a point (no original text). */
  point: boolean;
  /** Changes when the author revises it; accepting names the version you saw. */
  version: string;
}

export type LinkWho = 'anyone' | 'members';
export type LinkRole = 'viewer' | 'commenter' | 'editor';
export interface ShareLink {
  id: string;
  url: string;
  role: LinkRole;
  who: LinkWho;
  label: string | null;
  createdBy: { sub: string; label: string };
  createdAt: number;
  expiresAt: number | null;
  /** How many people (or agents) have opened it. */
  holders: number;
  active: boolean;
}
export interface LinkPeek { active: boolean; audience?: LinkWho; role?: LinkRole; title?: string; signedIn: boolean; guest: boolean }
export interface Redeemed { docId: string; title: string; role: Role; guest: boolean; you: Me }

export interface MediaInfo { id: string; mime: string; size: number; width: number | null; height: number | null; url: string }

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function call<T>(method: string, path: string, body?: unknown, init: RequestInit = {}, opts: { quiet401?: boolean } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined && !(body instanceof Blob) ? { 'Content-Type': 'application/json' } : init.headers,
      body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
      ...init,
    });
  } catch {
    throw new ApiError(0, 'Could not reach the server. Check your connection.');
  }
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('application/json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const msg = typeof data === 'object' && data && 'error' in data ? String((data as { error: unknown }).error) : `Request failed (${res.status}).`;
    if (res.status === 401 && onUnauthorized && !opts.quiet401) onUnauthorized();
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }
/** The session ended (e.g. a realtime socket closed with 4001): show sign-in. */
export function signalUnauthorized() { onUnauthorized?.(); }

const q = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) s.set(k, v);
  const str = s.toString();
  return str ? `?${str}` : '';
};

export const api = {
  config: () => call<Config>('GET', '/api/config'),
  me: () => call<{ you: Me | null; guest?: boolean; dev: boolean }>('GET', '/api/me'),
  devLogin: (name: string, admin: boolean) => call<{ you: Me }>('POST', '/dev/login', { name, admin }),
  exchange: (token: string, state?: string | null) => call<{ you: Me }>('POST', '/auth/exchange', state ? { token, state } : { token }),
  logout: () => call<{ ok: true }>('POST', '/auth/logout', {}),

  docs: (opts: { q?: string; filter?: 'all' | 'owned' | 'shared' } = {}) => call<{ docs: DocSummary[] }>('GET', `/api/docs${q({ q: opts.q, filter: opts.filter })}`),
  createDoc: (title: string, content?: string) => call<DocSummary>('POST', '/api/docs', { title, content }),
  doc: (id: string) => call<DocDetail>('GET', `/api/docs/${encodeURIComponent(id)}`),
  patchDoc: (id: string, patch: { title?: string; generalAccess?: GeneralAccess }) => call<DocSummary>('PATCH', `/api/docs/${encodeURIComponent(id)}`, patch),
  deleteDoc: (id: string) => call<{ ok: true }>('DELETE', `/api/docs/${encodeURIComponent(id)}`),
  share: (id: string, who: string, role: Role | 'none') => call<{ ok: true }>('POST', `/api/docs/${encodeURIComponent(id)}/share`, { who, role }),
  versions: (id: string) => call<{ versions: Version[] }>('GET', `/api/docs/${encodeURIComponent(id)}/versions`),
  saveVersion: (id: string, name: string) => call<{ id: string; rev: number }>('POST', `/api/docs/${encodeURIComponent(id)}/versions`, { name }),
  version: (id: string, vid: string) => call<{ text: string }>('GET', `/api/docs/${encodeURIComponent(id)}/versions/${encodeURIComponent(vid)}`),
  restoreVersion: (id: string, vid: string) => call<{ ok: true }>('POST', `/api/docs/${encodeURIComponent(id)}/versions/${encodeURIComponent(vid)}/restore`, {}),
  activity: (id: string) => call<{ activity: ActivityRow[] }>('GET', `/api/docs/${encodeURIComponent(id)}/activity`),
  agents: (id: string) => call<{ agents: PingableAgent[] }>('GET', `/api/docs/${encodeURIComponent(id)}/agents`),
  ping: (id: string, body: { who: string; message?: string; quote?: string; line?: number }) => call<{ delivered: boolean; online: boolean }>('POST', `/api/docs/${encodeURIComponent(id)}/ping`, body),
  history: (id: string, before?: number) => call<{ checkpoints: Checkpoint[]; more: boolean }>('GET', `/api/docs/${encodeURIComponent(id)}/history${before ? `?before=${before}` : ''}`),
  compare: (id: string, from: number, to: number | 'now') => call<{ before: string; after: string }>('GET', `/api/docs/${encodeURIComponent(id)}/history/compare?from=${from}&to=${to}`),
  restoreChange: (id: string, seq: number, at: 'before' | 'after') => call<{ ok: true }>('POST', `/api/docs/${encodeURIComponent(id)}/history/${seq}/restore`, { at }),
  undoChange: (id: string, seq: number) => call<{ ok: true }>('POST', `/api/docs/${encodeURIComponent(id)}/history/${seq}/undo`, {}),
  exportUrl: (id: string) => `/api/docs/${encodeURIComponent(id)}/export.md`,

  links: (id: string) => call<{ links: ShareLink[] }>('GET', `/api/docs/${encodeURIComponent(id)}/links`),
  createLink: (id: string, opts: { role: LinkRole; who: LinkWho; label?: string; expiresInDays?: number }) => call<ShareLink>('POST', `/api/docs/${encodeURIComponent(id)}/links`, opts),
  revokeLink: (id: string, linkId: string) => call<ShareLink>('DELETE', `/api/docs/${encodeURIComponent(id)}/links/${encodeURIComponent(linkId)}`),
  /** What a share link leads to (no sign-in needed). */
  peekLink: (key: string) => call<LinkPeek>('GET', `/api/links/${encodeURIComponent(key)}`),
  /** Open a share link; signed-out visitors on an "anyone" link become guests. A 401 here is an answer, not a lost session. */
  redeemLink: (key: string, name?: string) => call<Redeemed>('POST', '/api/links/redeem', name ? { key, name } : { key }, {}, { quiet401: true }),
  renameGuest: (name: string) => call<{ you: Me }>('POST', '/api/guest/name', { name }),

  people: (query?: string) => call<{ people: Person[] }>('GET', `/api/people${q({ q: query })}`),
  watches: () => call<{ watches: { docId: string; settings: Record<string, unknown>; updatedAt: number }[]; defaults: Record<string, unknown> }>('GET', '/api/watches'),
  adminPrincipals: (opts: { guests?: boolean } = {}) => call<{ principals: AdminPrincipal[] }>('GET', `/api/admin/principals${q({ guests: opts.guests ? '1' : undefined })}`),
  setPrincipalRole: (sub: string, role: 'member' | 'admin' | 'blocked') => call<Person>('POST', `/api/admin/principals/${encodeURIComponent(sub)}`, { role }),

  upload: (docId: string, file: Blob) => call<MediaInfo>('POST', `/api/media?doc=${encodeURIComponent(docId)}`, file, { headers: { 'Content-Type': file.type || 'application/octet-stream' } }),
};

export const ROLE_LABEL: Record<Role, string> = { viewer: 'Viewer', commenter: 'Commenter', editor: 'Editor', owner: 'Owner' };
export const RANK: Record<Role, number> = { viewer: 1, commenter: 2, editor: 3, owner: 4 };
export const atLeast = (role: Role | null | undefined, min: Role) => !!role && RANK[role] >= RANK[min];
/** "view" / "comment" / "edit": what a role lets you do. */
export const ROLE_VERB: Record<Role, string> = { viewer: 'view', commenter: 'comment', editor: 'edit', owner: 'edit' };
