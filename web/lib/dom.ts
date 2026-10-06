// Tiny DOM helpers: no framework, just typed element construction.

export type Child = Node | string | number | null | undefined | false | Child[];
export type Attrs = Record<string, unknown>;

/**
 * h('button.btn.primary', { onclick, type: 'button' }, 'Save')
 * The tag may carry .classes and a #id. `on*` keys add listeners; `class`,
 * `style` (string or object), `dataset`, boolean props, `value` are handled.
 */
export function h<K extends keyof HTMLElementTagNameMap>(spec: K | `${K}.${string}` | `${K}#${string}`, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(spec: string, attrs?: Attrs | null, ...children: Child[]): HTMLElement;
export function h(spec: string, attrs?: Attrs | null, ...children: Child[]): HTMLElement {
  const m = /^([a-z0-9-]+)((?:[.#][\w-]+)*)$/i.exec(spec);
  const tag = m ? m[1] : 'div';
  const el = document.createElement(tag);
  if (m?.[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g) ?? []) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  if (attrs) applyAttrs(el, attrs);
  append(el, children);
  return el;
}

export function applyAttrs(el: HTMLElement, attrs: Attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') {
      for (const c of String(v).split(/\s+/).filter(Boolean)) el.classList.add(c);
    } else if (k === 'style') {
      if (typeof v === 'string') el.setAttribute('style', v);
      else Object.assign(el.style, v);
    } else if (k === 'dataset') {
      Object.assign(el.dataset, v);
    } else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden' || k === 'indeterminate') {
      (el as any)[k] = v;
    } else if (v === true) {
      el.setAttribute(k, '');
    } else {
      el.setAttribute(k, String(v));
    }
  }
}

export function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Node) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function replaceChildren(el: Element, ...children: Child[]) {
  clear(el);
  append(el, children);
}

/** Run once on the next animation frame, coalescing repeated requests. */
export function rafThrottle(fn: () => void): () => void {
  let pending = 0;
  return () => {
    if (pending) return;
    pending = requestAnimationFrame(() => { pending = 0; fn(); });
  };
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { cancel(): void } {
  let t = 0;
  const f = (...a: A) => { clearTimeout(t); t = window.setTimeout(() => fn(...a), ms); };
  f.cancel = () => clearTimeout(t);
  return f;
}

/** Grow a textarea with its content. */
export function autosize(ta: HTMLTextAreaElement, max = 320) {
  const fit = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(max, ta.scrollHeight + 2)}px`;
    ta.style.overflowY = ta.scrollHeight + 2 > max ? 'auto' : 'hidden';
  };
  ta.addEventListener('input', fit);
  requestAnimationFrame(fit);
  return fit;
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const modKey = isMac ? '⌘' : 'Ctrl+';
export const altKey = isMac ? '⌥' : 'Alt+';
