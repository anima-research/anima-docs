// Line-granular flattening of a node tree into one virtual document.
//
// A parent's body is a sequence of lines. A line that is exactly `{{node:id}}`
// is a mount: it is replaced by the child's flattened content. Line separators
// that touch a mount line (on either side) become STRUCTURAL newlines: they
// exist in the virtual document, belong to no node's text, cannot be deleted,
// and nothing can be inserted into them. Every node boundary is therefore a
// line break, and every virtual position maps to exactly one node position
// (at a boundary, the deepest node wins).
//
// A collapsed or not-yet-loaded mount contributes nothing but its band.

export const MARKER_RE = /^\{\{node:([A-Za-z0-9]+)\}\}[ \t]*$/;
export const marker = (id: string) => `{{node:${id}}}`;

export interface NodeText { text: string; title: string; type: string; loaded: boolean; readable: boolean }
export type TextSource = (id: string) => NodeText | undefined;

export interface TextItem { kind: 'text'; node: string; depth: number; from: number; to: number; tFrom: number; tTo: number }
export interface NlItem { kind: 'nl'; node: string; depth: number; from: number }
export type Item = TextItem | NlItem;

export interface Mount {
  parent: string; child: string;
  /** `${parent}/${child}#${nth}`: this mount instance. */
  key: string;
  depth: number;
  /** Virtual range of the child's content (no structural newlines). */
  from: number; to: number;
  /** Parent text offsets of the marker line (excluding its newline). */
  markerFrom: number; markerTo: number;
  /** Content left out: collapsed by the viewer, or not loaded yet. */
  collapsed: boolean;
  loaded: boolean;
}

export interface Layout { root: string; items: Item[]; mounts: Mount[]; length: number; text: string }

export function flatten(root: string, src: TextSource, isCollapsed: (key: string) => boolean = () => false): Layout {
  const items: Item[] = [];
  const mounts: Mount[] = [];
  let pos = 0;
  let out = '';
  const nl = (node: string, depth: number) => { items.push({ kind: 'nl', node, depth, from: pos }); out += '\n'; pos += 1; };

  const walk = (id: string, depth: number, path: Set<string>) => {
    const n = src(id);
    if (!n) return;
    const text = n.text;
    const lines: { from: number; to: number; mount: string | null }[] = [];
    let at = 0;
    for (;;) {
      const i = text.indexOf('\n', at);
      const to = i < 0 ? text.length : i;
      let mount: string | null = null;
      if (to - at >= 9 && to - at <= 60) {
        const m = MARKER_RE.exec(text.slice(at, to));
        if (m && !path.has(m[1]) && m[1] !== id && depth < 12) { const c = src(m[1]); if (c && c.readable) mount = m[1]; }
      }
      lines.push({ from: at, to, mount });
      if (i < 0) break;
      at = i + 1;
    }
    const nth = new Map<string, number>();
    let seg: { tFrom: number; tTo: number } | null = null;
    const flush = () => {
      if (!seg) return;
      const len = seg.tTo - seg.tFrom;
      items.push({ kind: 'text', node: id, depth, from: pos, to: pos + len, tFrom: seg.tFrom, tTo: seg.tTo });
      out += text.slice(seg.tFrom, seg.tTo); pos += len;
      seg = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      if (L.mount) {
        flush();
        const from = pos;
        const k = nth.get(L.mount) ?? 0; nth.set(L.mount, k + 1);
        const key = `${id}/${L.mount}#${k}`;
        const child = src(L.mount)!;
        const collapsed = isCollapsed(key) || !child.loaded;
        if (!collapsed) { const next = new Set(path); next.add(id); walk(L.mount, depth + 1, next); }
        mounts.push({ parent: id, child: L.mount, key, depth: depth + 1, from, to: pos, markerFrom: L.from, markerTo: L.to, collapsed, loaded: child.loaded });
      } else if (!seg) seg = { tFrom: L.from, tTo: L.to };
      else seg.tTo = L.to;
      if (i < lines.length - 1) {
        if (L.mount || lines[i + 1].mount) { flush(); nl(id, depth); }
        else seg!.tTo = L.to + 1;
      }
    }
    flush(); // an empty body still yields an (empty) text item, so the node can receive input
  };
  walk(root, 0, new Set());
  return { root, items, mounts, length: pos, text: out };
}

/** Deepest text item that can take an insertion at virtual position p (null inside a structural newline or a collapsed node's line). */
export function placeAt(layout: Layout, p: number): TextItem | null {
  let best: TextItem | null = null;
  for (const it of layout.items) {
    if (it.kind !== 'text') continue;
    if (it.from <= p && p <= it.to && (!best || it.depth > best.depth)) best = it;
  }
  return best;
}

