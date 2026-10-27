// Finding quoted text in a source document (markdown or HTML) when the quote
// comes from a rendered page: whitespace collapses, entities decode, tags
// vanish. The index maps each normalized character back to its source offset.

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export interface Indexed { text: string; /** source offset of normalized char i */ from: number[]; /** source offset just after normalized char i */ to: number[] }

export interface IndexOptions { /** drop tags and script/style bodies (default true) */ html?: boolean; /** drop markdown syntax: block markers, emphasis, links, code fences */ markdown?: boolean }

// Markdown block markers at the start of a line: indentation, blockquote `>`, list bullets, headings, table pipes.
const MD_LINE_START = /^(?:[ \t]*>[ \t]?|[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|[ \t]*#{1,6}[ \t]+|[ \t]*\|[ \t]*|[ \t]+)/;
// Lines that are not text at all: fences, thematic breaks, table rules, heading underlines, html comments.
const MD_NOISE_LINE = /^[ \t]*(?:(?:`{3,}|~{3,})[^\n]*|(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?|={3,}|<!--[^\n]*-->)[ \t]*$/;

/** Normalize a source: drop tags (and script/style bodies when `html`), decode entities, collapse whitespace. */
export function indexSource(src: string, options: boolean | IndexOptions = true): Indexed {
  const opts = typeof options === 'boolean' ? { html: options } : options;
  const html = opts.html ?? true, md = !!opts.markdown;
  let text = '';
  const from: number[] = [], to: number[] = [];
  let space = true;
  const push = (ch: string, a: number, b: number) => {
    if (/\s/.test(ch)) { if (space) return; text += ' '; from.push(a); to.push(b); space = true; }
    else { text += ch; from.push(a); to.push(b); space = false; }
  };
  // A tag reads as whitespace (block boundaries become breaks on the page; inline tags sit between words).
  const gap = (at: number) => { if (!space) { text += ' '; from.push(at); to.push(at); space = true; } };
  let inFence: string | null = null;
  for (let i = 0; i < src.length; i++) {
    if (md && (i === 0 || src[i - 1] === '\n')) {
      // At a line start: fence bodies are text as they are; marker-only lines vanish; block markers are skipped.
      const eol = src.indexOf('\n', i); const line = src.slice(i, eol < 0 ? src.length : eol);
      const fence = /^[ \t]*(`{3,}|~{3,})/.exec(line);
      if (inFence) { if (fence && fence[1][0] === inFence[0] && fence[1].length >= inFence.length) { inFence = null; gap(i); i += line.length; } }
      else if (fence) { inFence = fence[1]; gap(i); i += line.length; continue; }
      else if (MD_NOISE_LINE.test(line) && line.trim()) { gap(i); i += line.length; continue; }
      else {
        let rest = line, skipped = 0, m: RegExpExecArray | null;
        while ((m = MD_LINE_START.exec(rest)) && m[0].length) { skipped += m[0].length; rest = rest.slice(m[0].length); }
        if (skipped) { gap(i); i += skipped; }
        if (i >= src.length) break;
      }
      if (inFence) { push(src[i], i, i + 1); continue; }
    }
    const c = src[i];
    if (md && !inFence) {
      const rest = src.slice(i, i + 3);
      if (c === '\\' && i + 1 < src.length && /[\\`*_{}\[\]()#+\-.!|~<>]/.test(src[i + 1])) { push(src[i + 1], i, i + 2); i += 1; continue; } // escape: the character itself
      if (rest.startsWith('**') || rest.startsWith('__') || rest.startsWith('~~')) { i += 1; continue; } // emphasis markers vanish, no gap: **cat** reads cat
      if (c === '`') { let n = i; while (src[n] === '`') n++; i = n - 1; continue; } // code spans keep their text, lose the ticks
      if ((c === '*' || c === '_') && (/\S/.test(src[i + 1] ?? ' ') || /\S/.test(src[i - 1] ?? ' '))) continue;
      if (c === '!' && src[i + 1] === '[') { // an image: its alt text is not on the page as text (a caption may be; keep the alt)
        const close = src.indexOf('](', i); const end = close >= 0 ? src.indexOf(')', close) : -1;
        if (end >= 0) { gap(i); i = end; continue; }
      }
      if (c === '[') { gap(i); continue; } // link text follows; the bracket is not text
      if (c === ']' && src[i + 1] === '(') { const end = src.indexOf(')', i); if (end >= 0) { gap(i); i = end; continue; } } // (url) vanishes
      if (c === ']' && src[i + 1] === '[') { const end = src.indexOf(']', i + 2); if (end >= 0) { gap(i); i = end; continue; } } // [ref] vanishes
      if (c === ']') { gap(i); continue; }
      if (c === '|') { gap(i); continue; } // table cell boundaries
      if (c === '$') continue; // math delimiters; the formula's letters remain findable
      if (c === '<' && /^<[A-Za-z/!][^>]*>/.test(src.slice(i, i + 200))) { const end = src.indexOf('>', i); gap(i); i = end; continue; } // inline html
    }
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
export function findQuote(src: string, quote: string, prefix?: string | null, suffix?: string | null, opts: { html?: boolean; markdown?: boolean; near?: number } = {}): { from: number; to: number } | null {
  const idx = indexSource(src, { html: opts.html ?? true, markdown: opts.markdown });
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
