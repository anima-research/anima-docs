// Side panels: version history and activity.

import { api, atLeast, type ActivityRow, type Role, type Version } from '../lib/api';
import { h } from '../lib/dom';
import { icon } from '../lib/icons';
import { clockTime, dayLabel, fullTime, relTime } from '../lib/format';
import { renderDocument } from '../lib/markdown';
import { personBySub } from '../lib/people';
import { avatar, confirmDialog, emptyState, errorMessage, kindBadge, openDialog, spinner, toast } from '../lib/ui';

export type PanelKind = 'versions' | 'activity';

export class SidePanel {
  readonly el: HTMLElement;
  private bodyEl: HTMLElement;
  private titleEl: HTMLElement;
  kind: PanelKind | null = null;
  onClose: () => void = () => {};

  constructor(private deps: { docId: string; role: () => Role | null; title: () => string }) {
    this.titleEl = h('h2');
    this.bodyEl = h('div.side-body');
    this.el = h('aside.side-panel', { 'aria-hidden': 'true' },
      h('div.side-head', null, this.titleEl, h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Close panel', onclick: () => this.close() }, icon('x', 18))),
      this.bodyEl);
  }

  open(kind: PanelKind) {
    this.kind = kind;
    this.el.classList.add('open');
    this.el.setAttribute('aria-hidden', 'false');
    this.el.setAttribute('aria-label', kind === 'versions' ? 'Version history' : 'Activity');
    this.titleEl.textContent = kind === 'versions' ? 'Version history' : 'Activity';
    void this.refresh();
  }

  close() {
    if (!this.kind) return;
    this.kind = null;
    this.el.classList.remove('open');
    this.el.setAttribute('aria-hidden', 'true');
    this.onClose();
  }

  async refresh() {
    const kind = this.kind;
    if (!kind) return;
    this.bodyEl.replaceChildren(h('div.side-loading', null, spinner(22)));
    try {
      if (kind === 'versions') this.renderVersions((await api.versions(this.deps.docId)).versions);
      else this.renderActivity((await api.activity(this.deps.docId)).activity);
    } catch (e) {
      this.bodyEl.replaceChildren(emptyState({ title: 'Couldn’t load', text: errorMessage(e), action: h('button.btn', { type: 'button', onclick: () => void this.refresh() }, 'Try again') }));
    }
  }

  // ------------------------------------------------------------------ versions

  private renderVersions(versions: Version[]) {
    const canEdit = atLeast(this.deps.role(), 'editor');
    const parts: HTMLElement[] = [];
    if (canEdit) {
      const input = h('input.input', { type: 'text', placeholder: 'e.g. “Draft sent for review”', 'aria-label': 'Version name', maxlength: '200' });
      const save = h('button.btn.primary.sm', { type: 'submit' }, 'Save');
      const form = h('form.version-form', {
        onsubmit: async (e: Event) => {
          e.preventDefault();
          save.disabled = true;
          try {
            await api.saveVersion(this.deps.docId, input.value.trim());
            toast('Version saved', { kind: 'success', timeout: 2500 });
            await this.refresh();
          } catch (err) { toast(errorMessage(err), { kind: 'error' }); save.disabled = false; }
        },
      }, h('label.field-label', null, 'Name the current version'), h('div.version-form-row', null, input, save));
      parts.push(form);
    }
    if (!versions.length) {
      parts.push(emptyState({ art: icon('history', 34, 'empty-art-icon'), title: 'No named versions yet', text: canEdit ? 'Name the current version to keep a snapshot you can come back to or restore.' : 'Editors can name versions to keep snapshots of this document.' }));
    } else {
      const list = h('ol.version-list');
      for (const v of versions) {
        const by = personBySub(v.createdBy);
        list.append(h('li.version-item', null,
          h('div.version-dot', { 'aria-hidden': 'true' }),
          h('div.version-main', null,
            h('div.version-name', null, v.name),
            h('div.version-meta', { title: fullTime(v.createdAt) }, avatar({ name: v.by, color: by?.color, kind: by?.kind }, 18), h('span', null, v.by), h('span.dot-sep', null, '·'), relTime(v.createdAt), h('span.dot-sep', null, '·'), `rev ${v.rev}`),
            h('div.version-actions', null,
              h('button.btn.ghost.sm', { type: 'button', onclick: () => void this.viewVersion(v) }, icon('eye', 15), 'View'),
              canEdit ? h('button.btn.ghost.sm', { type: 'button', onclick: () => void this.restore(v) }, icon('restore', 15), 'Restore') : null))));
      }
      parts.push(list);
    }
    this.bodyEl.replaceChildren(...parts);
  }

  private async viewVersion(v: Version) {
    const content = h('div.version-view', null, h('div.side-loading', null, spinner(22)));
    let text = '';
    let raw = false;
    const toggle = h('button.btn.ghost.sm', { type: 'button', onclick: () => { raw = !raw; draw(); } }, 'Show markdown');
    const draw = () => {
      toggle.textContent = raw ? 'Show formatted' : 'Show markdown';
      content.replaceChildren(raw ? h('pre.version-raw', null, text) : h('div.prose', null, renderDocument(text)));
    };
    const canEdit = atLeast(this.deps.role(), 'editor');
    const d = openDialog({
      title: h('span', null, v.name, h('span.dialog-sub', null, ` · ${v.by}, ${fullTime(v.createdAt)}`)),
      size: 'xl', className: 'version-dialog',
      body: content,
      footer: [toggle, h('span.spacer'), h('button.btn.ghost', { type: 'button', onclick: () => d.close() }, 'Close'),
        canEdit ? h('button.btn.primary', { type: 'button', onclick: async () => { if (await this.restore(v)) d.close(); } }, 'Restore this version') : null],
    });
    try {
      text = (await api.version(this.deps.docId, v.id)).text;
      draw();
    } catch (e) {
      content.replaceChildren(emptyState({ title: 'Couldn’t load this version', text: errorMessage(e) }));
    }
  }

  private async restore(v: Version): Promise<boolean> {
    const ok = await confirmDialog({
      title: 'Restore this version?',
      message: h('span', null, 'The document will be changed back to ', h('strong', null, `“${v.name}”`), '. Everyone sees the change live, and the current text stays in the history.'),
      confirmLabel: 'Restore',
    });
    if (!ok) return false;
    try {
      await api.restoreVersion(this.deps.docId, v.id);
      toast(`Restored “${v.name}”`, { kind: 'success' });
      return true;
    } catch (e) { toast(errorMessage(e), { kind: 'error' }); return false; }
  }

  // ------------------------------------------------------------------ activity

  private renderActivity(rows: ActivityRow[]) {
    if (!rows.length) {
      this.bodyEl.replaceChildren(emptyState({ art: icon('activity', 34, 'empty-art-icon'), title: 'No edits in the last 30 days', text: 'Edits by people and agents show up here, grouped by who made them.' }));
      return;
    }
    // Group by person; within a person, merge minutes into sessions (gaps under 15 minutes).
    const byPerson = new Map<string, { row: ActivityRow; rows: ActivityRow[]; added: number; removed: number; last: number }>();
    for (const r of rows) {
      const g = byPerson.get(r.sub) ?? { row: r, rows: [], added: 0, removed: 0, last: 0 };
      g.rows.push(r); g.added += r.added; g.removed += r.removed; g.last = Math.max(g.last, r.minute);
      byPerson.set(r.sub, g);
    }
    const groups = [...byPerson.values()].sort((a, b) => b.last - a.last);
    const list = h('div.activity-list');
    for (const g of groups) {
      const mins = [...g.rows].sort((a, b) => b.minute - a.minute);
      const sessions: { start: number; end: number; added: number; removed: number }[] = [];
      for (const m of mins) {
        const s = sessions[sessions.length - 1];
        if (s && s.start - m.minute <= 15) { s.start = m.minute; s.added += m.added; s.removed += m.removed; }
        else sessions.push({ start: m.minute, end: m.minute, added: m.added, removed: m.removed });
      }
      const name = g.row.label.split(' ✓')[0];
      list.append(h('section.activity-person', null,
        h('header.activity-head', null,
          avatar({ name, color: g.row.color, kind: g.row.kind }, 32),
          h('div.activity-who', null,
            h('div.activity-name', null, name, kindBadge(g.row.kind)),
            h('div.activity-total', null, h('span.add', null, `+${g.added.toLocaleString()}`), ' ', h('span.del', null, `−${g.removed.toLocaleString()}`), ' characters'))),
        h('ul.activity-sessions', null, sessions.slice(0, 12).map((s) => {
          const start = s.start * 60_000, end = s.end * 60_000;
          return h('li', { title: fullTime(start) },
            h('span.as-when', null, `${dayLabel(start)}, ${clockTime(start)}${end - start >= 60_000 ? `–${clockTime(end + 59_000)}` : ''}`),
            h('span.as-delta', null, s.added ? h('span.add', null, `+${s.added.toLocaleString()}`) : null, s.removed ? h('span.del', null, ` −${s.removed.toLocaleString()}`) : null));
        }), sessions.length > 12 ? h('li.as-more', null, `and ${sessions.length - 12} earlier sessions`) : null)));
    }
    this.bodyEl.replaceChildren(h('p.side-note', null, 'Edits in the last 30 days, by person or agent.'), list);
  }
}
