// Follow a link from the source: ⌘-click (Ctrl-click elsewhere) on a markdown link,
// an <autolink> or a bare URL opens it — a document address in place, anything else
// in a new tab. While the modifier is held, links show a pointer and an underline.

import { syntaxTree } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const BARE_URL = /https?:\/\/[^\s<>()"']+|\/(?:d|p|l|w)\/[A-Za-z0-9_-][^\s<>()"']*/g;

/** The link whose text spans `pos`, if any. */
export function linkAt(view: EditorView, pos: number): string | null {
  const tree = syntaxTree(view.state);
  for (let n: any = tree.resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === 'Link' || n.name === 'Image') {
      const url = n.getChild('URL');
      if (url) { let s = view.state.sliceDoc(url.from, url.to); if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1); return s; }
      return null;
    }
    if (n.name === 'Autolink' || n.name === 'URL') {
      let s = view.state.sliceDoc(n.from, n.to);
      if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1);
      return s;
    }
  }
  // Not a markdown link node: a bare address on this line under the pointer.
  const line = view.state.doc.lineAt(pos);
  for (const m of line.text.matchAll(BARE_URL)) {
    const from = line.from + m.index!, to = from + m[0].length;
    if (pos >= from && pos <= to) return m[0].replace(/[.,;:!?)]+$/, '');
  }
  return null;
}

const modHeld = ViewPlugin.define((view) => {
  const key = isMac ? 'Meta' : 'Control';
  const set = (on: boolean) => view.dom.classList.toggle('cm-mod-held', on);
  const down = (e: KeyboardEvent) => { if (e.key === key) set(true); };
  const up = (e: KeyboardEvent) => { if (e.key === key) set(false); };
  const blur = () => set(false);
  window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur);
  return { destroy() { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); set(false); } };
});

/** `openInPlace` handles document addresses (/d/… /p/… /l/…); returns false to fall back to a new tab. */
export function followLinks(openInPlace: (path: string) => boolean): Extension {
  // The platform's modifier by convention; the other is accepted too (a Mac user with a PC keyboard, a browser that maps it).
  const mod = (e: MouseEvent) => (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
  return [
    modHeld,
    EditorView.domEventHandlers({
      mousedown(e, view) {
        if (!mod(e) || e.button !== 0) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos === null) return false;
        const url = linkAt(view, pos);
        if (!url) return false;
        e.preventDefault(); // keep the cursor where it is
        let u: URL;
        try { u = new URL(url, location.origin); } catch { return true; }
        if (u.origin === location.origin && /^\/(d|p|l)\//.test(u.pathname) && openInPlace(u.pathname + u.search)) return true;
        if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') window.open(u.href, '_blank', 'noopener');
        return true;
      },
    }),
  ];
}

export const followHint = isMac ? '⌘-click to open' : 'Ctrl-click to open';
