// The left navigation: trees (Notion-style page trees), the current tree's
// pages, and this document's outline of sections.

import { api, atLeast, type PublishSettings, type Role, type TreeRoot, type TreeView } from '../lib/api';
import { h } from '../lib/dom';
import { icon } from '../lib/icons';
import { confirmDialog, errorMessage, openDialog, promptDialog, toast } from '../lib/ui';
import type { Layout } from './nodes/layout';

export interface NavDeps {
  docId: string;
  role: () => Role | null;
  /** The tree this page was opened through (from the URL), if any. */
  tree: string | null;
  onOpen: (id: string, tree: string | null) => void;
  /** Names of nodes in the view (for the outline), by id. */
  label: (id: string) => { title: string; section: boolean } | undefined;
  onChanged?: () => void;
}

const collapsedKey = (tree: string) => `docs.nav.collapsed.${tree}`;

export class NavPanel {
  readonly el: HTMLElement;
  private treesEl = h('div.nav-trees');
  private pagesEl = h('div.nav-pages');
  private outlineEl = h('div.nav-outline');
  private wikiEl = h('div.nav-wiki');
  private roots: TreeRoot[] = [];
  private view: TreeView | null = null;
  private layout: Layout | null = null;
  private collapsed = new Set<string>();
  tree: string | null;
  private destroyed = false;

