// The left navigation: spaces (a space is a tree whose root is a document),
// the current space's pages (drag to move, right-click for actions), the
// wiki state, and this document's outline of sections.

import { api, atLeast, type PublishSettings, type Role, type TreeRoot, type TreeView } from '../lib/api';
import { h } from '../lib/dom';
import { icon } from '../lib/icons';
import { confirmDialog, errorMessage, openDialog, openMenu, promptDialog, toast, type MenuItem } from '../lib/ui';
import type { Layout } from './nodes/layout';

export interface NavDeps {
  docId: string;
  role: () => Role | null;
  /** The space this page was opened through (from the URL), if any. */
  tree: string | null;
  onOpen: (id: string, tree: string | null) => void;
  /** Names of nodes in the view (for the outline), by id. */
  label: (id: string) => { title: string; section: boolean } | undefined;
  onChanged?: () => void;
  /** Choose a document the person can open (the page's picker dialog). */
  pickDocument?: (title: string) => Promise<{ id: string; title: string } | null>;
}

const collapsedKey = (tree: string) => `docs.nav.collapsed.${tree}`;
type DropZone = 'before' | 'after' | 'inside';

export class NavPanel {
  readonly el: HTMLElement;
  private spaceEl = h('div.nav-space');
  private pagesEl = h('div.nav-pages');
  private outlineEl = h('div.nav-outline');
  private wikiEl = h('div.nav-wiki');
  private roots: TreeRoot[] = [];
  private view: TreeView | null = null;
  private layout: Layout | null = null;
  private collapsed = new Set<string>();
  /** Spaces the open document is in (a page can be placed in several). */
  private inSpaces: string[] = [];
  tree: string | null;
  private destroyed = false;
  private dragging: { child: string; from: string } | null = null;

  constructor(private deps: NavDeps) {
    this.tree = deps.tree;
    this.el = h('nav.doc-nav', { 'aria-label': 'Pages' },
      h('div.nav-section.nav-section-space', null, this.spaceEl),
      h('div.nav-section.nav-section-pages', null, this.wikiEl, this.pagesEl),
      h('div.nav-section', null, h('div.nav-head', null, 'Sections in this page'), this.outlineEl));
    this.loadCollapsed();
    void this.refresh();
  }

  private loadCollapsed() {
    this.collapsed.clear();
    if (!this.tree) return;
    try { for (const k of JSON.parse(localStorage.getItem(collapsedKey(this.tree)) ?? '[]')) this.collapsed.add(String(k)); } catch { /* ignore */ }
  }
  private saveCollapsed() {
    if (!this.tree) return;
    try { localStorage.setItem(collapsedKey(this.tree), JSON.stringify([...this.collapsed])); } catch { /* ignore */ }
  }

  async refresh() {
    try {
      const r = await api.trees();
      if (this.destroyed) return;
      this.roots = r.trees.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      if (this.tree && !this.roots.some((t) => t.root === this.tree)) this.tree = null;
      const p = await api.paths(this.deps.docId).catch(() => null);
      if (this.destroyed) return;
      this.inSpaces = [...new Set([...(p?.root ? [this.deps.docId] : []), ...(p?.paths.map((x) => x.tree) ?? [])])];
      // A page in exactly one space is shown in it even without ?tree=.
      if (!this.tree) {
        if (p?.root) this.tree = this.deps.docId;
        else if (this.inSpaces.length === 1) this.tree = this.inSpaces[0];
        this.loadCollapsed();
      }
      this.view = this.tree ? await api.treeView(this.tree) : null;
    } catch (e) {
      if (this.destroyed) return;
      this.roots = []; this.view = null;
      this.pagesEl.replaceChildren(h('div.nav-note', null, errorMessage(e)));
    }
    this.render();
    this.deps.onChanged?.();
  }

  setLayout(L: Layout) { this.layout = L; this.renderOutline(); }

