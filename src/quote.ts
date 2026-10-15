// Finding quoted text in a source document (markdown or HTML) when the quote
// comes from a rendered page: whitespace collapses, entities decode, tags
// vanish. The index maps each normalized character back to its source offset.

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export interface Indexed { text: string; /** source offset of normalized char i */ from: number[]; /** source offset just after normalized char i */ to: number[] }

/** Normalize a source: drop tags (and script/style bodies when `html`), decode entities, collapse whitespace. */
export function indexSource(src: string, html = true): Indexed {
  let text = '';
  const from: number[] = [], to: number[] = [];
  let space = true;
  const push = (ch: string, a: number, b: number) => {
    if (/\s/.test(ch)) { if (space) return; text += ' '; from.push(a); to.push(b); space = true; }
    else { text += ch; from.push(a); to.push(b); space = false; }
  };
  // A tag reads as whitespace (block boundaries become breaks on the page; inline tags sit between words).
  const gap = (at: number) => { if (!space) { text += ' '; from.push(at); to.push(at); space = true; } };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (html && c === '<') {
      const m = /^<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/i.exec(src.slice(i));
      if (m) { gap(i); i += m[0].length - 1; continue; }
      const end = src.indexOf('>', i);
      if (end > i && /^<\/?[A-Za-z!?]/.test(src.slice(i, i + 3))) { gap(i); i = end; continue; }
    }
    if (c === '&') {
      const m = /^&(#x[0-9a-f]+|#\d+|[a-z]+);/i.exec(src.slice(i, i + 12));
      if (m) {
        const body = m[1];
        const ch = body[0] === '#' ? String.fromCodePoint(parseInt(body[1].toLowerCase() === 'x' ? body.slice(2) : body.slice(1), body[1].toLowerCase() === 'x' ? 16 : 10)) : ENTITIES[body.toLowerCase()];
        if (ch !== undefined) { push(ch, i, i + m[0].length); i += m[0].length - 1; continue; }
      }
    }
    push(c, i, i + 1);
  }
  return { text, from, to };
}

const norm = (s: string) => String(s ?? '').replace(/\s+/g, ' ');

/**
 * Where a quote (as seen on the page) sits in the source. Prefix/suffix (text
 * around the quote on the page) choose between repeats; `near` breaks ties.
 */
export function findQuote(src: string, quote: string, prefix?: string | null, suffix?: string | null, opts: { html?: boolean; near?: number } = {}): { from: number; to: number } | null {
  const idx = indexSource(src, opts.html ?? true);
  const q = norm(quote).trim();
  if (!q) return null;
  let best: number | null = null, bestScore = -1, at = -1;
  while ((at = idx.text.indexOf(q, at + 1)) >= 0) {
    let score = 0;
    if (prefix) { const p = norm(prefix); const before = idx.text.slice(Math.max(0, at - p.length), at); if (before === p) score += 4; else if (before.trim().slice(-12) === p.trim().slice(-12)) score += 2; }
    if (suffix) { const sf = norm(suffix); const after = idx.text.slice(at + q.length, at + q.length + sf.length); if (after === sf) score += 4; else if (after.trim().slice(0, 12) === sf.trim().slice(0, 12)) score += 2; }
    if (typeof opts.near === 'number') score += 1 / (1 + Math.abs(idx.from[at] - opts.near) / 200);
    if (score > bestScore) { bestScore = score; best = at; }
  }
  if (best === null) return null;
  return { from: idx.from[best], to: idx.to[best + q.length - 1] };
}
