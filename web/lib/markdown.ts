// Markdown → sanitized DOM, for the preview, versions, table cells and comments.

import MarkdownIt from 'markdown-it';
import type { StateCore } from 'markdown-it';
import DOMPurify from 'dompurify';

type MD = InstanceType<typeof MarkdownIt>;

/** GitHub-style task lists: "- [ ] item" → a disabled checkbox. */
function taskLists(md: MD) {
  md.core.ruler.after('inline', 'task-lists', (state: StateCore) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
      const first = t.children?.[0];
      const m = first && first.type === 'text' ? /^\[([ xX])\][ \t]/.exec(first.content) ?? /^\[([ xX])\]$/.exec(first.content) : null;
      if (!m || !first) continue;
      first.content = first.content.slice(m[0].length);
      const cb = new state.Token('html_inline', '', 0);
      cb.content = `<input type="checkbox" class="task-checkbox" tabindex="-1" aria-disabled="true"${m[1] !== ' ' ? ' checked' : ''}>`;
      t.children!.unshift(cb);
      tokens[i - 2].attrJoin('class', 'task-list-item');
      for (let j = i - 3; j >= 0; j--) {
        if (tokens[j].type === 'bullet_list_open' || tokens[j].type === 'ordered_list_open') {
          if (tokens[j].level === tokens[i - 2].level - 1) { tokens[j].attrJoin('class', 'contains-task-list'); break; }
        }
      }
    }
    return false;
  });
}

const docMd = new MarkdownIt({ html: false, linkify: true, typographer: true });
docMd.use(taskLists);
const commentMd = new MarkdownIt({ html: false, linkify: true, breaks: true });
commentMd.use(taskLists);
const inlineMd = new MarkdownIt({ html: false, linkify: true, typographer: true });

let hooked = false;
function purify(html: string): DocumentFragment {
  if (!hooked) {
    hooked = true;
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        const href = node.getAttribute('href') ?? '';
        if (/^https?:/i.test(href)) { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
      }
      if (node.tagName === 'IMG') {
        node.setAttribute('loading', 'lazy');
        node.setAttribute('decoding', 'async');
        const src = node.getAttribute('src') ?? '';
        if (!isSafeImageSrc(src)) node.removeAttribute('src');
      }
    });
  }
  return DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true, FORBID_TAGS: ['style', 'form'], ADD_ATTR: ['target'] }) as DocumentFragment;
}

/** Image sources the page may load (CSP allows self, https, data and blob). */
export function isSafeImageSrc(src: string): boolean {
  return /^\/media\/[\w.-]+$/.test(src) || /^https:\/\//i.test(src) || /^data:image\/(png|jpeg|gif|webp);/i.test(src) || /^blob:/i.test(src);
}

export function renderDocument(markdown: string): DocumentFragment {
  const frag = purify(docMd.render(markdown));
  for (const t of frag.querySelectorAll('table')) {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    t.replaceWith(wrap);
    wrap.append(t);
  }
  return frag;
}

export function renderInlineHtml(markdown: string): DocumentFragment {
  return purify(inlineMd.renderInline(markdown));
}

export interface MentionContext {
  /** Display name for a principal id, when known. */
  nameOf: (sub: string) => string | undefined;
  /** Names to highlight as mentions (longest first is handled here). */
  names: { name: string; me?: boolean }[];
}

/**
 * Comment bodies: markdown with @mentions turned into chips. Ids may be
 * opaque (`anon:…`): guests see people by name only, so an id nobody here
 * can name reads as "@someone".
 */
export function renderComment(body: string, ctx: MentionContext): DocumentFragment {
  const used: { name: string }[] = [];
  const say = (name: string) => { used.push({ name }); return `@${name}`; };
  const fallback = (sub: string) => (sub.startsWith('anon:') ? 'someone' : sub);
  const named = body
    .replace(/@\[([^\]]*)\]\(((?:human|agent|service|guest|anon):[^)\s]+)\)/g, (_, name: string, sub: string) => say(ctx.nameOf(sub) ?? (name || fallback(sub))))
    .replace(/@\{((?:human|agent|service|guest|anon):[^}\s]+)\}/g, (_, sub: string) => say(ctx.nameOf(sub) ?? fallback(sub)));
  const frag = purify(commentMd.render(named));
  const known = new Set(ctx.names.map((n) => n.name.toLowerCase()));
  highlightMentions(frag, [...ctx.names, ...used.filter((u) => !known.has(u.name.toLowerCase()))]);
  return frag;
}

function highlightMentions(root: DocumentFragment, names: { name: string; me?: boolean }[]) {
  if (!names.length) return;
  const sorted = [...names].filter((n) => n.name).sort((a, b) => b.name.length - a.name.length);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('code, pre, a, .mention') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n as Text).data.includes('@')) texts.push(n as Text);
  for (const t of texts) {
    let node: Text | null = t;
    while (node) {
      const lower = node.data.toLowerCase();
      let hit: { at: number; len: number; me: boolean } | null = null;
      for (const n of sorted) {
        const needle = `@${n.name.toLowerCase()}`;
        let at = lower.indexOf(needle);
        while (at >= 0) {
          const before = at === 0 ? ' ' : lower[at - 1];
          const after = lower[at + needle.length] ?? ' ';
          if (!/[\w@]/.test(before) && !/[\w-]/.test(after)) break;
          at = lower.indexOf(needle, at + 1);
        }
        if (at >= 0 && (!hit || at < hit.at)) hit = { at, len: needle.length, me: !!n.me };
      }
      if (!hit) break;
      const rest = node.splitText(hit.at);
      const after = rest.splitText(hit.len);
      const chip = document.createElement('span');
      chip.className = hit.me ? 'mention me' : 'mention';
      chip.textContent = rest.data;
      rest.replaceWith(chip);
      node = after;
    }
  }
}

/** Plain-text excerpt of markdown (for toasts and previews). */
export function excerpt(markdown: string, max = 120): string {
  const s = markdown.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`~]|!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
