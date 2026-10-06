// Markdown structure helpers: lines, headings, sections. Fenced code is skipped.

export interface Heading { level: number; text: string; line: number; offset: number }

export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** 1-based line containing `offset`. */
export function lineOf(starts: number[], offset: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

/** ATX heading ("## Title ##"), parsed without backtracking regexes (headings are user content). */
function atx(line: string): { level: number; text: string } | null {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  let j = i;
  while (j < line.length && line[j] === '#' && j - i < 7) j++;
  const level = j - i;
  if (level < 1 || level > 6) return null;
  if (j < line.length && line[j] !== ' ' && line[j] !== '\t') return null;
  let text = line.slice(j, j + 2000).trim();
  let k = text.length;
  while (k > 0 && text[k - 1] === '#') k--;
  if (k === 0) text = '';
  else if (k < text.length && (text[k - 1] === ' ' || text[k - 1] === '\t')) text = text.slice(0, k).trimEnd();
  return { level, text };
}

const isSetextUnderline = (line: string) => {
  if (line.length > 200) return null;
  const t = line.trim();
  if (!t || line.length - line.trimStart().length > 3) return null;
  if (/^=+$/.test(t)) return 1;
  if (/^-{2,}$/.test(t)) return 2;
  return null;
};

export function outline(text: string): Heading[] {
  const out: Heading[] = [];
  const lines = text.split('\n');
  let offset = 0;
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line.slice(0, 64));
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
    } else if (fence === null) {
      const h = atx(line);
      if (h) out.push({ level: h.level, text: h.text, line: i + 1, offset });
      else if (i > 0) {
        const lvl = isSetextUnderline(line);
        const prev = lines[i - 1];
        // Setext heading (underlined paragraph line); not after list items, headings, tables or blank lines.
        if (lvl && prev.trim() && prev.length <= 2000 && !/^ {0,3}([-*+]|\d+\.) /.test(prev) && !atx(prev) && !prev.trimStart().startsWith('|')) {
          out.push({ level: lvl, text: prev.trim(), line: i, offset: offset - prev.length - 1 });
        }
      }
    }
    offset += line.length + 1;
  }
  return out;
}

/** Heading path (outermost → innermost) enclosing `offset`. */
export function sectionPath(headings: Heading[], offset: number): string[] {
  const stack: Heading[] = [];
  for (const h of headings) {
    if (h.offset > offset) break;
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    stack.push(h);
  }
  return stack.map((h) => h.text);
}

export interface SectionRange { heading: Heading; start: number; bodyStart: number; end: number }

/**
 * Find a section by heading reference: "Goals", "## Goals", or a path
 * "Plan > Goals". Case-insensitive; exact text match preferred over prefix.
 */
export function findSections(text: string, ref: string): SectionRange[] {
  const headings = outline(text);
  const parts = ref.split('>').map((p) => p.trim().replace(/^#{1,6}\s*/, '').toLowerCase()).filter(Boolean);
  if (!parts.length) return [];
  const target = parts[parts.length - 1];
  const levelHint = /^\s*(#{1,6})\s/.exec(ref.split('>').pop() ?? '')?.[1].length;
  const matches = (h: Heading) => h.text.toLowerCase() === target && (!levelHint || h.level === levelHint);
  const result: SectionRange[] = [];
  headings.forEach((h, i) => {
    if (!matches(h)) return;
    if (parts.length > 1) {
      const path = sectionPath(headings, h.offset).map((s) => s.toLowerCase());
      const ancestors = parts.slice(0, -1);
      let j = 0;
      for (const p of path.slice(0, -1)) if (j < ancestors.length && p === ancestors[j]) j++;
      if (j < ancestors.length) return;
    }
    let end = text.length;
    for (let k = i + 1; k < headings.length; k++) if (headings[k].level <= h.level) { end = headings[k].offset; break; }
    const nl = text.indexOf('\n', h.offset);
    const bodyStart = nl < 0 ? text.length : nl + 1;
    result.push({ heading: h, start: h.offset, bodyStart: Math.min(bodyStart, end), end });
  });
  return result;
}

/** Every start offset of `needle` in `hay`. */
export function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let at = hay.indexOf(needle);
  while (at >= 0) { out.push(at); at = hay.indexOf(needle, at + 1); }
  return out;
}

export function withLineNumbers(text: string, from = 1): string {
  const lines = text.split('\n');
  const width = String(from + lines.length - 1).length;
  return lines.map((l, i) => `${String(from + i).padStart(width, ' ')}\t${l}`).join('\n');
}

/** Image references in markdown: ![alt](url "title"). */
export function images(text: string): { alt: string; url: string; offset: number }[] {
  const out: { alt: string; url: string; offset: number }[] = [];
  for (const m of text.matchAll(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push({ alt: m[1], url: m[2], offset: m.index ?? 0 });
  return out;
}
