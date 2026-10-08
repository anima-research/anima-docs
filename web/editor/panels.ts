// Side panels: version history and activity (recorded changes, with diffs,
// restore and undo; and editing by person).

import { api, atLeast, type ActivityRow, type Checkpoint, type Role, type Version } from '../lib/api';
import { renderDiff } from './diffview';
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
  private tab: 'changes' | 'people' = 'changes';
  private checkpoints: Checkpoint[] = [];
  private moreHistory = false;
  private activityRows: ActivityRow[] = [];
  private comparing = false;
  private picked: Checkpoint[] = [];

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
    this.comparing = false;
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
      else {
        const [hist, act] = await Promise.all([api.history(this.deps.docId), api.activity(this.deps.docId)]);
        this.checkpoints = hist.checkpoints;
        this.moreHistory = hist.more;
        this.activityRows = act.activity;
        this.picked = [];
        this.renderActivityPanel();
      }
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

  private renderActivityPanel() {
    const tabs = h('div.seg.activity-tabs', { role: 'tablist', 'aria-label': 'Activity view' },
      ...([['changes', 'Changes'], ['people', 'By person']] as const).map(([k, label]) => h('button.seg-btn', {
        type: 'button', role: 'tab', 'aria-selected': String(this.tab === k), class: this.tab === k ? 'on' : '',
        onclick: () => { this.tab = k; this.renderActivityPanel(); },
      }, label)));
    const content = this.tab === 'changes' ? this.renderChanges() : this.renderActivity(this.activityRows);
    this.bodyEl.replaceChildren(tabs, content);
  }

  // ------------------------------------------------------------------ changes (recorded checkpoints)

  private renderChanges(): HTMLElement {
    const wrap = h('div.changes');
    const edits = this.checkpoints.filter((c) => !c.baseline);
    const bar = h('div.changes-bar');
    if (this.comparing) {
      const n = this.picked.length;
      bar.append(
        h('span.changes-hint', null, n === 0 ? 'Pick the first and last change to compare.' : n === 1 ? 'Now pick the other end.' : 'Ready to compare.'),
        h('button.btn.primary.sm', { type: 'button', disabled: n !== 2, onclick: () => { const [a, b] = [...this.picked].sort((x, y) => x.seq - y.seq); this.comparing = false; this.picked = []; this.renderActivityPanel(); void this.openDiff(a, b); } }, 'Compare'),
        h('button.btn.ghost.sm', { type: 'button', onclick: () => { this.comparing = false; this.picked = []; this.renderActivityPanel(); } }, 'Cancel'));
    } else {
      bar.append(h('span.changes-hint', null, 'Each stretch of editing, newest first. Open one to see what changed.'));
      if (edits.length > 1) bar.append(h('button.btn.ghost.sm', { type: 'button', onclick: () => { this.comparing = true; this.picked = []; this.renderActivityPanel(); } }, icon('columns', 15), 'Compare'));
      bar.append(h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Refresh', 'data-tip': 'Refresh', onclick: () => void this.refresh() }, icon('reopen', 16)));
    }
    wrap.append(bar);
    if (!edits.length) {
      wrap.append(emptyState({ art: icon('history', 34, 'empty-art-icon'), title: 'No recorded changes yet', text: 'From now on, every stretch of editing is recorded here: who changed what, with a diff you can open, restore or undo.' }));
      return wrap;
    }
    const list = h('ol.change-list');
    let day = '';
    for (const c of this.checkpoints) {
      const d = dayLabel(c.start);
      if (d !== day) { day = d; list.append(h('li.change-day', null, d)); }
      if (c.baseline) {
        list.append(h('li.change-start', null, icon('history', 14), `Recording began ${clockTime(c.end)}. Earlier edits are summed up under By person.`));
        continue;
      }
      const picked = this.picked.some((p) => p.seq === c.seq);
      const names = c.authors.map((a) => a.name).join(', ') || 'Someone';
      const when = c.end - c.start >= 60_000 ? `${clockTime(c.start)}–${clockTime(c.end)}` : clockTime(c.end);
      const row = h('button.change-row', {
        type: 'button', class: picked ? 'picked' : '', 'aria-pressed': this.comparing ? String(picked) : undefined,
        title: `${fullTime(c.start)} – ${fullTime(c.end)}`,
        onclick: () => {
          if (!this.comparing) { void this.openDiff(c, c); return; }
          if (picked) this.picked = this.picked.filter((p) => p.seq !== c.seq);
          else this.picked = [...this.picked.slice(-1), c];
          this.renderActivityPanel();
        },
      },
      h('span.change-avatars', null, ...c.authors.slice(0, 3).map((a) => avatar({ name: a.name, color: a.color, kind: a.kind }, 22))),
      h('span.change-main', null,
        h('span.change-who', null, names, ...c.authors.filter((a) => a.kind !== 'human').slice(0, 1).map((a) => kindBadge(a.kind))),
        h('span.change-meta', null, when, c.label ? h('span.change-label', null, ' · ', this.labelText(c.label)) : null)),
      h('span.change-delta', null, c.added ? h('span.add', null, `+${c.added.toLocaleString()}`) : null, c.removed ? h('span.del', null, ` −${c.removed.toLocaleString()}`) : null));
      list.append(h('li', null, row));
    }
    wrap.append(list);
    if (this.moreHistory) {
      const more: HTMLButtonElement = h('button.btn.ghost.sm.changes-more', { type: 'button', onclick: async () => {
        more.disabled = true;
        try {
          const r = await api.history(this.deps.docId, this.checkpoints[this.checkpoints.length - 1].seq);
          this.checkpoints = [...this.checkpoints, ...r.checkpoints];
          this.moreHistory = r.more;
          this.renderActivityPanel();
        } catch (e) { toast(errorMessage(e), { kind: 'error' }); more.disabled = false; }
      } }, 'Show earlier changes');
      wrap.append(more);
    }
    return wrap;
  }

  /** "Undid h12" → "Undid the change at 3:04 PM" (agents see the ids; people see times). */
  private labelText(label: string): string {
    return label.replace(/\bh(\d+)\b/g, (_m, n) => {
      const c = this.checkpoints.find((x) => x.seq === Number(n));
      return c ? `the change at ${clockTime(c.start)}` : 'an earlier change';
    });
  }

  /** The diff of one change (from = to) or a range, with ways back. */
  private async openDiff(from: Checkpoint, to: Checkpoint | 'now') {
    const single = to !== 'now' && from.seq === to.seq;
    const canEdit = atLeast(this.deps.role(), 'editor');
    const names = (cs: Checkpoint[]) => [...new Set(cs.flatMap((c) => c.authors.map((a) => a.name)))].join(', ') || 'someone';
    const span = to === 'now' ? this.checkpoints.filter((c) => c.seq >= from.seq) : this.checkpoints.filter((c) => c.seq >= from.seq && c.seq <= to.seq);
    const edits = span.filter((c) => !c.baseline);
    const title = single
      ? h('span', null, `Change by ${names([from])}`, h('span.dialog-sub', null, ` · ${dayLabel(from.start)}, ${clockTime(from.start)}${from.end - from.start >= 60_000 ? `–${clockTime(from.end)}` : ''}${from.label ? ` · ${this.labelText(from.label)}` : ''}`))
      : h('span', null, to === 'now' ? `Changes since ${dayLabel(from.start)}, ${clockTime(from.start)}` : `${edits.length} changes`,
        h('span.dialog-sub', null, ` · ${to === 'now' ? 'up to now' : dayLabel(from.start) === dayLabel(to.end) ? `${dayLabel(from.start)}, ${clockTime(from.start)}–${clockTime(to.end)}` : `${dayLabel(from.start)}, ${clockTime(from.start)} – ${dayLabel(to.end)}, ${clockTime(to.end)}`} · by ${names(edits)}`));
    const stats = h('div.diff-stats');
    const body = h('div.diff-body', null, h('div.side-loading', null, spinner(22)));
    const act = (label: string, run: () => Promise<unknown>, confirm: { title: string; message: string; label: string; done: string; danger?: boolean }) =>
      h('button.btn', { type: 'button', class: confirm.danger ? 'danger-outline' : '', onclick: async () => {
        if (!(await confirmDialog({ title: confirm.title, message: confirm.message, confirmLabel: confirm.label }))) return;
        try { await run(); toast(confirm.done, { kind: 'success' }); d.close(); void this.refresh(); } catch (e) { toast(errorMessage(e), { kind: 'error', timeout: 9000 }); }
      } }, label);
    const last = to === 'now' ? null : to;
    const footer: (HTMLElement | null)[] = [
      single ? h('button.btn.ghost', { type: 'button', onclick: () => { d.close(); void this.openDiff(from, 'now'); } }, 'Compare with now') : null,
      h('span.spacer'),
      canEdit && single ? act('Undo this change', () => api.undoChange(this.deps.docId, from.seq),
        { title: 'Undo this change?', message: 'Only this change is taken out; edits made since stay. Everyone sees it live, and it is recorded as a new change you can undo too.', label: 'Undo change', done: 'Change undone' }) : null,
      canEdit ? act(single ? 'Restore to before' : 'Restore to start', () => api.restoreChange(this.deps.docId, from.seq, 'before'),
        { title: 'Restore the earlier state?', message: `The document goes back to how it was just before ${single ? 'this change' : 'these changes'}; everything after is taken out. It is recorded as a new change, so you can come back.`, label: 'Restore', done: 'Restored' }) : null,
      canEdit && last ? act(single ? 'Restore to after' : 'Restore to end', () => api.restoreChange(this.deps.docId, last.seq, 'after'),
        { title: 'Restore this state?', message: `The document goes back to how it was just after ${single ? 'this change' : 'the last of these changes'}; later edits are taken out. It is recorded as a new change, so you can come back.`, label: 'Restore', done: 'Restored' }) : null,
      h('button.btn.ghost', { type: 'button', onclick: () => d.close() }, 'Close'),
    ];
    const d = openDialog({ title, size: 'xl', className: 'diff-dialog', body: h('div', null, stats, body), footer: footer.filter(Boolean) as HTMLElement[] });
    try {
      const r = await api.compare(this.deps.docId, from.seq, to === 'now' ? 'now' : to.seq);
      const view = renderDiff(r.before, r.after);
      stats.replaceChildren(...(view.same ? [] : [h('span.add', null, `+${view.added} line${view.added === 1 ? '' : 's'}`), h('span.del', null, `−${view.removed} line${view.removed === 1 ? '' : 's'}`)]));
      body.replaceChildren(view.el);
    } catch (e) {
      body.replaceChildren(emptyState({ title: 'Couldn’t load this change', text: errorMessage(e) }));
    }
  }

  // ------------------------------------------------------------------ by person

  private renderActivity(rows: ActivityRow[]): HTMLElement {
    if (!rows.length) {
      return emptyState({ art: icon('activity', 34, 'empty-art-icon'), title: 'No edits in the last 30 days', text: 'Edits by people and agents show up here, grouped by who made them.' });
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
    return h('div', null, h('p.side-note', null, 'Edits in the last 30 days, by person or agent.'), list);
  }
}
