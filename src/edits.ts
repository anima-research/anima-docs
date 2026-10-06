// Agent edits: anchored by content, applied atomically, minimal at the character level.
//
// Content anchors (exact text) survive concurrent typing elsewhere in the
// document; line numbers do not. Every edit is validated against the text as
// it stands after the previous edits in the same call, and if any edit fails
// nothing is applied.

import * as Y from 'yjs';
import { Fault } from './auth.js';
import { Documents, MAX_DOC_CHARS } from './documents.js';
import { findSections, lineOf, lineStarts, occurrences } from './markdown.js';

export type AgentEdit =
  | { old_text: string; new_text: string; occurrence?: number; replace_all?: boolean }
  | { insert_after: string; text: string; occurrence?: number }
  | { insert_before: string; text: string; occurrence?: number }
  | { append: string }
  | { prepend: string }
  | { replace_section: string; content: string; keep_heading?: boolean }
  | { append_to_section: string; text: string }
  | { replace_all_content: string };

interface Planned { from: number; to: number; text: string; label: string }

const MAX_REPLACE_ALL = 2000;

/** Apply non-overlapping replacements to a string in one pass. */
function splice(text: string, p: Planned[]): string {
  const asc = [...p].sort((a, b) => a.from - b.from);
  let out = '', at = 0;
  for (const s of asc) { out += text.slice(at, s.from) + s.text; at = s.to; }
  return out + text.slice(at);
}

export interface EditReport { applied: string[]; lines: string[] }

function pick(hits: number[], text: string, what: string, occurrence: number | undefined, i: number): number {
  if (!hits.length) throw new Fault(404, `Edit ${i + 1}: ${what} not found. It must match the document exactly (whitespace included) — re-read the document if it changed.`);
  if (occurrence !== undefined) {
    if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > hits.length) throw new Fault(400, `Edit ${i + 1}: occurrence must be between 1 and ${hits.length}.`);
    return hits[occurrence - 1];
  }
  if (hits.length > 1) {
    const starts = lineStarts(text);
    throw new Fault(409, `Edit ${i + 1}: ${what} occurs ${hits.length} times (lines ${hits.slice(0, 12).map((h) => lineOf(starts, h)).join(', ')}). Include more surrounding text, pass occurrence (1-based), or replace_all: true.`);
  }
  return hits[0];
}

function plan(text: string, e: AgentEdit, i: number): Planned[] {
  const str = (v: unknown, name: string) => {
    if (typeof v !== 'string') throw new Fault(400, `Edit ${i + 1}: ${name} must be a string.`);
    return v;
  };
  if ('old_text' in e) {
    const oldText = str(e.old_text, 'old_text'), newText = str(e.new_text, 'new_text');
    if (!oldText) throw new Fault(400, `Edit ${i + 1}: old_text must be non-empty (use insert_after/append to add text).`);
    const hits = occurrences(text, oldText);
    if (e.replace_all) {
      if (!hits.length) throw new Fault(404, `Edit ${i + 1}: old_text not found.`);
      if (hits.length > MAX_REPLACE_ALL) throw new Fault(413, `Edit ${i + 1}: old_text occurs ${hits.length} times; replace_all is limited to ${MAX_REPLACE_ALL}.`);
      // Non-overlapping, left to right.
      const out: Planned[] = [];
      let last = -1;
      for (const h of hits) if (h >= last) { out.push({ from: h, to: h + oldText.length, text: newText, label: 'replace' }); last = h + oldText.length; }
      return out;
    }
    const at = pick(hits, text, 'old_text', e.occurrence, i);
    return [{ from: at, to: at + oldText.length, text: newText, label: 'replace' }];
  }
  if ('insert_after' in e || 'insert_before' in e) {
    const after = 'insert_after' in e;
    const anchor = str(after ? (e as any).insert_after : (e as any).insert_before, after ? 'insert_after' : 'insert_before');
    const add = str((e as any).text, 'text');
    const at = pick(occurrences(text, anchor), text, after ? 'insert_after text' : 'insert_before text', (e as any).occurrence, i);
    const pos = after ? at + anchor.length : at;
    return [{ from: pos, to: pos, text: add, label: 'insert' }];
  }
  if ('append' in e) {
    const add = str(e.append, 'append');
    const sep = text.length && !text.endsWith('\n') && !add.startsWith('\n') ? '\n' : '';
    return [{ from: text.length, to: text.length, text: sep + add, label: 'append' }];
  }
  if ('prepend' in e) {
    const add = str(e.prepend, 'prepend');
    const sep = text.length && !add.endsWith('\n') ? '\n' : '';
    return [{ from: 0, to: 0, text: add + sep, label: 'prepend' }];
  }
  if ('replace_section' in e) {
    const ref = str(e.replace_section, 'replace_section');
    const content = str(e.content, 'content');
    const sec = pickSection(text, ref, i);
    const from = e.keep_heading === false ? sec.start : sec.bodyStart;
    let body = content;
    if (sec.end < text.length && body && !body.endsWith('\n')) body += '\n';
    if (sec.end < text.length && !body.endsWith('\n\n') && body) body += '\n';
    return [{ from, to: sec.end, text: body, label: 'replace section' }];
  }
  if ('append_to_section' in e) {
    const ref = str(e.append_to_section, 'append_to_section');
    const add = str(e.text, 'text');
    const sec = pickSection(text, ref, i);
    // Insert after the section's last non-blank line.
    let end = sec.end;
    while (end > sec.bodyStart && /\s/.test(text[end - 1])) end--;
    const pos = end;
    const prefix = pos > 0 && text[pos - 1] !== '\n' ? '\n' : '';
    return [{ from: pos, to: pos, text: prefix + add.replace(/\n+$/, ''), label: 'append to section' }];
  }
  if ('replace_all_content' in e) {
    return [{ from: 0, to: text.length, text: str(e.replace_all_content, 'replace_all_content'), label: 'rewrite' }];
  }
  throw new Fault(400, `Edit ${i + 1}: unrecognized edit. Use one of old_text/new_text, insert_after, insert_before, append, prepend, replace_section, append_to_section, replace_all_content.`);
}

