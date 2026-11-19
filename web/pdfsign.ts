// Fill and sign a PDF in the browser: its own bundle (pdf.js to show the
// pages, pdf-lib to write the result), fetched the first time someone needs it.
//
// The pages are drawn by pdf.js; over each lies a layer with the PDF's own
// form fields as inputs, the places someone was asked to sign or initial
// (comment threads that are fields: src/fields.ts), and whatever the person
// adds: typed text, their signature, their initials, a date. Everything on the
// layer is placed in fractions of the page, so it is the same at any zoom.
// Saving writes all of it into the PDF, which becomes the file's next version.
//
// The signature and initials are the person's own: drawn (or uploaded) once,
// kept by the server for them alone, and put on a page only by them, here.

import * as pdfjs from 'pdfjs-dist';
import { PDFDocument, PDFName, StandardFonts, degrees, type PDFFont, type PDFImage, type PDFPage } from '@cantoo/pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { h } from './lib/dom';
import { icon } from './lib/icons';
import { pageMapper, shownBox } from './pdfgeometry';

pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';

export type StampKind = 'signature' | 'initials';
/** A place someone was asked to sign: a comment thread that is a field. */
export interface SignField { id: string; kind: StampKind; page: number; x: number; y: number; w: number; h: number; by: string; note: string; forMe: boolean; assignee: string | null }
/** What the app around this view does for it (this bundle shares no state with the app's). */
export interface SignHost {
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
  confirm(title: string, message: string, confirmLabel: string): Promise<boolean>;
  dialog(title: string, body: HTMLElement, footer: HTMLElement[]): { close(): void };
}
export interface SignOptions {
  /** Where the PDF's bytes are. */
  url: string;
  name: string;
  fields: SignField[];
  host: SignHost;
  /** Store the PDF as the file's next version and answer the fields that were signed. Throws when it could not. */
  save(pdf: Uint8Array, signed: { id: string; kind: StampKind }[]): Promise<void>;
  close(): void;
}
export interface SignView {
  el: HTMLElement;
  dirty(): boolean;
  /** Save what has been filled in and placed (as the Save button does). */
  save(): Promise<void>;
  setFields(fields: SignField[]): void;
  destroy(): void;
}

type Tool = 'none' | 'text' | 'date' | StampKind;
interface Stamp { png: Uint8Array; url: string; ratio: number }
interface TextItem { type: 'text'; page: number; x: number; y: number; size: number; el: HTMLElement; body: HTMLElement }
interface ImageItem { type: 'image'; page: number; x: number; y: number; w: number; h: number; kind: StampKind; stamp: Stamp; fieldId: string | null; el: HTMLElement }
type Item = TextItem | ImageItem;
interface FormValue { type: 'text' | 'check' | 'radio' | 'choice'; value: string | boolean; initial: string | boolean }
interface Page { n: number; w: number; h: number; el: HTMLElement; canvas: HTMLCanvasElement; layer: HTMLElement; drawn: number; opening: Promise<pdfjs.PDFPageProxy> | null }

/** Sizes on the page, in points (1/72 inch). */
const TEXT_SIZE = 11, STAMP_WIDTH: Record<StampKind, number> = { signature: 150, initials: 56 };
const LINE = 1.2;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const WORD: Record<StampKind, { ask: string; noun: string; done: string }> = {
  signature: { ask: 'Sign here', noun: 'signature', done: 'Signed.' },
  initials: { ask: 'Initial here', noun: 'initials', done: 'Initialled.' },
};