  constructor(private deps: NavDeps) {
    this.tree = deps.tree;
    this.el = h('nav.doc-nav', { 'aria-label': 'Pages' },
      h('div.nav-section', null, h('div.nav-head', null, 'Trees'), this.treesEl),
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
      this.roots = r.trees;
      if (this.tree && !this.roots.some((t) => t.root === this.tree)) this.tree = null;
      // A page in exactly one tree is shown in it even without ?tree=.
      if (!this.tree) {
        const p = await api.paths(this.deps.docId).catch(() => null);
        if (this.destroyed) return;
        const inTrees = p?.paths.map((x) => x.tree) ?? [];
        if (p?.root) this.tree = this.deps.docId;
        else if (inTrees.length === 1) this.tree = inTrees[0];
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

  /** Another document opened in the same shell: keep the trees and the tree, re-point the panel at it. */
  rebind(deps: NavDeps) {
    const treeChanged = deps.tree !== null && deps.tree !== this.tree;
    this.deps = deps;
    this.layout = null;
    if (treeChanged) { this.tree = deps.tree; this.loadCollapsed(); }
    this.render();
    void this.refresh();
  }

  /** Subpages of the open document in the current tree that are not mounted inline (for the editor's footer). */
  subpagesNotInline(): { id: string; title: string }[] {
    if (!this.view || !this.layout) return [];
    const inline = new Set(this.layout.mounts.map((m) => m.child));
    const byId = new Map(this.view.nodes.map((n) => [n.id, n]));
    return this.view.placements.filter((p) => p.parent === this.deps.docId && !inline.has(p.child)).sort((a, b) => a.ord - b.ord)
      .map((p) => ({ id: p.child, title: byId.get(p.child)?.title ?? '' }));
  }

  /** Breadcrumb of the open document in the current tree. */
  crumbs(): { id: string; title: string }[] {
    if (!this.view) return [];
    const byId = new Map(this.view.nodes.map((n) => [n.id, n]));
    const path = pathTo(this.view, this.deps.docId);
    return path ? path.map((id) => ({ id, title: byId.get(id)?.title ?? '' })) : [];
  }

  private render() {
    const top = this.el.scrollTop;
    const canEdit = atLeast(this.deps.role(), 'editor');
    const chips: HTMLElement[] = this.roots.map((t) => h('button.nav-tree-chip', { type: 'button', class: t.root === this.tree ? 'on' : '', onclick: () => { this.tree = t.root; this.loadCollapsed(); void this.refresh(); this.deps.onOpen(this.deps.docId, t.root); } }, t.title || 'Untitled'));
    if (canEdit && !this.roots.some((t) => t.root === this.deps.docId)) chips.push(h('button.nav-tree-chip.new', { type: 'button', 'data-tip': 'Make this document the root of a navigation tree', onclick: () => void this.makeTree() }, icon('plus', 14), 'Tree'));
    this.treesEl.replaceChildren(...chips);
    this.renderPages();
    this.renderOutline();
    this.el.scrollTop = top;
  }

  private async makeTree() {
    try {
      await api.createTree(this.deps.docId);
      this.tree = this.deps.docId;
      toast('This document is now a tree. Documents mounted inside it are its subpages; place others from their pages.', { kind: 'success' });
      await this.refresh();
      this.deps.onOpen(this.deps.docId, this.tree);
    } catch (e) { toast(errorMessage(e), { kind: 'error' }); }
  }

  private renderWiki() {
    const v = this.view;
    if (!v || !v.publish) { this.wikiEl.replaceChildren(); return; }
    const ps = v.publish;
    const owner = v.role === 'owner';
    const live = ps.published !== 'off' && v.url;
    this.wikiEl.replaceChildren(h('div.nav-wiki-row', null,
      live ? h('a.nav-wiki-link', { href: v.url!, target: '_blank', rel: 'noopener' }, icon('globe', 14), ps.published === 'public' ? 'View wiki' : 'View wiki (members)') : h('span.meta', null, owner ? 'Not published' : ''),
      owner ? h('button.nav-act.wide', { type: 'button', 'data-tip': 'Publish this tree as a wiki', onclick: () => void this.publishDialog() }, live ? 'Settings' : 'Publish…') : null));
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
    const template = h('textarea.input.code', { rows: 10, spellcheck: 'false', placeholder: 'Leave empty for the standard layout. HTML with {{slots}}: {{head}} {{brand}} {{tagline}} {{search}} {{edit}} {{nav}} {{crumbs}} {{title}} {{content}} {{infoboxes}} {{contents}} {{related}} {{asides}} {{subpages}} {{pagefoot}} {{footer}} {{lightbox}}. Scripts are removed.' });
    template.value = ps.theme.template ?? '';
    const loadDefault = h('button.btn.ghost.sm', { type: 'button', onclick: async () => { try { const r = await api.wikiTemplate(); template.value = r.template; template.focus(); } catch (e) { toast(errorMessage(e), { kind: 'error' }); } } }, 'Start from the standard layout');
    const err = h('div.field-error', { role: 'alert' });
    const urlLine = h('p.meta', null, v.url ? h('span', null, 'Live at ', h('a', { href: v.url, target: '_blank', rel: 'noopener' }, v.url)) : 'Published trees get an address under /w/<address>/; a custom domain serves the wiki at its root.');
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
      urlLine, err);
    const save = async () => {
      const published = (body.querySelector('input[name=pub]:checked') as HTMLInputElement).value as PublishSettings['published'];
      try {
        const r = await api.publishTree(v.root, {
          published, slug: slug.value.trim() || null, domain: domain.value.trim() || null,
          theme: { name: name.value, emoji: emoji.value, tagline: tagline.value, accent: accent.value, footer: footer.value, css: css.value, template: template.value },
        });
        d.close();
        toast(r.url && published !== 'off' ? h('span', null, 'Published: ', h('a', { href: r.url, target: '_blank', rel: 'noopener' }, r.url)) : 'Saved.', { kind: 'success', timeout: 8000 });
        await this.refresh();
      } catch (e) { err.textContent = errorMessage(e); }
    };
    const d = openDialog({ title: 'Publish as a wiki', body, footer: [h('button.btn.ghost', { type: 'button', onclick: () => d.close() }, 'Cancel'), h('button.btn.primary', { type: 'button', onclick: () => void save() }, 'Save')] });
  }

  private renderPages() {
    const v = this.view;
    this.renderWiki();
    if (!v) {
      this.pagesEl.replaceChildren(h('div.nav-note', null, this.roots.length ? 'Pick a tree above to see its pages.' : 'No trees yet. A tree is a document whose subpages show here, Notion-style.'));
      return;
    }
    const byId = new Map(v.nodes.map((n) => [n.id, n]));
    const canArrange = atLeast(v.role, 'editor');
    const rows: HTMLElement[] = [];
    const row = (id: string, depth: number, parent: string | null, placedExplicitly: boolean) => {
      const n = byId.get(id);
      const kids = v.placements.filter((p) => p.parent === id);
      const col = this.collapsed.has(id);
      const current = id === this.deps.docId;
      const tri = kids.length
        ? h('button.nav-tri', { type: 'button', 'aria-label': col ? 'Expand' : 'Collapse', onclick: (e: Event) => { e.stopPropagation(); if (col) this.collapsed.delete(id); else this.collapsed.add(id); this.saveCollapsed(); this.renderPages(); } }, col ? '▸' : '▾')
        : h('span.nav-tri.leaf', null, '·');
      const acts = canArrange && parent ? h('span.nav-acts', null,
        h('button.nav-act', { type: 'button', 'aria-label': 'Move up', 'data-tip': 'Move up', onclick: (e: Event) => { e.stopPropagation(); void this.act(api.movePage(v.root, parent, id, 'up')); } }, '↑'),
        h('button.nav-act', { type: 'button', 'aria-label': 'Move down', 'data-tip': 'Move down', onclick: (e: Event) => { e.stopPropagation(); void this.act(api.movePage(v.root, parent, id, 'down')); } }, '↓'),
        h('button.nav-act', { type: 'button', 'aria-label': 'Remove from this tree', 'data-tip': placedExplicitly ? 'Remove from this tree (the page stays)' : 'Remove from this tree (the page stays; it won’t come back by itself)', onclick: (e: Event) => { e.stopPropagation(); void this.act(api.unplace(v.root, parent, id)); } }, '×')) : null;
      const sub = canArrange ? h('button.nav-act', { type: 'button', 'aria-label': 'New subpage', 'data-tip': 'New subpage', onclick: (e: Event) => { e.stopPropagation(); void this.newSubpage(id); } }, '+') : null;
      rows.push(h('div.nav-row', { class: current ? 'current' : '', style: `--d:${depth}`, role: 'treeitem', 'aria-level': String(depth + 1), onclick: () => this.deps.onOpen(id, v.root) },
        tri, h('span.nav-name', { class: n?.section ? 'nameless' : '' }, n ? (n.section ? 'section' : n.title || 'Untitled') : id), h('span.nav-acts-wrap', null, sub, acts)));
      if (!col) for (const p of kids.sort((a, b) => a.ord - b.ord)) if (p.child !== id) row(p.child, depth + 1, id, !p.derived);
    };
    row(v.root, 0, null, false);
    this.pagesEl.replaceChildren(h('div.nav-tree', { role: 'tree', 'aria-label': `Pages in ${v.title}` }, ...rows));
  }

  private renderOutline() {
    const L = this.layout;
    if (!L || !L.mounts.length) { this.outlineEl.replaceChildren(h('div.nav-note', null, 'No sections. Split the page (⌘↵) or mount another document to add one.')); return; }
    const rows = L.mounts.map((m) => {
      const l = this.deps.label(m.child);
      return h('div.nav-row.outline-row', { style: `--d:${m.depth - 1}`, onclick: () => this.deps.onOpen(m.child, this.tree) },
        h('span.nav-tri.leaf', null, m.collapsed ? '▸' : '·'), h('span.nav-name', { class: l?.section ? 'nameless' : '' }, l ? (l.section ? 'section' : l.title || 'Untitled') : '…'));
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

  /** Ask before dropping a tree (the owner of its root). */
  async dropTree() {
    if (!this.tree) return;
    const ok = await confirmDialog({ title: 'Remove this tree?', message: 'The pages stay; only the navigation goes.', confirmLabel: 'Remove tree', danger: true });
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
