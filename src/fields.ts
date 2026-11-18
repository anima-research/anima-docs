// Signature and initials fields: a comment thread that marks a place on a page
// of a PDF in a file collection where someone is asked to sign or to initial.
// The thread is the request (assign it, mention in it); the person signs in the
// browser (web/pdfsign.ts), the file gets a new version, and the thread is
// answered and resolved. Nothing here ever touches anyone's signature.
//
// A field's box is in fractions of the page as it is shown (upright, origin at
// the top left): the same numbers whatever the zoom, and whatever the page's
// own units and rotation.

import { Fault } from './auth.js';
import type { App } from './app.js';
import { COLLECTION, type DocFile } from './files.js';

export type FieldKind = 'signature' | 'initials';
export interface FileField { kind: FieldKind; path: string; page: number; x: number; y: number; w: number; h: number }

/** The size a field gets when only its place is given, in points (1/72 inch). */
const SIZE: Record<FieldKind, { w: number; h: number }> = { signature: { w: 170, h: 44 }, initials: { w: 64, h: 36 } };
export const FIELD_WORD: Record<FieldKind, string> = { signature: 'Signature', initials: 'Initials' };

const frac = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : NaN);

/** A field as stored: checked, and kept inside its page. */
export function cleanField(f: unknown): FileField {
  const o = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
  const kind = o.kind === 'initials' ? 'initials' : o.kind === 'signature' ? 'signature' : null;
  const page = Number(o.page);
  const x = frac(o.x), y = frac(o.y);
  let w = frac(o.w), h = frac(o.h);
  if (!kind || typeof o.path !== 'string' || !o.path || !Number.isInteger(page) || page < 1 || [x, y, w, h].some(Number.isNaN) || w < 0.005 || h < 0.003) {
    throw new Fault(400, 'A field needs a kind (signature or initials), a file, a page and a box inside the page.');
  }
  w = Math.min(w, 1 - x); h = Math.min(h, 1 - y);
  const r = (n: number) => Math.round(n * 1e5) / 1e5;
  return { kind, path: o.path, page, x: r(x), y: r(y), w: r(w), h: r(h) };
}

/** The PDF a field is on: a file of a collection. */
export function fieldFile(app: App, docId: string, path: string): DocFile {
  if (app.docs.get(docId)?.type !== COLLECTION) throw new Fault(400, 'Signature and initials fields go on PDFs in a file collection.');
  const f = app.files.get(docId, app.files.path(docId, path));
  if (!f) throw new Fault(404, `No file ${path} in this collection.`);
  if (f.mime !== 'application/pdf') throw new Fault(400, `${f.path} is not a PDF.`);
  return f;
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Where a field goes when an agent names the words it belongs beside ("Signature:", "Initial here"): to the
 * right of them on their line when there is room, otherwise just below. Agents cannot see the page; they can
 * read its text.
 */
export async function placeField(app: App, docId: string, p: { kind: FieldKind; path: string; near: string; page?: number; occurrence?: number }): Promise<FileField> {
  const f = fieldFile(app, docId, p.path);
  const at = app.media.locate(f.mediaId);
  const pages = at ? await app.pdf.words(at.file, p.page) : null;
  if (!pages) throw new Fault(409, `The text of ${f.path} cannot be read here, so a field cannot be placed by its words: give page and box.`);
  const want = p.near.split(/\s+/).map(norm).filter(Boolean);
  if (!want.length) throw new Fault(400, 'near is the text the field belongs beside, e.g. "Signature:".');
  let seen = 0;
  for (const pg of pages) {
    for (let i = 0; i + want.length <= pg.words.length; i++) {
      // The words in a row; the last may run on ("Signature:____").
      if (!want.every((w, k) => (k === want.length - 1 ? norm(pg.words[i + k].text).startsWith(w) : norm(pg.words[i + k].text) === w))) continue;
      if (++seen < (p.occurrence ?? 1)) continue;
      const hit = pg.words.slice(i, i + want.length);
      const x0 = Math.min(...hit.map((w) => w.x0)), x1 = Math.max(...hit.map((w) => w.x1)), y1 = Math.max(...hit.map((w) => w.y1));
      const size = SIZE[p.kind];
      const beside = x1 + 8 + size.w <= pg.width - 18;
      const x = beside ? x1 + 8 : Math.min(x0, pg.width - size.w - 18);
      const y = beside ? y1 - size.h + 6 : y1 + 6;
      return cleanField({ kind: p.kind, path: f.path, page: pg.page, x: Math.max(0, x) / pg.width, y: Math.max(0, y) / pg.height, w: size.w / pg.width, h: size.h / pg.height });
    }
  }
  throw new Fault(404, seen ? `“${p.near}” appears ${seen} time${seen === 1 ? '' : 's'}${p.page ? ` on page ${p.page}` : ''} of ${f.path}, not ${p.occurrence}.` : `“${p.near}” is not in the text of ${f.path}${p.page ? ` on page ${p.page}` : ''} (read_file shows its text by page). Give page and box instead if the page is a scan.`);
}

/** A field given by its box: the page must exist (when the PDF can be read here). */
export async function boxField(app: App, docId: string, p: { kind: FieldKind; path: string; page: number; box: unknown }): Promise<FileField> {
  const f = fieldFile(app, docId, p.path);
  const b = Array.isArray(p.box) ? p.box : [];
  const field = cleanField({ kind: p.kind, path: f.path, page: p.page, x: b[0], y: b[1], w: b[2], h: b[3] });
  const at = app.media.locate(f.mediaId);
  const pages = at ? await app.pdf.pages(f.mediaId, at.file) : null;
  if (pages && field.page > pages.length) throw new Fault(400, `${f.path} has ${pages.length} page${pages.length === 1 ? '' : 's'}; there is no page ${field.page}.`);
  return field;
}

/** One line saying where a field is, for an agent. */
export function describeField(f: FileField): string {
  return `${FIELD_WORD[f.kind]} field on page ${f.page} of ${f.path}`;
}