export async function mountSign(o: SignOptions): Promise<SignView> {
  const res = await fetch(o.url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Could not read the PDF (${res.status}).`);
  const original = new Uint8Array(await res.arrayBuffer());
  // pdf.js takes its copy away to a worker; the original stays here for writing.
  const pdf = await pdfjs.getDocument({ data: original.slice(), cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/', useWasm: false }).promise;

  let tool: Tool = 'none';
  let fields = o.fields;
  let destroyed = false;
  let saving = false;
  const items: Item[] = [];
  const form = new Map<string, FormValue>();
  /** The PDF's own signature fields: places to sign that no thread asks for. */
  const ownFields: SignField[] = [];
  const stamps = new Map<StampKind, Stamp>();

  // ------------------------------------------------------------------ chrome

  const toolBtn = (t: Tool, ic: string, label: string, tip: string) => h('button.btn.sm.ghost.sign-tool', { type: 'button', 'data-tool': t, 'data-tip': tip, 'aria-pressed': 'false', onclick: () => setTool(tool === t ? 'none' : t) }, icon(ic, 16), h('span.btn-label', null, label));
  const tools = [
    toolBtn('text', 'pencil', 'Text', 'Type anywhere on a page'),
    toolBtn('signature', 'suggest', 'Signature', 'Place your signature'),
    toolBtn('initials', 'tag', 'Initials', 'Place your initials'),
    toolBtn('date', 'clock', 'Date', 'Place today’s date'),
  ];
  const redraw = h('button.btn.sm.ghost', { type: 'button', 'data-tip': 'Draw your signature or initials again', onclick: () => void redrawStamp() }, 'Change signature…');
  const hint = h('span.sign-hint.meta');
  const nextBtn = h('button.btn.sm', { type: 'button', hidden: true, onclick: () => goToField() }, 'Next place to sign');
  const saveBtn = h('button.btn.sm.primary', { type: 'button', disabled: true, onclick: () => void save() }, 'Save');
  const closeBtn = h('button.btn.sm.ghost', { type: 'button', onclick: () => void leave() }, 'Close');
  const bar = h('div.sign-bar', { role: 'toolbar', 'aria-label': 'Fill and sign' }, ...tools, redraw, hint, h('span.tb-spacer'), nextBtn, saveBtn, closeBtn);
  const pagesEl = h('div.sign-pages');
  const el = h('div.sign', null, bar, pagesEl);

  const changed = () => { saveBtn.disabled = saving || !dirty(); updateHint(); };
  const dirty = () => items.length > 0 || [...form.values()].some((v) => v.value !== v.initial);
  function setTool(t: Tool) {
    tool = t;
    for (const b of tools) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
    el.dataset.tool = t;
    updateHint();
  }
  const openFields = () => [...fields, ...ownFields].filter((f) => (f.forMe || !f.assignee) && !items.some((i) => i.type === 'image' && i.fieldId === f.id));
  function updateHint() {
    const open = openFields();
    nextBtn.hidden = !open.length;
    hint.textContent = tool === 'text' ? 'Click where the text goes.' : tool === 'date' ? 'Click where the date goes.'
      : tool === 'signature' || tool === 'initials' ? `Click where your ${WORD[tool].noun} go${tool === 'signature' ? 'es' : ''}.`
        : open.length ? `${open.length} place${open.length === 1 ? '' : 's'} to sign.` : '';
  }
  function goToField() {
    const f = openFields().sort((a, b) => Number(b.forMe) - Number(a.forMe) || a.page - b.page || a.y - b.y)[0];
    pagesEl.querySelector<HTMLElement>(`[data-field="${CSS.escape(f?.id ?? '')}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // ------------------------------------------------------------------ pages

  const pages: Page[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    // Sizes come with the first page's until each page is read (most PDFs have one size).
    const canvas = h('canvas.sign-canvas');
    const layer = h('div.sign-layer');
    const pageEl = h('div.sign-page', { 'data-page': String(n) }, canvas, layer);
    pages.push({ n, w: 612, h: 792, el: pageEl, canvas, layer, drawn: 0, opening: null });
    pagesEl.append(pageEl);
  }
  const sized = new ResizeObserver((entries) => { for (const e of entries) { const p = pages[Number((e.target as HTMLElement).dataset.page) - 1]; p.el.style.setProperty('--pt', `${e.contentRect.width / p.w}px`); void draw(p); } });
  const seen = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) void draw(pages[Number((e.target as HTMLElement).dataset.page) - 1]); }, { root: pagesEl, rootMargin: '600px 0px' });

  /** Read a page: its size, its form fields. Once, however many ask at once (a resize and a scroll both do). */
  const open = (p: Page) => (p.opening ??= read(p));
  async function read(p: Page) {
    const proxy = await pdf.getPage(p.n);
    const vp = proxy.getViewport({ scale: 1 });
    p.w = vp.width; p.h = vp.height;
    p.el.style.aspectRatio = `${p.w} / ${p.h}`;
    p.el.style.setProperty('--pt', `${p.el.clientWidth / p.w}px`);
    for (const a of await proxy.getAnnotations({ intent: 'display' }) as Record<string, any>[]) {
      if (a.subtype !== 'Widget' || a.hidden || !a.fieldName || !Array.isArray(a.rect)) continue;
      // The field's corners as the page is shown (it may be rotated): the box that holds both.
      const [ax, ay] = vp.convertToViewportPoint(a.rect[0], a.rect[1]) as number[], [bx, by] = vp.convertToViewportPoint(a.rect[2], a.rect[3]) as number[];
      const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
      const box = { x: x0 / p.w, y: y0 / p.h, w: (x1 - x0) / p.w, h: (y1 - y0) / p.h };
      const place = (node: HTMLElement) => { node.style.left = `${box.x * 100}%`; node.style.top = `${box.y * 100}%`; node.style.width = `${box.w * 100}%`; node.style.height = `${box.h * 100}%`; p.layer.append(node); };
      const name = String(a.fieldName);
      if (a.fieldType === 'Sig') { ownFields.push({ id: `own:${name}:${p.n}`, kind: 'signature', page: p.n, ...box, by: '', note: '', forMe: false, assignee: null }); continue; }
      if (a.readOnly) continue;
      if (a.fieldType === 'Tx') {
        const start = String(a.fieldValue ?? '');
        if (!form.has(name)) form.set(name, { type: 'text', value: start, initial: start });
        const size = a.defaultAppearanceData?.fontSize || Math.min(12, (y1 - y0) * (a.multiLine ? 0.2 : 0.62));
        const input = h(a.multiLine ? 'textarea.sign-input' : 'input.sign-input', { type: a.multiLine ? undefined : 'text', value: String(form.get(name)!.value), 'aria-label': a.alternativeText || name, maxlength: a.maxLen || undefined, style: `font-size: calc(var(--pt) * ${Math.max(6, size)})` }) as HTMLInputElement;
        input.dataset.name = name;
        input.addEventListener('input', () => { form.get(name)!.value = input.value; for (const twin of pagesEl.querySelectorAll<HTMLInputElement>('.sign-input')) if (twin !== input && twin.dataset.name === name) twin.value = input.value; changed(); });
        place(input);
      } else if (a.fieldType === 'Btn' && (a.checkBox || a.radioButton)) {
        const on = a.checkBox ? String(a.exportValue ?? 'Yes') : String(a.buttonValue ?? '');
        const start = a.checkBox ? (a.fieldValue !== undefined && a.fieldValue !== 'Off' && a.fieldValue !== null && String(a.fieldValue) === on) : String(a.fieldValue ?? '');
        if (!form.has(name)) form.set(name, a.checkBox ? { type: 'check', value: start, initial: start } : { type: 'radio', value: start, initial: start });
        const v = form.get(name)!;
        const input = h('input.sign-check', { type: a.checkBox ? 'checkbox' : 'radio', name: `f-${name}`, 'aria-label': a.alternativeText || name, checked: a.checkBox ? v.value === true : v.value === on });
        input.addEventListener('change', () => { v.value = a.checkBox ? input.checked : on; changed(); });
        place(input);
      } else if (a.fieldType === 'Ch' && a.combo && !a.multiSelect && Array.isArray(a.options)) {
        const start = String(Array.isArray(a.fieldValue) ? a.fieldValue[0] ?? '' : a.fieldValue ?? '');
        if (!form.has(name)) form.set(name, { type: 'choice', value: start, initial: start });
        const select = h('select.sign-input', { 'aria-label': a.alternativeText || name, style: 'font-size: calc(var(--pt) * 10)' }, h('option', { value: '' }, ''), ...a.options.map((op: { exportValue: string; displayValue: string }) => h('option', { value: op.exportValue }, op.displayValue)));
        select.value = start;
        select.addEventListener('change', () => { form.get(name)!.value = select.value; changed(); });
        place(select);
      }
    }
    drawFields();
    return proxy;
  }

  /** Draw a page at the size it is shown (again when that grows: a wider window, a sharper screen). */
  async function draw(p: Page) {
    const proxy = await open(p);
    const width = Math.round(p.el.clientWidth * Math.min(3, window.devicePixelRatio || 1));
    if (destroyed || !width || width <= p.drawn * 1.05) return;
    p.drawn = width;
    const vp = proxy.getViewport({ scale: Math.min(width, 4096) / p.w });
    // Drawn aside and swapped in whole: the page never shows half a picture.
    const fresh = document.createElement('canvas');
    fresh.width = Math.round(vp.width); fresh.height = Math.round(vp.height);
    // The PDF's own fields are the inputs on the layer: their pictures are not drawn under them.
    await proxy.render({ canvas: fresh, canvasContext: fresh.getContext('2d')!, viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS } as never).promise;
    if (destroyed || p.drawn !== width) return;
    p.canvas.width = fresh.width; p.canvas.height = fresh.height;
    p.canvas.getContext('2d')!.drawImage(fresh, 0, 0);
    p.el.classList.add('drawn');
  }

  // ------------------------------------------------------------------ places to sign

  function drawFields() {
    for (const old of pagesEl.querySelectorAll('.sign-field')) old.remove();
    for (const f of [...fields, ...ownFields]) {
      const p = pages[f.page - 1];
      if (!p || items.some((i) => i.type === 'image' && i.fieldId === f.id)) continue;
      // A place asked of someone else is theirs: shown, not signable here.
      const others = !!f.assignee && !f.forMe;
      const node = h('button.sign-field', { type: 'button', 'data-field': f.id, class: `${f.kind}${f.forMe ? ' mine' : ''}${others ? ' others' : ''}`, disabled: others, title: [f.by ? `Asked by ${f.by}${others ? ` of ${f.assignee}` : ''}` : '', f.note].filter(Boolean).join(': '), onclick: (e: MouseEvent) => { e.stopPropagation(); void placeInField(f); } },
        icon(f.kind === 'signature' ? 'suggest' : 'tag', 14), h('span', null, others ? `For ${f.assignee}` : WORD[f.kind].ask));
      node.style.left = `${f.x * 100}%`; node.style.top = `${f.y * 100}%`; node.style.width = `${f.w * 100}%`; node.style.height = `${f.h * 100}%`;
      p.layer.append(node);
    }
    updateHint();
  }

  async function placeInField(f: SignField) {
    const stamp = await getStamp(f.kind);
    if (!stamp) return;
    const p = pages[f.page - 1];
    // As large as fits in the box, standing on its bottom edge, in the middle.
    const bw = f.w * p.w, bh = f.h * p.h;
    const w = Math.min(bw, bh * stamp.ratio), hh = w / stamp.ratio;
    addImage({ page: f.page, x: f.x + (bw - w) / 2 / p.w, y: f.y + (bh - hh) / p.h, w: w / p.w, h: hh / p.h, kind: f.kind, stamp, fieldId: f.id });
    drawFields();
  }

  // ------------------------------------------------------------------ what the person adds

  function wire(item: Item, grip: HTMLElement, dropped?: () => void) {
    const p = pages[item.page - 1];
    const put = () => { item.el.style.left = `${item.x * 100}%`; item.el.style.top = `${item.y * 100}%`; if (item.type === 'image') { item.el.style.width = `${item.w * 100}%`; item.el.style.height = `${item.h * 100}%`; } };
    put();
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const box = p.layer.getBoundingClientRect();
      const dx = e.clientX - item.x * box.width, dy = e.clientY - item.y * box.height;
      grip.setPointerCapture(e.pointerId);
      const move = (m: PointerEvent) => { item.x = clamp((m.clientX - dx) / box.width, 0, 0.99); item.y = clamp((m.clientY - dy) / box.height, 0, 0.99); put(); };
      const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up); dropped?.(); };
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
    });
    item.el.addEventListener('click', (e) => e.stopPropagation());
    p.layer.append(item.el);
    items.push(item);
    changed();
    return put;
  }
  function removeItem(item: Item) {
    items.splice(items.indexOf(item), 1);
    if (item.type === 'image') URL.revokeObjectURL(''); // the stamp's picture is shared; nothing to free per item
    item.el.remove();
    drawFields();
    changed();
  }
  const itemButton = (label: string, text: string, run: () => void) => h('button.sign-item-btn', { type: 'button', 'aria-label': label, title: label, onpointerdown: (e: PointerEvent) => e.stopPropagation(), onclick: (e: MouseEvent) => { e.stopPropagation(); run(); } }, text);

  function addText(page: number, x: number, y: number, text: string, focus: boolean) {
    const body = h('div.sign-text-body', { contenteditable: 'plaintext-only', spellcheck: 'false', role: 'textbox', 'aria-label': 'Text on the page' }, text);
    if (body.contentEditable !== 'plaintext-only') body.contentEditable = 'true';
    const grip = h('span.sign-grip', { title: 'Drag to move', 'aria-hidden': 'true' }, '⠿');
    const node = h('div.sign-item.text', null, grip, body);
    const item: TextItem = { type: 'text', page, x, y, size: TEXT_SIZE, el: node, body };
    const resize = (d: number) => { item.size = clamp(item.size + d, 6, 48); node.style.fontSize = `calc(var(--pt) * ${item.size})`; };
    node.append(h('span.sign-item-tools', null, itemButton('Smaller', 'A−', () => resize(-1)), itemButton('Larger', 'A+', () => resize(1)), itemButton('Remove', '×', () => removeItem(item))));
    resize(0);
    // Pasted text comes in plain; an emptied box left behind goes.
    body.addEventListener('paste', (e) => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData?.getData('text/plain') ?? ''); });
    body.addEventListener('input', changed);
    body.addEventListener('blur', () => { if (!body.textContent?.trim() && items.includes(item)) removeItem(item); });
    wire(item, grip);
    if (focus) { body.focus(); }
  }

  function addImage(p: Omit<ImageItem, 'type' | 'el'>) {
    const grip = h('img.sign-stamp', { src: p.stamp.url, alt: `Your ${WORD[p.kind].noun}`, draggable: 'false' });
    const corner = h('span.sign-corner', { title: 'Drag to resize', 'aria-hidden': 'true' });
    const node = h('div.sign-item.image', null, grip, corner);
    const item: ImageItem = { type: 'image', el: node, ...p };
    node.append(h('span.sign-item-tools', null, itemButton('Remove', '×', () => removeItem(item))));
    // Dragged out of the place it was asked for, it no longer answers that request (the place shows again).
    const put = wire(item, grip, () => {
      const f = item.fieldId ? [...fields, ...ownFields].find((x) => x.id === item.fieldId) : null;
      if (!f) return;
      const cx = item.x + item.w / 2, cy = item.y + item.h / 2;
      if (cx < f.x || cx > f.x + f.w || cy < f.y || cy > f.y + f.h) { item.fieldId = null; drawFields(); }
    });
    const page = pages[item.page - 1];
    corner.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const box = page.layer.getBoundingClientRect();
      corner.setPointerCapture(e.pointerId);
      const move = (m: PointerEvent) => {
        item.w = clamp((m.clientX - box.left) / box.width - item.x, 0.02, 1 - item.x);
        item.h = item.w * page.w / item.stamp.ratio / page.h;
        put();
      };
      const up = () => { corner.removeEventListener('pointermove', move); corner.removeEventListener('pointerup', up); };
      corner.addEventListener('pointermove', move); corner.addEventListener('pointerup', up);
    });
  }

  pagesEl.addEventListener('click', (e) => {
    const layer = (e.target as HTMLElement).closest<HTMLElement>('.sign-layer');
    if (!layer || tool === 'none' || (e.target as HTMLElement).closest('.sign-input, .sign-check, .sign-item, .sign-field')) return;
    const p = pages[Number(layer.parentElement!.dataset.page) - 1];
    const box = layer.getBoundingClientRect();
    const x = (e.clientX - box.left) / box.width, y = (e.clientY - box.top) / box.height;
    const t = tool;
    setTool('none');
    if (t === 'text') addText(p.n, x, clamp(y - TEXT_SIZE * LINE / 2 / p.h, 0, 1), '', true);
    else if (t === 'date') addText(p.n, x, clamp(y - TEXT_SIZE * LINE / 2 / p.h, 0, 1), new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }), false);
    else void getStamp(t).then((stamp) => {
      if (!stamp) return;
      const w = STAMP_WIDTH[t] / p.w, hh = STAMP_WIDTH[t] / stamp.ratio / p.h;
      addImage({ page: p.n, x: clamp(x - w / 2, 0, 1 - w), y: clamp(y - hh / 2, 0, 1 - hh), w, h: hh, kind: t, stamp, fieldId: null });
    });
  });

  // ------------------------------------------------------------------ the person's signature and initials

  async function loadStamp(png: Uint8Array): Promise<Stamp> {
    const url = URL.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' }));
    const img = new Image();
    img.src = url;
    await img.decode();
    return { png, url, ratio: img.naturalWidth / Math.max(1, img.naturalHeight) };
  }
  /** The person's saved signature (or initials); drawn now when there is none yet. */
  async function getStamp(kind: StampKind, again = false): Promise<Stamp | null> {
    if (!again && stamps.has(kind)) return stamps.get(kind)!;
    if (!again) {
      const r = await fetch(`/api/me/${kind}`, { credentials: 'same-origin' }).catch(() => null);
      if (r?.ok) { const s = await loadStamp(new Uint8Array(await r.arrayBuffer())); stamps.set(kind, s); return s; }
      if (r?.status !== 404) { o.host.toast(r ? 'Your saved signature could not be read. Sign in again in this browser.' : 'Could not reach the server for your saved signature. Check your connection.', 'error'); return null; }
    }
    const png = await drawStamp(kind);
    if (!png) return null;
    const put = await fetch(`/api/me/${kind}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'image/png' }, body: png as BodyInit }).catch(() => null);
    if (!put?.ok) o.host.toast(`Your ${WORD[kind].noun} could not be kept for next time; ${kind === 'signature' ? 'it is' : 'they are'} used for this document.`, 'info');
    const s = await loadStamp(png);
    stamps.set(kind, s);
    return s;
  }
  async function redrawStamp() {
    const which = await new Promise<StampKind | null>((resolve) => {
      const pick = (k: StampKind) => h('button.btn', { type: 'button', onclick: () => { d.close(); resolve(k); } }, k === 'signature' ? 'Signature' : 'Initials');
      const d = o.host.dialog('Draw again', h('p.dialog-help', null, 'Which one? The new one replaces the one kept for you; what is already placed on this document stays as it is.'), [h('button.btn.ghost', { type: 'button', onclick: () => { d.close(); resolve(null); } }, 'Cancel'), pick('initials'), pick('signature')]);
    });
    if (which) await getStamp(which, true);
  }

  /** A pad to draw on (or an image to bring in); the ink is trimmed to its own size. */
  function drawStamp(kind: StampKind): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      const W = 1120, H = kind === 'signature' ? 360 : 300;
      const pad = h('canvas.sign-pad', { width: W, height: H, style: `--pad-ratio: ${W / H}`, 'aria-label': `Draw your ${WORD[kind].noun}` });
      const ctx = pad.getContext('2d')!;
      ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111827';
      let inked = false, last: { x: number; y: number } | null = null;
      const at = (e: PointerEvent) => { const b = pad.getBoundingClientRect(); return { x: (e.clientX - b.left) * W / b.width, y: (e.clientY - b.top) * H / b.height }; };
      pad.addEventListener('pointerdown', (e) => { e.preventDefault(); pad.setPointerCapture(e.pointerId); last = at(e); ctx.beginPath(); ctx.arc(last.x, last.y, 2.2, 0, Math.PI * 2); ctx.fillStyle = '#111827'; ctx.fill(); inked = true; use.disabled = false; });
      pad.addEventListener('pointermove', (e) => {
        if (!last) return;
        // Through the midpoints: a hand's line, not a polygon.
        const p = at(e), mid = { x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 };
        ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.quadraticCurveTo(last.x, last.y, mid.x, mid.y); ctx.lineTo(p.x, p.y); ctx.stroke();
        last = p;
      });
      const lift = () => { last = null; };
      pad.addEventListener('pointerup', lift); pad.addEventListener('pointercancel', lift);
      // A finger on the pad only draws. The touch itself is refused: touch-action alone does not hold the page still on every phone, and a page that scrolls takes the stroke away.
      for (const type of ['touchstart', 'touchmove'] as const) pad.addEventListener(type, (e) => e.preventDefault(), { passive: false });
      const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
      file.addEventListener('change', async () => {
        const f = file.files?.[0];
        if (!f) return;
        try {
          const img = await createImageBitmap(f);
          const s = Math.min(W / img.width, H / img.height);
          ctx.clearRect(0, 0, W, H);
          ctx.drawImage(img, (W - img.width * s) / 2, (H - img.height * s) / 2, img.width * s, img.height * s);
          // Paper becomes nothing: a scan of a signature is ink on white.
          const px = ctx.getImageData(0, 0, W, H);
          for (let i = 0; i < px.data.length; i += 4) { const lum = 0.299 * px.data[i] + 0.587 * px.data[i + 1] + 0.114 * px.data[i + 2]; px.data[i + 3] = Math.min(px.data[i + 3], clamp((235 - lum) * 4, 0, 255)); }
          ctx.putImageData(px, 0, 0);
          inked = true; use.disabled = false;
        } catch { o.host.toast('That image could not be read.', 'error'); }
      });
      const done = (v: Uint8Array | null) => { d.close(); resolve(v); };
      const use = h('button.btn.primary', { type: 'button', disabled: true, onclick: () => {
        if (!inked) return;
        // Trim to the ink, with a little air.
        const px = ctx.getImageData(0, 0, W, H).data;
        let x0 = W, y0 = H, x1 = 0, y1 = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (px[(y * W + x) * 4 + 3] > 12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        if (x1 <= x0 || y1 <= y0) return;
        x0 = Math.max(0, x0 - 8); y0 = Math.max(0, y0 - 8); x1 = Math.min(W - 1, x1 + 8); y1 = Math.min(H - 1, y1 + 8);
        const out = document.createElement('canvas');
        out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
        out.getContext('2d')!.drawImage(pad, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
        out.toBlob((b) => { void b?.arrayBuffer().then((buf) => done(new Uint8Array(buf))); }, 'image/png');
      } }, `Use these ${kind === 'signature' ? 'as my signature' : 'as my initials'}`.replace('these as my signature', 'this as my signature'));
      const body = h('div.sign-pad-wrap', null,
        h('p.dialog-help', null, `Draw your ${WORD[kind].noun} with a mouse, a finger or a pen. ${kind === 'signature' ? 'It is' : 'They are'} kept for you alone, and only you can put ${kind === 'signature' ? 'it' : 'them'} on a document.`),
        pad, file);
      const d = o.host.dialog(kind === 'signature' ? 'Your signature' : 'Your initials', body, [
        h('button.btn.ghost', { type: 'button', onclick: () => { ctx.clearRect(0, 0, W, H); inked = false; use.disabled = true; } }, 'Clear'),
        h('button.btn.ghost', { type: 'button', onclick: () => file.click() }, 'Use an image…'),
        h('span.tb-spacer'),
        h('button.btn.ghost', { type: 'button', onclick: () => done(null) }, 'Cancel'),
        use,
      ]);
    });
  }

  // ------------------------------------------------------------------ writing it into the PDF

  /** A point of the page as shown (points from its top left) in the page's own space, whatever its rotation and crop. */
  const mapper = (page: PDFPage) => pageMapper(page.getRotation().angle, shownBox(page.getCropBox(), page.getMediaBox()));

  /** Text as a picture, for writing a script the fonts here do not hold. */
  async function textPicture(text: string, size: number): Promise<{ png: Uint8Array; w: number; h: number }> {
    const lines = text.split('\n'), k = 4;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d')!;
    const font = `${size * k}px Helvetica, Arial, sans-serif`;
    ctx.font = font;
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width), 1), hh = lines.length * size * LINE * k;
    c.width = Math.ceil(w); c.height = Math.ceil(hh);
    ctx.font = font; ctx.fillStyle = '#000'; ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l, 0, (i + 0.5) * size * LINE * k));
    const blob = await new Promise<Blob>((ok) => c.toBlob((b) => ok(b!), 'image/png'));
    return { png: new Uint8Array(await blob.arrayBuffer()), w: w / k, h: hh / k };
  }

  async function build(): Promise<{ bytes: Uint8Array; signed: { id: string; kind: StampKind }[]; missed: string[]; open: boolean }> {
    const doc = await PDFDocument.load(original);
    const texts = items.filter((i): i is TextItem => i.type === 'text').map((i) => ({ item: i, text: (i.body.innerText ?? '').replace(/ /g, ' ').replace(/\n+$/, '') })).filter((t) => t.text.trim());
    const typed = [...texts.map((t) => t.text), ...[...form.values()].filter((v) => v.type === 'text' && v.value !== v.initial).map((v) => String(v.value))].join('');
    // Helvetica writes Western European text; anything else needs a font that holds it (Latin, Cyrillic, Greek).
    let font: PDFFont;
    const plain = !/[^\n\x20-\x7e\xa1-\xff]/.test(typed);
    if (plain) font = await doc.embedFont(StandardFonts.Helvetica);
    else {
      doc.registerFontkit(fontkit as never);
      // Whole, not a subset of it: subsetting fails in this pair of libraries (the file grows by the font, some 400 KB).
      font = await doc.embedFont(await (await fetch('/pdfjs/standard_fonts/LiberationSans-Regular.ttf')).arrayBuffer());
    }
    const holds = (s: string) => { const set = new Set(font.getCharacterSet()); return [...s].every((ch) => ch === '\n' || set.has(ch.codePointAt(0)!)); };

    const missed: string[] = [];
    const changedFields = [...form].filter(([, v]) => v.value !== v.initial);
    if (changedFields.length) {
      const f = doc.getForm();
      // A form that also carries an XFA copy shows that copy in some readers: without it, every reader shows these values.
      try { if (f.hasXFA()) f.deleteXFA(); } catch { /* none */ }
      for (const [name, v] of changedFields) {
        try {
          if (v.type === 'text') {
            // A value no font here can write is left out and said: writing it would fail the whole save.
            if (!holds(String(v.value))) { missed.push(name); continue; }
            const t = f.getTextField(name);
            t.setText(String(v.value));
            if (!plain) t.updateAppearances(font);
          }
          else if (v.type === 'check') { const c = f.getCheckBox(name); if (v.value) c.check(); else c.uncheck(); }
          else if (v.type === 'radio') f.getRadioGroup(name).select(String(v.value));
          else { const d = f.getDropdown(name); if (v.value) d.select(String(v.value)); else d.clear(); }
        } catch { missed.push(name); }
      }
    }

    const pictures = new Map<Stamp, PDFImage>();
    for (const t of texts) {
      const page = doc.getPage(t.item.page - 1);
      const m = mapper(page);
      const u = t.item.x * m.shown.w, v = t.item.y * m.shown.h, size = t.item.size;
      if (!holds(t.text)) {
        const pic = await textPicture(t.text, size);
        const o2 = m.at(u, v + pic.h);
        page.drawImage(await doc.embedPng(pic.png), { x: o2.x, y: o2.y, width: pic.w, height: pic.h, rotate: degrees(m.rot) });
        continue;
      }
      // The first baseline sits where the browser put it: the line's leading split above and below the letters.
      const ascent = font.heightAtSize(size, { descender: false }), tall = font.heightAtSize(size);
      t.text.split('\n').forEach((line, k) => {
        const b = m.at(u, v + (size * LINE - tall) / 2 + ascent + k * size * LINE);
        if (line) page.drawText(line, { x: b.x, y: b.y, size, font, rotate: degrees(m.rot) });
      });
    }
    const signed: { id: string; kind: StampKind }[] = [];
    for (const i of items) {
      if (i.type !== 'image') continue;
      const page = doc.getPage(i.page - 1);
      const m = mapper(page);
      const w = i.w * m.shown.w, hh = i.h * m.shown.h;
      const at = m.at(i.x * m.shown.w, i.y * m.shown.h + hh);
      if (!pictures.has(i.stamp)) pictures.set(i.stamp, await doc.embedPng(i.stamp.png));
      page.drawImage(pictures.get(i.stamp)!, { x: at.x, y: at.y, width: w, height: hh, rotate: degrees(m.rot) });
      if (i.fieldId && !i.fieldId.startsWith('own:')) signed.push({ id: i.fieldId, kind: i.kind });
    }
    // Signed: what was filled in becomes part of the page, no longer fields someone can change.
    let open = false;
    if (items.some((i) => i.type === 'image') && doc.catalog.has(PDFName.of('AcroForm')) && doc.getForm().getFields().length) {
      try { doc.getForm().flatten(); } catch { open = true; }
    }
    return { bytes: await doc.save(), signed, missed, open };
  }

  async function save() {
    if (saving || !dirty()) return;
    saving = true; changed();
    saveBtn.textContent = 'Saving…';
    // Nothing changes under a save: what is typed while it runs would not be in it.
    el.classList.add('saving');
    (document.activeElement as HTMLElement | null)?.blur?.();
    try {
      const { bytes, signed, missed, open } = await build();
      await o.save(bytes, signed);
      if (open) o.host.toast('Saved and signed, but this PDF’s form fields could not be made final: they can still be edited in the file.', 'info');
      if (missed.length) o.host.toast(`Saved, but ${missed.length === 1 ? 'one field' : `${missed.length} fields`} could not be filled in this PDF (${missed.slice(0, 3).join(', ')}): type over ${missed.length === 1 ? 'it' : 'them'} with Text.`, 'info');
      items.length = 0; form.clear();
      o.close();
    } catch (e) {
      o.host.toast(e instanceof Error && /encrypt/i.test(e.message) ? 'This PDF is protected and cannot be filled in here.' : e instanceof Error ? e.message : 'Could not save.', 'error');
    } finally { saving = false; el.classList.remove('saving'); saveBtn.textContent = 'Save'; changed(); }
  }
  async function leave() {
    if (dirty() && !(await o.host.confirm(`Leave ${o.name}?`, 'What you filled in and placed has not been saved.', 'Leave'))) return;
    items.length = 0; form.clear();
    o.close();
  }

  // ------------------------------------------------------------------ start

  // The first page gives every page its size before any is drawn (the layout does not jump as pages arrive).
  const first = await open(pages[0]);
  const fv = first.getViewport({ scale: 1 });
  for (const p of pages) { if (!p.opening) { p.w = fv.width; p.h = fv.height; } p.el.style.aspectRatio = `${p.w} / ${p.h}`; sized.observe(p.el); seen.observe(p.el); }
  // Every page with a place to sign is read now, so its fields are there to be found.
  await Promise.all([...new Set(fields.map((f) => f.page))].filter((n) => n >= 1 && n <= pages.length).map((n) => open(pages[n - 1])));
  drawFields();
  setTool('none');
  changed();
  requestAnimationFrame(() => { if (fields.some((f) => f.forMe)) goToField(); });
  // The rest of the pages are read one after another, so the PDF's own places to sign are all counted.
  void (async () => { for (const p of pages) { if (destroyed) return; await open(p).catch(() => undefined); } })();

  return {
    el,
    dirty,
    save,
    setFields(next) {
      fields = next;
      for (const i of items) if (i.type === 'image' && i.fieldId && !i.fieldId.startsWith('own:') && !next.some((f) => f.id === i.fieldId)) i.fieldId = null;
      drawFields();
    },
    destroy() {
      destroyed = true;
      sized.disconnect(); seen.disconnect();
      for (const s of stamps.values()) URL.revokeObjectURL(s.url);
      void pdf.loadingTask.destroy();
    },
  };
}
