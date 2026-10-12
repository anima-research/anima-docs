// Markdown extensions shared by the wiki (server) and the preview (browser).
//
// Image sizes: `![alt|400](url)` or `![alt|400x300](url)` — the size rides in
// the alt text, so it survives every tool that handles plain markdown.
// Galleries: a fenced block ```gallery with one image per line (`![alt](url)`,
// a bare URL, or `url | caption`) renders as a grid; each item links to the
// full-size image so a lightbox (or the browser) can show it.

import type MarkdownIt from 'markdown-it';
import type { StateCore, Token } from 'markdown-it';

type MD = InstanceType<typeof MarkdownIt>;

export const SIZE_RE = /\|\s*(\d{2,4})(?:x(\d{2,4}))?\s*$/;

/** Split `alt|400x300` into the alt text and the size. */
export function parseAltSize(alt: string): { alt: string; width: number | null; height: number | null } {
  const m = SIZE_RE.exec(alt);
  if (!m) return { alt, width: null, height: null };
  return { alt: alt.slice(0, m.index).trim(), width: Number(m[1]), height: m[2] ? Number(m[2]) : null };
}

/** Put a size into an alt text (null clears it). */
export function withAltSize(alt: string, width: number | null, height: number | null = null): string {
  const base = alt.replace(SIZE_RE, '').trim();
  if (!width) return base;
  return `${base}|${width}${height ? `x${height}` : ''}`;
}

export function imageSizes(md: MD) {
  md.core.ruler.after('inline', 'image-sizes', (state: StateCore) => {
    const walk = (tokens: Token[]) => {
      for (const t of tokens) {
        if (t.type === 'image') {
          const { alt, width, height } = parseAltSize(t.content);
          if (width) {
            t.content = alt;
            if (t.children) for (const c of t.children) if (c.type === 'text') c.content = c.content.replace(SIZE_RE, '').trim();
            t.attrSet('width', String(width));
            if (height) t.attrSet('height', String(height));
          }
        }
        if (t.children) walk(t.children);
      }
    };
    walk(state.tokens);
    return false;
  });
}

export interface GalleryItem { src: string; alt: string; caption: string }

/** The items of a gallery block's text. */
export function parseGallery(text: string): GalleryItem[] {
  const out: GalleryItem[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const img = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)\s*(?:\|\s*(.*))?$/.exec(line);
    if (img) { const a = parseAltSize(img[1]); out.push({ src: img[2], alt: a.alt, caption: img[4]?.trim() || img[3] || a.alt }); continue; }
    const bare = /^(\S+)\s*(?:\|\s*(.*))?$/.exec(line);
    if (bare) out.push({ src: bare[1], alt: bare[2]?.trim() ?? '', caption: bare[2]?.trim() ?? '' });
  }
  return out;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const safeSrc = (src: string) => /^(https:\/\/|\/media\/)/i.test(src);

export function galleryFence(md: MD) {
  const base = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const t = tokens[idx];
    const info = (t.info || '').trim().split(/\s+/)[0];
    if (info !== 'gallery') return base(tokens, idx, options, env, self);
    const items = parseGallery(t.content).filter((it) => safeSrc(it.src));
    if (!items.length) return '<div class="md-gallery md-gallery-empty">Empty gallery: one image per line, <code>![caption](url)</code>.</div>\n';
    return `<div class="md-gallery">${items.map((it) => `<a class="md-gallery-item" href="${esc(it.src)}" data-caption="${esc(it.caption)}"><img src="${esc(it.src)}" alt="${esc(it.alt)}" loading="lazy" decoding="async">${it.caption ? `<span class="md-gallery-caption">${esc(it.caption)}</span>` : ''}</a>`).join('')}</div>\n`;
  };
}