/** Virtual position → (node, offset). */
export function nodePos(layout: Layout, p: number): { node: string; offset: number } | null {
  const it = placeAt(layout, p);
  return it ? { node: it.node, offset: it.tFrom + (p - it.from) } : null;
}

/** (node, offset) → virtual position, or null when the node is not in the view. Offsets in a marker line clamp to the nearest segment. */
export function virtualPos(layout: Layout, node: string, offset: number, side: 'start' | 'end'): number | null {
  let best: { pos: number; dist: number } | null = null;
  for (const it of layout.items) {
    if (it.kind !== 'text' || it.node !== node) continue;
    if (offset >= it.tFrom && offset <= it.tTo) {
      const exact = it.from + (offset - it.tFrom);
      if (best && best.dist === 0) return side === 'start' ? exact : best.pos;
      best = { pos: exact, dist: 0 };
      continue;
    }
    const d = offset < it.tFrom ? it.tFrom - offset : offset - it.tTo;
    const pos = offset < it.tFrom ? it.from : it.to;
    if (!best || d < best.dist) best = { pos, dist: d };
  }
  return best ? best.pos : null;
}

export interface NodeOp { node: string; from: number; to: number; insert: string }
export interface UnmountOp { parent: string; markerFrom: number; markerTo: number; child: string }

/**
 * A virtual change (old coordinates) → per-node text ops, plus mounts to
 * detach. A child whose whole content AND both structural newlines are
 * covered is detached whole: no text op touches its subtree (it may be
 * mounted elsewhere too). Only outermost detached mounts are reported.
 */
export function decompose(layout: Layout, from: number, to: number, insert: string): { ops: NodeOp[]; unmounts: UnmountOp[]; dropped: boolean } {
  const ops: NodeOp[] = [];
  const unmounts: UnmountOp[] = [];
  let dropped = false;
  if (to > from) {
    const detached: Mount[] = [];
    for (const m of layout.mounts) {
      const enter = m.from - 1, leave = m.to;
      const hasEnter = layout.items.some((it) => it.kind === 'nl' && it.from === enter && it.depth === m.depth - 1);
      const hasLeave = layout.items.some((it) => it.kind === 'nl' && it.from === leave && it.depth === m.depth - 1);
      const lo = hasEnter ? enter : m.from, hi = hasLeave ? leave + 1 : m.to;
      if (from <= lo && to >= hi && (hasEnter || hasLeave)) detached.push(m);
    }
    const inside = (p: number, depth: number) => detached.some((m) => m.from <= p && p < m.to && depth >= m.depth);
    const outermost = detached.filter((m) => !detached.some((o) => o !== m && o.from <= m.from && m.to <= o.to && o.depth < m.depth));
    for (const m of outermost) unmounts.push({ parent: m.parent, markerFrom: m.markerFrom, markerTo: m.markerTo, child: m.child });
    for (const it of layout.items) {
      if (it.kind !== 'text') continue;
      const a = Math.max(from, it.from), b = Math.min(to, it.to);
      if (b <= a) continue;
      if (inside(a, it.depth)) continue;
      ops.push({ node: it.node, from: it.tFrom + (a - it.from), to: it.tFrom + (b - it.from), insert: '' });
    }
  }
  if (insert) {
    const at = placeAt(layout, from);
    if (at) ops.push({ node: at.node, from: at.tFrom + (from - at.from), to: at.tFrom + (from - at.from), insert });
    else dropped = true;
  }
  return { ops, unmounts, dropped };
}

/** Split a virtual change into pieces that touch no structural newline. Null if nothing needed. */
export function splitChange(layout: Layout, from: number, to: number, insert: string): { from: number; to: number; insert: string }[] | null {
  const nls = layout.items.filter((it): it is NlItem => it.kind === 'nl' && it.from >= from && it.from < to);
  const insertAt = placeAt(layout, from);
  if (nls.length === 0 && (insertAt || !insert)) return null;
  const pieces: { from: number; to: number; insert: string }[] = [];
  let cur = from;
  for (const n of nls) {
    if (n.from > cur) pieces.push({ from: cur, to: n.from, insert: '' });
    cur = n.from + 1;
  }
  if (to > cur) pieces.push({ from: cur, to, insert: '' });
  if (insert && insertAt) {
    const first = pieces.find((p) => p.from === from);
    if (first) first.insert = insert; else pieces.unshift({ from, to: from, insert });
  }
  return pieces;
}

/** The op that removes a marker line (and one adjacent separator) from a parent's text. */
export function markerRemoval(text: string, u: { markerFrom: number; markerTo: number }): { from: number; to: number } {
  let from = u.markerFrom, to = u.markerTo;
  if (to < text.length && text[to] === '\n') to += 1;
  else if (from > 0 && text[from - 1] === '\n') from -= 1;
  return { from, to };
}