function pickSection(text: string, ref: string, i: number) {
  const secs = findSections(text, ref);
  if (!secs.length) throw new Fault(404, `Edit ${i + 1}: no heading matching "${ref}". Use outline to see headings; "Parent > Child" disambiguates.`);
  if (secs.length > 1) throw new Fault(409, `Edit ${i + 1}: "${ref}" matches ${secs.length} headings (lines ${secs.map((s) => s.heading.line).join(', ')}). Use "Parent > Child" or the #-level ("## ${ref}").`);
  return secs[0];
}

/**
 * Validate and apply edits for an actor. Returns a report with the line span
 * of each change and a short excerpt of the result.
 */
export function applyEdits(docs: Documents, docId: string, actor: { sub: string; via?: 'mcpl' | 'http' | 'web' }, edits: AgentEdit[]):
  { report: EditReport; client: number; deleteSet: import('./documents.js').DeleteSet } {
  if (!Array.isArray(edits) || !edits.length) throw new Fault(400, 'edits must be a non-empty list.');
  if (edits.length > 100) throw new Fault(400, 'At most 100 edits per call.');

  // Dry run on a string first, so a failing edit applies nothing.
  let text = docs.text(docId);
  const steps: { before: string; plan: Planned[] }[] = [];
  for (let i = 0; i < edits.length; i++) {
    const p = plan(text, edits[i], i).sort((a, b) => b.from - a.from);
    steps.push({ before: text, plan: p });
    text = splice(text, p);
  }
  if (text.length > MAX_DOC_CHARS) throw new Fault(413, `Document would exceed ${MAX_DOC_CHARS.toLocaleString('en')} characters.`);

  const report: EditReport = { applied: [], lines: [] };
  // Where each edit landed, as relative positions: later edits in the same
  // call can shift text, so line numbers are only computed at the end.
  const landed: { label: string; count: number; start: Y.RelativePosition; end: Y.RelativePosition }[] = [];
  const { client, deleteSet } = docs.edit(docId, { sub: actor.sub, via: actor.via ?? 'mcpl' }, (ytext) => {
    // Inside one synchronous transaction the live text is exactly the dry run's text.
    for (const { before, plan: p } of steps) {
      if (p.length > 1) Documents.replaceEach(ytext, p.map((x) => x.from), before.slice(p[0].from, p[0].to), p[0].text);
      else Documents.replaceMinimal(ytext, p[0].from, p[0].to, p[0].text, before);
      // Applied highest-first: the lowest occurrence's start is unmoved; the
      // highest one's end moved by every lower occurrence's length change.
      const lowest = p[p.length - 1], highest = p[0];
      const shift = p.slice(1).reduce((n, x) => n + x.text.length - (x.to - x.from), 0);
      const start = lowest.from, end = Math.max(start, highest.from + shift + highest.text.length);
      landed.push({
        label: p[0].label, count: p.length,
        start: Y.createRelativePositionFromTypeIndex(ytext, start, 0),
        end: Y.createRelativePositionFromTypeIndex(ytext, end, -1),
      });
    }
  });
  const doc = docs.ydoc(docId);
  const final = doc.getText('body').toString();
  const starts = lineStarts(final);
  const lines = final.split('\n');
  landed.forEach((l, i) => {
    const s = Y.createAbsolutePositionFromRelativePosition(l.start, doc)?.index ?? 0;
    const e = Math.max(s, Y.createAbsolutePositionFromRelativePosition(l.end, doc)?.index ?? s);
    const a = lineOf(starts, s), b = lineOf(starts, Math.max(s, e - 1));
    report.applied.push(`${i + 1}. ${l.label}${l.count > 1 ? ` ×${l.count}` : ''} → line${a === b ? ` ${a}` : `s ${a}–${b}`}`);
    if (l.count === 1) {
      const excerpt = lines.slice(Math.max(0, a - 2), Math.min(lines.length, b + 1));
      report.lines.push(excerpt.map((t, k) => `${String(Math.max(1, a - 1) + k).padStart(5)}\t${t}`).join('\n'));
    }
  });
  return { report, client, deleteSet };
}
