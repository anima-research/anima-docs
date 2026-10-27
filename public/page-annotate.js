// Annotation layer for HTML pages framed by Anima Docs. Injected into a page
// served with ?annotate=1; does nothing unless the app frames the page.
//
// It never changes the document by itself: a selection becomes a
// {quote, prefix, suffix} the app looks up in the source and comments on;
// a text edit becomes a proposed replacement the app confirms. The app
// sends the open threads back as quotes, which are highlighted here.
(function () {
  'use strict';
  if (window.parent === window) return;
  var parentWin = window.parent;
  var config = { canComment: false, canEdit: false };
  var post = function (m) { m.anima = 'page'; parentWin.postMessage(m, '*'); };
  var norm = function (s) { return String(s || '').replace(/\s+/g, ' '); };

  // ------------------------------------------------------------ the page's text, indexed
  function textNodes() {
    var out = [];
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: function (n) {
      var p = n.parentElement;
      return !p || p.closest('script,style,noscript,textarea,[data-anima-ui]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    } });
    var n; while ((n = w.nextNode())) out.push(n);
    return out;
  }
  /** Whitespace-collapsed text of the page with, for each character, the text node and offset it came from. */
  function index() {
    var nodes = textNodes(), s = '', map = [], space = true;
    for (var k = 0; k < nodes.length; k++) {
      var t = nodes[k].data;
      for (var i = 0; i < t.length; i++) {
        var ch = t[i];
        if (/\s/.test(ch)) { if (space) continue; s += ' '; map.push({ node: nodes[k], offset: i }); space = true; }
        else { s += ch; map.push({ node: nodes[k], offset: i }); space = false; }
      }
    }
    return { text: s, map: map };
  }
  /** Where a DOM point falls in the indexed text (first indexed character at or after it). */
  function posOf(idx, node, offset) {
    if (node.nodeType !== 3) { // an element: the first text node inside it from `offset`, or after it
      var r = document.createRange(); r.setStart(node, offset); r.collapse(true);
      for (var i = 0; i < idx.map.length; i++) { var m = idx.map[i]; var p = document.createRange(); p.setStart(m.node, m.offset); p.collapse(true); if (r.compareBoundaryPoints(Range.START_TO_START, p) <= 0) return i; }
      return idx.text.length;
    }
    for (var j = 0; j < idx.map.length; j++) if (idx.map[j].node === node && idx.map[j].offset >= offset) return j;
    for (var q = 0; q < idx.map.length; q++) if (idx.map[q].node === node) { /* past this node's last indexed char */ }
    // After the node's indexed characters: the first index of a later node.
    var seen = false;
    for (var z = 0; z < idx.map.length; z++) { if (idx.map[z].node === node) seen = true; else if (seen) return z; }
    return idx.text.length;
  }
  /** Find a quote (with context) in the indexed text; `near` breaks ties. */
  function find(idx, quote, prefix, suffix, near) {
    var q = norm(quote).trim();
    if (!q) return null;
    var best = null, bestScore = -1, at = -1;
    while ((at = idx.text.indexOf(q, at + 1)) >= 0) {
      var score = 0;
      if (prefix) { var p = norm(prefix); var before = idx.text.slice(Math.max(0, at - p.length), at); if (before === p) score += 4; else if (before.trim().slice(-12) === p.trim().slice(-12)) score += 2; }
      if (suffix) { var sf = norm(suffix); var after = idx.text.slice(at + q.length, at + q.length + sf.length); if (after === sf) score += 4; else if (after.trim().slice(0, 12) === sf.trim().slice(0, 12)) score += 2; }
      if (typeof near === 'number') score += 1 / (1 + Math.abs(at - near) / 50);
      if (score > bestScore) { bestScore = score; best = at; }
    }
    return best === null ? null : { start: best, end: best + q.length };
  }
  function context(idx, start, end) {
    return { prefix: idx.text.slice(Math.max(0, start - 32), start), suffix: idx.text.slice(end, end + 32) };
  }

  // ------------------------------------------------------------ highlights
  function unmark() {
    var marks = document.querySelectorAll('mark.anima-mark');
    for (var i = 0; i < marks.length; i++) { var m = marks[i], p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m); p.normalize(); }
  }
  function markRange(idx, start, end, threadId, resolved) {
    var segs = [], cur = null;
    for (var i = start; i < end; i++) {
      var m = idx.map[i]; if (!m) break;
      if (cur && cur.node === m.node && m.offset === cur.to) cur.to = m.offset + 1;
      else { cur = { node: m.node, from: m.offset, to: m.offset + 1 }; segs.push(cur); }
    }
    for (var k = 0; k < segs.length; k++) {
      var s = segs[k]; if (!s.node.parentNode) continue;
      s.node.splitText(s.to); var mid = s.node.splitText(s.from);
      var mark = document.createElement('mark');
      mark.className = 'anima-mark' + (resolved ? ' resolved' : '');
      mark.setAttribute('data-thread', threadId);
      mark.title = 'Open this comment';
      mid.parentNode.insertBefore(mark, mid); mark.appendChild(mid);
    }
  }
  function applyHighlights(threads) {
    unmark();
    for (var i = 0; i < threads.length; i++) {
      var t = threads[i]; if (!t.quote) continue;
      var idx = index(); // rebuilt per thread: marking splits text nodes
      var r = find(idx, t.quote, t.prefix, t.suffix);
      if (r) markRange(idx, r.start, r.end, t.id, !!t.resolved);
    }
  }
  document.addEventListener('click', function (e) {
    var m = e.target && e.target.closest ? e.target.closest('mark.anima-mark') : null;
    if (m) { e.preventDefault(); post({ type: 'open-thread', id: m.getAttribute('data-thread') }); }
  }, true);

  // ------------------------------------------------------------ selection → comment
  var bar = document.createElement('div');
  bar.setAttribute('data-anima-ui', '');
  bar.className = 'anima-bar';
  bar.hidden = true;
  var commentBtn = document.createElement('button'); commentBtn.type = 'button'; commentBtn.textContent = 'Comment'; commentBtn.setAttribute('data-anima-ui', '');
  var hint = document.createElement('span'); hint.setAttribute('data-anima-ui', ''); hint.className = 'anima-hint'; hint.textContent = 'double-click text to edit';
  bar.appendChild(commentBtn); bar.appendChild(hint);
  var pending = null;
  function hideBar() { bar.hidden = true; pending = null; }
  function showBar() {
    var sel = window.getSelection();
    if (!config.canComment || !sel || sel.isCollapsed || !sel.rangeCount || !norm(sel.toString()).trim()) { hideBar(); return; }
    var range = sel.getRangeAt(0);
    if (bar.contains(range.commonAncestorContainer)) return;
    var idx = index();
    var q = norm(sel.toString()).trim();
    var near = posOf(idx, range.startContainer, range.startOffset);
    var r = find(idx, q, null, null, near);
    if (!r) { hideBar(); return; }
    var c = context(idx, r.start, r.end);
    pending = { quote: q, prefix: c.prefix, suffix: c.suffix };
    var rect = range.getBoundingClientRect();
    bar.hidden = false;
    hint.hidden = !config.canEdit;
    var top = rect.top - bar.offsetHeight - 8; if (top < 4) top = rect.bottom + 8;
    var left = Math.max(4, Math.min(window.innerWidth - bar.offsetWidth - 4, rect.left + rect.width / 2 - bar.offsetWidth / 2));
    bar.style.top = top + 'px'; bar.style.left = left + 'px';
  }
  commentBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
  commentBtn.addEventListener('click', function () { if (pending) { post({ type: 'comment', quote: pending.quote, prefix: pending.prefix, suffix: pending.suffix }); hideBar(); window.getSelection().removeAllRanges(); } });
  document.addEventListener('mouseup', function () { setTimeout(showBar, 0); });
  document.addEventListener('keyup', function (e) { if (e.shiftKey || e.key === 'Shift') setTimeout(showBar, 0); });
  document.addEventListener('mousedown', function (e) { if (!bar.contains(e.target)) hideBar(); }, true);
  document.addEventListener('scroll', hideBar, true);

  // ------------------------------------------------------------ double-click → edit a text run
  var editing = null;
  function startEdit(textNode) {
    if (!config.canEdit || editing || !textNode || textNode.nodeType !== 3 || !textNode.data.trim()) return;
    var idx = index();
    var start = -1, end = -1;
    for (var i = 0; i < idx.map.length; i++) { if (idx.map[i].node === textNode) { if (start < 0) start = i; end = i + 1; } }
    if (start < 0) return;
    var c = context(idx, start, end);
    var original = textNode.data;
    var span = document.createElement('span');
    span.setAttribute('data-anima-ui', ''); span.className = 'anima-edit';
    span.contentEditable = 'plaintext-only';
    if (span.contentEditable !== 'plaintext-only') span.contentEditable = 'true';
    span.textContent = original;
    textNode.parentNode.replaceChild(span, textNode);
    editing = { span: span, textNode: textNode, original: original, quote: norm(original).trim(), prefix: c.prefix, suffix: c.suffix };
    span.focus();
    var r = document.createRange(); r.selectNodeContents(span); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    hideBar();
  }
  function endEdit(commit) {
    var e = editing; if (!e) return; editing = null;
    var text = e.span.textContent;
    e.textNode.data = commit && text !== e.original ? text : e.original;
    e.span.parentNode.replaceChild(e.textNode, e.span);
    if (commit && text !== e.original) post({ type: 'edit', quote: e.quote, prefix: e.prefix, suffix: e.suffix, text: text });
  }
  document.addEventListener('dblclick', function (e) {
    if (!config.canEdit || editing) return;
    var pos = document.caretPositionFromPoint ? document.caretPositionFromPoint(e.clientX, e.clientY) : null;
    var node = pos ? pos.offsetNode : (document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY).startContainer : null);
    if (node && node.nodeType === 3 && !node.parentElement.closest('[data-anima-ui],a,button,input,select,textarea,code,pre')) { e.preventDefault(); startEdit(node); }
  }, true);
  document.addEventListener('keydown', function (e) {
    if (!editing) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); endEdit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); endEdit(false); }
  }, true);
  document.addEventListener('focusout', function (e) { if (editing && e.target === editing.span) setTimeout(function () { if (editing && editing.span === e.target) endEdit(true); }, 0); }, true);

  // ------------------------------------------------------------ the app talks back
  window.addEventListener('message', function (e) {
    if (e.source !== parentWin) return;
    var m = e.data; if (!m || m.anima !== 'app') return;
    if (m.type === 'config') { config = { canComment: !!m.canComment, canEdit: !!m.canEdit }; document.documentElement.classList.toggle('anima-annotatable', config.canComment); }
    else if (m.type === 'highlights') applyHighlights(m.threads || []);
    else if (m.type === 'reveal') { var mk = document.querySelector('mark.anima-mark[data-thread="' + String(m.id || '').replace(/["\\]/g, '') + '"]'); if (mk) mk.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  });

  var style = document.createElement('style');
  style.setAttribute('data-anima-ui', '');
  style.textContent = [
    'mark.anima-mark{background:rgba(255,204,0,.45);color:inherit;cursor:pointer;border-radius:2px;box-shadow:0 1px 0 rgba(200,150,0,.6)}',
    'mark.anima-mark:hover{background:rgba(255,204,0,.7)}',
    'mark.anima-mark.resolved{background:rgba(0,0,0,.07);box-shadow:none}',
    '.anima-bar{position:fixed;z-index:2147483647;display:flex;align-items:center;gap:8px;padding:4px 6px;background:#1f2328;color:#fff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.25);font:13px/1.2 system-ui,sans-serif}',
    '.anima-bar button{font:inherit;color:#fff;background:#2459e0;border:0;border-radius:6px;padding:5px 10px;cursor:pointer}',
    '.anima-bar button:hover{background:#1c48b8}',
    '.anima-hint{opacity:.7;padding-right:4px}',
    '.anima-edit{outline:2px solid #2459e0;outline-offset:1px;border-radius:2px;background:rgba(36,89,224,.08)}',
  ].join('\n');
  (document.head || document.documentElement).appendChild(style);
  document.body.appendChild(bar);
  post({ type: 'ready' });
})();
