// Ping an agent: ask it to look at this document, with an optional message
// and the text you have selected. It arrives as an addressed event (waking
// the agent by its own mentions setting); an offline agent gets it later.

import { api, type PingableAgent } from '../lib/api';
import { autosize, h, modKey } from '../lib/dom';
import { icon } from '../lib/icons';
import { avatar, emptyState, errorMessage, openDialog, spinner, toast } from '../lib/ui';

export function openPingDialog(opts: { docId: string; selection: { text: string; line: number } | null; preselect?: string }) {
  let agents: PingableAgent[] = [];
  let chosen: string | null = opts.preselect ?? null;
  const list = h('div.ping-agents', { role: 'radiogroup', 'aria-label': 'Agent to ping' }, h('div.side-loading', null, spinner(20)));
  const filter = h('input.input.ping-filter', { type: 'search', placeholder: 'Find an agent', 'aria-label': 'Find an agent', hidden: true });
  const message = h('textarea.comment-input.tall', { rows: 3, placeholder: 'What should they look at? (optional)', 'aria-label': 'Message', maxlength: '2000' });
  autosize(message, 200);
  const withQuote = h('input', { type: 'checkbox', checked: true, id: 'ping-quote' });
  const quoteRow = opts.selection?.text.trim()
    ? h('label.ping-quote', { for: 'ping-quote' }, withQuote, h('span', null, 'Include the selected text', h('blockquote.card-quote', null, opts.selection.text.slice(0, 400))))
    : null;
  const send = h('button.btn.primary', { type: 'button', disabled: true, onclick: () => void submit() }, icon('bell', 16), 'Ping');
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const shown = agents.filter((a) => !q || a.name.toLowerCase().includes(q));
    if (!agents.length) {
      list.replaceChildren(emptyState({ art: icon('bot', 30, 'empty-art-icon'), title: 'No agents can open this document', text: 'Share it with an agent first (Share → add people or agents).' }));
      return;
    }
    list.replaceChildren(...shown.map((a) => h('button.ping-agent', {
      type: 'button', role: 'radio', 'aria-checked': String(chosen === a.sub), class: chosen === a.sub ? 'on' : '',
      onclick: () => { chosen = a.sub; send.disabled = false; draw(); },
    }, avatar({ name: a.name, color: a.color, kind: a.kind }, 28),
    h('span.ping-name', null, a.name),
    h('span.ping-state', { class: a.online ? 'online' : '' }, a.online ? 'online' : 'offline'))));
    send.disabled = !chosen;
  };
  filter.addEventListener('input', draw);
  const submit = async () => {
    const a = agents.find((x) => x.sub === chosen);
    if (!a) return;
    send.disabled = true;
    try {
      const useQuote = !!quoteRow && withQuote.checked;
      const r = await api.ping(opts.docId, { who: a.sub, message: message.value.trim() || undefined, quote: useQuote ? opts.selection!.text : undefined, line: useQuote ? opts.selection!.line : undefined });
      toast(r.online ? `Pinged ${a.name}` : `${a.name} is offline; they’ll get your ping when they reconnect`, { kind: 'success' });
      d.close();
    } catch (e) {
      toast(errorMessage(e), { kind: 'error' });
      send.disabled = false;
    }
  };
  message.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } });
  const d = openDialog({
    title: 'Ping an agent', size: 'sm', className: 'ping-dialog',
    body: h('div.form-stack', null,
      h('p.dialog-help', null, 'Ask an agent to look at this document. It wakes them (if they allow mentions to), with your message.'),
      filter, list, message, quoteRow),
    footer: [h('span.kbd-hint', null, `${modKey}Enter`), h('button.btn.ghost', { type: 'button', onclick: () => d.close() }, 'Cancel'), send],
  });
  void api.agents(opts.docId).then((r) => {
    agents = r.agents;
    if (chosen && !agents.some((a) => a.sub === chosen)) chosen = null;
    if (!chosen && agents.length === 1) chosen = agents[0].sub;
    filter.hidden = agents.length < 7;
    draw();
  }, (e) => list.replaceChildren(emptyState({ title: 'Couldn’t load agents', text: errorMessage(e) })));
}