  /** Another document opened in the same shell: keep the spaces and the space, re-point the panel at it. */
  rebind(deps: NavDeps) {
    const treeChanged = deps.tree !== null && deps.tree !== this.tree;
    this.deps = deps;
    this.layout = null;
    if (treeChanged) { this.tree = deps.tree; this.loadCollapsed(); }
    this.render();
    void this.refresh();
  }

  /** Subpages of the open document in the current space that are not mounted inline (for the editor's footer). */
  subpagesNotInline(): { id: string; title: string }[] {
    if (!this.view || !this.layout) return [];
    const inline = new Set(this.layout.mounts.map((m) => m.child));
    const byId = new Map(this.view.nodes.map((n) => [n.id, n]));
    return this.view.placements.filter((p) => p.parent === this.deps.docId && !inline.has(p.child)).sort((a, b) => a.ord - b.ord)
      .map((p) => ({ id: p.child, title: byId.get(p.child)?.title ?? '' }));
  }

  /** Breadcrumb of the open document in the current space. */
  crumbs(): { id: string; title: string }[] {
    if (!this.view) return [];
    const byId = new Map(this.view.nodes.map((n) => [n.id, n]));
    const path = pathTo(this.view, this.deps.docId);
    return path ? path.map((id) => ({ id, title: byId.get(id)?.title ?? '' })) : [];
  }

  private render() {
    const top = this.el.scrollTop;
    this.renderSpace();
    this.renderPages();
    this.renderOutline();
    this.el.scrollTop = top;
  }

  // ------------------------------------------------------------------ spaces

  private renderSpace() {
    const canEdit = atLeast(this.deps.role(), 'editor');
    const cur = this.roots.find((t) => t.root === this.tree);
    const btn: HTMLButtonElement = h('button.nav-space-btn', { type: 'button', 'aria-haspopup': 'listbox', 'aria-label': 'Choose a space', onclick: () => this.spaceMenu(btn) },
      icon('columns', 16), h('span.nav-space-name', null, cur ? (cur.title || 'Untitled') : this.roots.length ? 'Choose a space' : 'No spaces yet'), icon('chevronDown', 14));
    const actions = h('span.nav-space-acts', null,
      canEdit && !this.roots.some((t) => t.root === this.deps.docId)
        ? h('button.nav-act.make-space', { type: 'button', 'aria-label': 'Make this document a space', 'data-tip': 'Make this document the root of a space', onclick: () => void this.makeSpace() }, '+')
        : null,
      cur && this.view
        ? h('button.nav-act.space-more', { type: 'button', 'aria-label': 'Space actions', 'aria-haspopup': 'menu', 'data-tip': 'Space actions', onclick: (e: MouseEvent) => this.spaceActions(e.currentTarget as HTMLElement) }, '⋯')
        : null);
    // A page in several spaces says so, with a switch to each of the others.
    const others = this.inSpaces.filter((t) => t !== this.tree).map((t) => this.roots.find((r) => r.root === t)).filter((r): r is TreeRoot => !!r);
    const also = others.length
      ? h('div.nav-space-also', null, h('span.meta', null, this.tree ? 'Also in ' : 'In '), ...others.flatMap((r, i) => [i ? h('span.meta', null, ' · ') : null, h('button.link-btn', { type: 'button', onclick: () => { this.tree = r.root; this.loadCollapsed(); void this.refresh(); this.deps.onOpen(this.deps.docId, r.root); } }, r.title || 'Untitled')]))
      : null;
    this.spaceEl.replaceChildren(h('div.nav-space-row', null, btn, actions), ...(also ? [also] : []));
  }

  private spaceMenu(anchor: HTMLElement) {
    const pop = h('div.nav-space-pop', { role: 'listbox', 'aria-label': 'Spaces' });
    const input = h('input.input.sm', { type: 'search', placeholder: 'Find a space', 'aria-label': 'Find a space' });
    const list = h('div.nav-space-list');
    const fill = () => {
      const q = input.value.trim().toLowerCase();
      const items = this.roots.filter((t) => !q || (t.title || '').toLowerCase().includes(q));
      list.replaceChildren(...items.map((t) => h('button.nav-space-item', { type: 'button', role: 'option', 'aria-selected': String(t.root === this.tree), class: t.root === this.tree ? 'on' : '', onclick: () => { close(); this.tree = t.root; this.loadCollapsed(); void this.refresh(); this.deps.onOpen(t.root, t.root); } },
        h('span', null, t.title || 'Untitled'), h('span.meta', null, t.role))));
      if (!items.length) list.replaceChildren(h('div.nav-note', null, this.roots.length ? 'No space matches.' : 'A space is a document whose subpages show here, Notion-style. Make one with + above.'));
    };
    input.addEventListener('input', fill);
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } if (e.key === 'Enter') { (list.querySelector('.nav-space-item') as HTMLButtonElement | null)?.click(); } });
    pop.append(input, list);
    fill();
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${r.left}px`; pop.style.top = `${r.bottom + 4}px`; pop.style.minWidth = `${Math.max(240, r.width)}px`;
    document.body.append(pop);
    const close = () => { pop.remove(); document.removeEventListener('mousedown', onDown, true); };
    const onDown = (e: MouseEvent) => { if (!pop.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) close(); };
    setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
    input.focus();
  }

  /** The current space's own actions (also in the root row's context menu). */
  private spaceActions(anchor: HTMLElement) {
    const v = this.view;
    if (!v) return;
    const items: MenuItem[] = [{ label: 'Open the space’s root page', icon: 'file', onSelect: () => this.deps.onOpen(v.root, v.root) }];
    if (atLeast(v.role, 'editor')) items.push({ label: 'New page in this space…', icon: 'plus', onSelect: () => void this.newSubpage(v.root) }, { label: 'Add an existing document…', icon: 'file', onSelect: () => void this.addExisting(v.root) });
    if (v.role === 'owner') items.push('separator', { label: 'Wiki settings…', icon: 'globe', onSelect: () => void this.publishDialog() }, { label: 'Stop being a space', icon: 'x', danger: true, onSelect: () => void this.dropTree() });
    openMenu(anchor, items, { align: 'end' });
  }

  private async makeSpace() {
    const ok = await confirmDialog({
      title: 'Make this document a space?',
      message: h('span', null, 'Its subpages show in the left panel, Notion-style: documents mounted inside it become pages, and you can place or drag other pages under it. ', h('strong', null, 'This can be undone'), ' with “Stop being a space” (⋯ next to the space name): the pages stay, only the navigation goes.'),
      confirmLabel: 'Make it a space',
    });
    if (!ok) return;
    try {
      await api.createTree(this.deps.docId);
      this.tree = this.deps.docId;
      toast('This document is a space now. Documents mounted inside it are its pages; drag pages in the panel to arrange them.', { kind: 'success' });
      await this.refresh();
      this.deps.onOpen(this.deps.docId, this.tree);
    } catch (e) { toast(errorMessage(e), { kind: 'error' }); }
  }

  // ------------------------------------------------------------------ wiki

  private renderWiki() {
    const v = this.view;
    if (!v || !v.publish) { this.wikiEl.replaceChildren(); return; }
    const ps = v.publish;
    const owner = v.role === 'owner';
    const live = ps.published !== 'off' && v.url;
    this.wikiEl.replaceChildren(h('div.nav-wiki-row', null,
      live ? h('a.nav-wiki-link', { href: v.url!, target: '_blank', rel: 'noopener' }, icon('globe', 14), ps.published === 'public' ? 'View wiki' : 'View wiki (members)') : h('span.meta', null, owner ? 'Not published' : ''),
      owner ? h('button.nav-act.wide', { type: 'button', 'data-tip': 'Publish this space as a wiki', onclick: () => void this.publishDialog() }, live ? 'Settings' : 'Publish…') : null));
  }

  private async publishDialog() {
    const v = this.view;
    if (!v || !v.publish) return;
    const ps = v.publish;
    const field = (label: string, input: HTMLElement, help?: string) => h('label.field', null, h('span.field-label', null, label), input, help ? h('span.field-help', null, help) : null);
    const vis = (value: PublishSettings['published'], label: string, help: string) => h('label.radio', null, h('input', { type: 'radio', name: 'pub', value, checked: ps.published === value }), h('span', null, h('strong', null, label), ' ', h('span.meta', null, help)));
    const slug = h('input.input', { type: 'text', value: ps.slug ?? '', placeholder: 'address, e.g. handbook', pattern: '[a-z0-9-]*', maxlength: '64' });
    const name = h('input.input', { type: 'text', value: ps.theme.name ?? '', placeholder: v.title, maxlength: '120' });
    const emoji = h('input.input.sm', { type: 'text', value: ps.theme.emoji ?? '', placeholder: '📘', maxlength: '8', style: 'width:72px' });
    const tagline = h('input.input', { type: 'text', value: ps.theme.tagline ?? '', placeholder: 'A short line under the name', maxlength: '120' });
    const accent = h('input', { type: 'color', value: ps.theme.accent ?? '#2459e0', 'aria-label': 'Accent colour' });
    const footer = h('input.input', { type: 'text', value: ps.theme.footer ?? '', placeholder: 'Footer text (licence, contact…)', maxlength: '400' });
    const domain = h('input.input', { type: 'text', value: ps.domain ?? '', placeholder: 'wiki.example.org (optional)', maxlength: '253' });
    const css = h('textarea.input.code', { rows: 8, spellcheck: 'false', placeholder: '/* Extra CSS for the wiki. Hooks: .top .brand .side .article .prose .asides .panel .infobox .page-foot .site-foot; variables --accent --ink --paper --panel --serif --sans */' });
    css.value = ps.theme.css ?? '';
    const template = h('textarea.input.code', { rows: 10, spellcheck: 'false', placeholder: 'Leave empty for the standard layout. HTML with {{slots}}: {{head}} {{brand}} {{tagline}} {{search}} {{edit}} {{nav}} {{crumbs}} {{title}} {{content}} {{infoboxes}} {{contents}} {{related}} {{asides}} {{subpages}} {{pagefoot}} {{footer}} {{lightbox}}. Scripts are removed unless scripts are allowed below.' });
    template.value = ps.theme.template ?? '';
    const loadDefault = h('button.btn.ghost.sm', { type: 'button', onclick: async () => { try { const r = await api.wikiTemplate(); template.value = r.template; template.focus(); } catch (e) { toast(errorMessage(e), { kind: 'error' }); } } }, 'Start from the standard layout');
    const scripts = h('input', { type: 'checkbox', checked: !!ps.scripts });
    const scriptsRow = h('label.radio', null, scripts, h('span', null, h('strong', null, 'Allow HTML and scripts'), ' ', h('span.meta', null, 'raw HTML and <script> in pages and the template. Runs only on the wiki’s own host (its domain or the shared wiki host), never here. Anyone who can edit a page can then run code in visitors’ browsers.')));
    const err = h('div.field-error', { role: 'alert' });
    const urlLine = h('p.meta', null, v.url ? h('span', null, 'Live at ', h('a', { href: v.url, target: '_blank', rel: 'noopener' }, v.url)) : 'Published spaces get an address under /w/<address>/; a custom domain serves the wiki at its root.');
    const body = h('div.form-stack', null,
      h('div.radio-stack', null,
        vis('off', 'Not published', 'only the editor'),
        vis('members', 'Members', 'anyone signed in with Archipelago can read'),
        vis('public', 'Public', 'anyone on the internet can read; the wiki can have its own domain')),
      field('Address', slug, 'Lowercase letters, digits and hyphens.'),
      h('div.row-gap', null, field('Emoji', emoji), field('Name', name)),
      field('Tagline', tagline),
      h('div.row-gap', null, field('Accent', accent), field('Footer', footer)),
      field('Custom domain', domain, 'Point a CNAME at the service first; then set it here. Public wikis only.'),
      field('Custom CSS', css, 'Appended after the wiki’s own stylesheet.'),
      field('Layout template', template, 'For changes CSS cannot make: the structure of the page.'),
      h('div.row-gap', null, loadDefault),
      scriptsRow,
      urlLine, err);
    const save = async () => {
      const published = (body.querySelector('input[name=pub]:checked') as HTMLInputElement).value as PublishSettings['published'];
      try {
        const r = await api.publishTree(v.root, {
          published, slug: slug.value.trim() || null, domain: domain.value.trim() || null, scripts: scripts.checked,
          theme: { name: name.value, emoji: emoji.value, tagline: tagline.value, accent: accent.value, footer: footer.value, css: css.value, template: template.value },
        });
        d.close();
        toast(r.url && published !== 'off' ? h('span', null, 'Published: ', h('a', { href: r.url, target: '_blank', rel: 'noopener' }, r.url)) : 'Saved.', { kind: 'success', timeout: 8000 });
        await this.refresh();
      } catch (e) { err.textContent = errorMessage(e); }
    };
    const d = openDialog({ title: 'Publish as a wiki', body, footer: [h('button.btn.ghost', { type: 'button', onclick: () => d.close() }, 'Cancel'), h('button.btn.primary', { type: 'button', onclick: () => void save() }, 'Save')] });
  }

  // ------------------------------------------------------------------ pages

  private renderPages() {
    const v = this.view;
    this.renderWiki();
    if (!v) {
      this.pagesEl.replaceChildren(h('div.nav-note', null, this.roots.length ? 'Choose a space above to see its pages.' : 'No spaces yet. A space is a document whose pages show here, Notion-style.'));
      return;
    }
    const byId = new Map(v.nodes.map((n) => [n.id, n]));
    const canArrange = atLeast(v.role, 'editor');
    const rows: HTMLElement[] = [];
    const row = (id: string, depth: number, parent: string | null, index: number) => {
      const n = byId.get(id);
      const kids = v.placements.filter((p) => p.parent === id).sort((a, b) => a.ord - b.ord);
      const col = this.collapsed.has(id);
      const current = id === this.deps.docId;
      const tri = kids.length
        ? h('button.nav-tri', { type: 'button', 'aria-label': col ? 'Expand' : 'Collapse', onclick: (e: Event) => { e.stopPropagation(); if (col) this.collapsed.delete(id); else this.collapsed.add(id); this.saveCollapsed(); this.renderPages(); } }, col ? '▸' : '▾')
        : h('span.nav-tri.leaf', null, '·');
      const el = h('div.nav-row', {
        class: `${current ? 'current' : ''}${parent === null ? ' root' : ''}`, style: `--d:${depth}`, role: 'treeitem', 'aria-level': String(depth + 1),
        draggable: canArrange && parent !== null ? 'true' : undefined,
        'data-id': id, 'data-parent': parent ?? '', 'data-index': String(index),
        onclick: () => this.deps.onOpen(id, v.root),
        oncontextmenu: (e: MouseEvent) => { e.preventDefault(); this.contextMenu(e, id, parent, index); },
      },
        tri, h('span.nav-name', { class: n?.section ? 'nameless' : '' }, n ? (n.section ? 'section' : n.title || 'Untitled') : id),
        n?.type === 'html' ? h('span.type-chip', { 'data-tip': 'An HTML page' }, 'HTML') : null,
        canArrange ? h('button.nav-act.nav-add', { type: 'button', 'aria-label': 'New subpage', 'data-tip': 'New subpage', onclick: (e: MouseEvent) => { e.stopPropagation(); void this.newSubpage(id); } }, '+') : null,
        h('button.nav-act.nav-more', { type: 'button', 'aria-label': 'Page actions', 'aria-haspopup': 'menu', onclick: (e: MouseEvent) => { e.stopPropagation(); this.contextMenu(e, id, parent, index); } }, '⋯'));
      if (canArrange) this.wireDrag(el, id, parent, index);
      rows.push(el);
      if (!col) kids.forEach((p, i) => { if (p.child !== id) row(p.child, depth + 1, id, i); });
    };
    row(v.root, 0, null, 0);
    this.pagesEl.replaceChildren(h('div.nav-tree', { role: 'tree', 'aria-label': `Pages in ${v.title}` }, ...rows));
  }

  /** Drag a page onto another (nest it there) or between two (reorder). */
  private wireDrag(el: HTMLElement, id: string, parent: string | null, index: number) {
    if (parent !== null) {
      el.addEventListener('dragstart', (e) => {
        this.dragging = { child: id, from: parent };
        e.dataTransfer?.setData('text/plain', id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => { this.dragging = null; el.classList.remove('dragging'); this.clearDropMarks(); });
    }
    el.addEventListener('dragover', (e) => {
      if (!this.dragging || this.dragging.child === id) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const zone = this.zoneOf(e, el, parent === null);
      this.clearDropMarks();
      el.classList.add(`drop-${zone}`);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after', 'drop-inside'));
    el.addEventListener('drop', (e) => {
      if (!this.dragging || this.dragging.child === id) return;
      e.preventDefault();
      const zone = this.zoneOf(e, el, parent === null);
      const d = this.dragging;
      this.dragging = null;
      this.clearDropMarks();
      let to: string, at: number | null;
      if (zone === 'inside' || parent === null) { to = id; at = null; }
      else { to = parent; at = zone === 'before' ? index : index + 1; if (d.from === to && this.indexOf(d.from, d.child) < at) at -= 1; }
      void this.reparent(d.child, d.from, to, at);
    });
  }
  private zoneOf(e: DragEvent, el: HTMLElement, rootRow: boolean): DropZone {
    if (rootRow) return 'inside';
    const r = el.getBoundingClientRect();
    const y = (e.clientY - r.top) / Math.max(1, r.height);
    return y < 0.3 ? 'before' : y > 0.7 ? 'after' : 'inside';
  }
  private clearDropMarks() { for (const x of this.pagesEl.querySelectorAll('.drop-before, .drop-after, .drop-inside')) x.classList.remove('drop-before', 'drop-after', 'drop-inside'); }
  private indexOf(parent: string, child: string): number {
    const v = this.view;
    if (!v) return -1;
    return v.placements.filter((p) => p.parent === parent).sort((a, b) => a.ord - b.ord).findIndex((p) => p.child === child);
  }

  private async reparent(child: string, from: string, to: string, index: number | null) {
    const v = this.view;
    if (!v) return;
    try { await api.reparent(v.root, child, from, to, index); await this.refresh(); }
    catch (e) { toast(errorMessage(e), { kind: 'error' }); }
  }

  /** Right-click (or ⋯) on a page. */
  private contextMenu(e: MouseEvent, id: string, parent: string | null, index: number) {
    const v = this.view;
    if (!v) return;
    const n = v.nodes.find((x) => x.id === id);
    const canArrange = atLeast(v.role, 'editor');
    const canEditPage = atLeast(n?.role ?? null, 'editor');
    const siblings = parent ? v.placements.filter((p) => p.parent === parent).sort((a, b) => a.ord - b.ord) : [];
    const items: MenuItem[] = [
      { label: 'Open', icon: 'file', onSelect: () => this.deps.onOpen(id, v.root) },
      { label: 'Open in new tab', icon: 'external', onSelect: () => window.open(`/d/${id}?tree=${encodeURIComponent(v.root)}`, '_blank', 'noopener') },
      { label: 'Copy link', icon: 'link', onSelect: () => { const url = `${location.origin}/d/${id}?tree=${encodeURIComponent(v.root)}`; void navigator.clipboard.writeText(url).then(() => toast('Link copied', { kind: 'success', timeout: 2000 }), () => toast(url)); } },
    ];
    if (canArrange) {
      items.push('separator', { label: 'New subpage…', icon: 'plus', onSelect: () => void this.newSubpage(id) }, { label: 'Add an existing document here…', icon: 'file', onSelect: () => void this.addExisting(id) });
      if (parent) {
        items.push(
          { label: 'Move up', icon: 'arrowLeft', disabled: index === 0, onSelect: () => void this.act(api.movePage(v.root, parent, id, 'up')) },
          { label: 'Move down', icon: 'arrowLeft', disabled: index >= siblings.length - 1, onSelect: () => void this.act(api.movePage(v.root, parent, id, 'down')) },
          { label: 'Move to…', icon: 'columns', onSelect: () => void this.moveToDialog(id, parent) },
          { label: 'Remove from this space', icon: 'x', onSelect: () => void this.act(api.unplace(v.root, parent, id)) });
      }
    }
    if (canEditPage) items.push('separator', { label: 'Rename…', icon: 'pencil', onSelect: () => void this.rename(id, n?.title ?? '') });
    if (n?.role === 'owner' && id !== v.root) items.push({ label: 'Delete page', icon: 'trash', danger: true, onSelect: () => void this.remove(id, n?.title ?? '') });
    if (id === v.root && v.role === 'owner') items.push('separator', { label: 'Wiki settings…', icon: 'globe', onSelect: () => void this.publishDialog() }, { label: 'Stop being a space', icon: 'x', danger: true, onSelect: () => void this.dropTree() });
    // A throwaway anchor at the pointer: the menu positions itself relative to it, and goes when the menu does.
    const anchor = h('span', { style: `position:fixed;left:${e.clientX}px;top:${e.clientY}px;width:1px;height:1px;pointer-events:none` });
    document.body.append(anchor);
    openMenu(anchor, items, { align: 'start' });
    const obs = new MutationObserver(() => { if (!document.querySelector('.menu')) { anchor.remove(); obs.disconnect(); } });
    setTimeout(() => obs.observe(document.body, { childList: true, subtree: true }), 0);
  }

  private async moveToDialog(id: string, from: string) {
    const v = this.view;
    if (!v) return;
    const byId = new Map(v.nodes.map((n) => [n.id, n]));
    const options: { id: string; depth: number }[] = [{ id: v.root, depth: 0 }];
    const walk = (parent: string, depth: number, seen: Set<string>) => {
      for (const p of v.placements.filter((x) => x.parent === parent).sort((a, b) => a.ord - b.ord)) {
        if (p.child === id || seen.has(p.child)) continue;
        seen.add(p.child);
        options.push({ id: p.child, depth });
        walk(p.child, depth + 1, seen);
      }
    };
    walk(v.root, 1, new Set([v.root, id]));
    let chosen: string | null = null;
    const list = h('div.pick-list', { role: 'listbox' }, ...options.map((o) => h('button.pick-row', { type: 'button', role: 'option', style: `padding-left:${8 + o.depth * 14}px`, onclick: () => { chosen = o.id; d.close(); } }, icon('file', 16), h('span', null, byId.get(o.id)?.title || 'Untitled'))));
    const d = openDialog({ title: 'Move under…', size: 'sm', body: list, footer: [h('button.btn.ghost', { type: 'button', onclick: () => d.close() }, 'Cancel')], onClose: () => { if (chosen && chosen !== from) void this.reparent(id, from, chosen, null); } });
  }

  private async rename(id: string, title: string) {
    const next = await promptDialog({ title: 'Rename page', label: 'Name', value: title, confirmLabel: 'Rename' });
    if (next === null || next === title) return;
    try { await api.patchDoc(id, { title: next }); await this.refresh(); } catch (e) { toast(errorMessage(e), { kind: 'error' }); }
  }

  private async remove(id: string, title: string) {
    const ok = await confirmDialog({ title: 'Delete this page?', message: h('span', null, h('strong', null, `“${title || 'Untitled'}”`), ' will be deleted for everyone, with its comments and history.'), confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try { await api.deleteDoc(id); toast('Deleted', { kind: 'success', timeout: 2000 }); await this.refresh(); } catch (e) { toast(errorMessage(e), { kind: 'error' }); }
  }

  private renderOutline() {
    const L = this.layout;
    if (!L || !L.mounts.length) { this.outlineEl.replaceChildren(h('div.nav-note', null, 'No sections. Split the page (⌘↵) or mount another document to add one.')); return; }
    const rows = L.mounts.map((m) => {
      const l = this.deps.label(m.child);
      return h('div.nav-row.outline-row', { style: `--d:${m.depth - 1}`, onclick: () => this.deps.onOpen(m.child, this.tree) },
        h('span.nav-tri.leaf', null, m.collapsed ? '▸' : '·'), h('span.nav-name', { class: l?.section ? 'nameless' : '' }, l ? (l.section ? 'section' : l.title || 'Untitled') : '…'), m.role === 'aside' ? h('span.meta', null, 'aside') : null);
    });
    this.outlineEl.replaceChildren(...rows);
  }

  private async act(p: Promise<unknown>) {
    try { await p; await this.refresh(); } catch (e) { toast(errorMessage(e), { kind: 'error' }); }
  }

  private async newSubpage(parent: string) {
    const v = this.view;
    if (!v) return;
    const title = await promptDialog({ title: 'New subpage', label: 'Name', placeholder: 'Page name', confirmLabel: 'Create' });
    if (!title) return;
    try {
      const d = await api.createDoc(title, `# ${title}\n\n`);
      await api.place(v.root, parent, d.id);
      await this.refresh();
      this.deps.onOpen(d.id, v.root);
    } catch (e) { toast(errorMessage(e), { kind: 'error' }); }
  }

  /** Place a document the person can edit under a page of this space: everyone who can open the space can then open it. */
  private async addExisting(parent: string) {
    const v = this.view;
    if (!v || !this.deps.pickDocument) return;
    const chosen = await this.deps.pickDocument('Add a document to this space');
    if (!chosen) return;
    try {
      await api.place(v.root, parent, chosen.id);
      toast(h('span', null, h('strong', null, chosen.title || 'Untitled'), ' is in this space now: everyone who can open the space can open it.'), { kind: 'success', timeout: 5000 });
      await this.refresh();
    } catch (e) { toast(errorMessage(e), { kind: 'error' }); }
  }

  /** Ask before dropping a space (the owner of its root). */
  async dropTree() {
    if (!this.tree) return;
    const ok = await confirmDialog({ title: 'Stop being a space?', message: 'The pages stay; only the navigation goes.', confirmLabel: 'Remove space', danger: true });
    if (!ok) return;
    try { await api.dropTree(this.tree); this.tree = null; await this.refresh(); } catch (e) { toast(errorMessage(e), { kind: 'error' }); }
  }

  destroy() { this.destroyed = true; }
}

function pathTo(v: TreeView, node: string): string[] | null {
  if (node === v.root) return [v.root];
  const seen = new Set<string>();
  const walk = (cur: string, path: string[]): string[] | null => {
    if (seen.has(cur) || path.length > 24) return null;
    seen.add(cur);
    for (const p of v.placements.filter((x) => x.parent === cur)) {
      const next = [...path, p.child];
      if (p.child === node) return next;
      const r = walk(p.child, next);
      if (r) return r;
    }
    return null;
  };
  return walk(v.root, [v.root]);
}
