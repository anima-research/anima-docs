import { test } from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { findQuote, foldTypography, indexSource, indexedText } from '../src/quote.js';

test('quotes from a rendered page are found in the HTML source across tags, entities and whitespace', () => {
  const src = '<h1>Hello &amp; welcome</h1>\n<p>We ship   the\n<b>thing</b> in March. We ship the thing in April.</p><script>var x = "the thing";</script>';
  const r = findQuote(src, 'Hello & welcome')!;
  assert.equal(src.slice(r.from, r.to), 'Hello &amp; welcome');
  const b = findQuote(src, 'ship the thing in March')!;
  assert.equal(src.slice(b.from, b.to), 'ship   the\n<b>thing</b> in March');
  // Repeats: the suffix picks the second.
  const april = findQuote(src, 'We ship the thing', null, ' in April')!;
  assert.ok(src.slice(april.from).startsWith('We ship the thing in April'));
  // Script bodies are not page text.
  assert.equal(findQuote(src, 'var x'), null);
  assert.equal(findQuote(src, 'nowhere'), null);
  assert.equal(indexSource('a&nbsp;b &#x41;').text, 'a b A');
});

test('quotes from a rendered markdown document are found in the source across markup', () => {
  const src = '# Hello & welcome\n\nWe ship **the thing** in *March*. See [the plan](https://x.y/plan) and `code`.\n\n- first item\n- second **item**\n\n> quoted words\n\n| a | b |\n|---|---|\n| one | two |\n\n```js\nvar x = "the thing";\n```\n\nTail\\*text* done.\n';
  const md = (q: string, prefix?: string | null, suffix?: string | null) => { const r = findQuote(src, q, prefix, suffix, { markdown: true }); return r && src.slice(r.from, r.to); };
  assert.equal(md('Hello & welcome'), 'Hello & welcome');
  assert.equal(md('ship the thing in March'), 'ship **the thing** in *March'); // markers inside the span stay; a closing marker after the last character is not part of it
  assert.equal(md('the thing'), 'the thing');
  assert.equal(md('See the plan and code.'), 'See [the plan](https://x.y/plan) and `code`.');
  assert.equal(md('second item'), 'second **item');
  assert.equal(md('quoted words'), 'quoted words');
  assert.equal(md('one two'), 'one | two');
  assert.equal(md('var x = "the thing";'), 'var x = "the thing";'); // fence bodies are text; the fence lines are not
  assert.equal(md('Tail*text done.'), 'Tail\\*text* done.');
  // The second "the thing" (in the code block) is chosen by its suffix.
  const r = findQuote(src, 'the thing', null, '";', { markdown: true })!;
  assert.ok(src.slice(r.from).startsWith('the thing";'));
  assert.equal(indexSource('- a\n- b', { markdown: true }).text, 'a b');
});

// The preview renders with markdown-it's typographer on (web/lib/markdown.ts), so a quote taken from it holds ’ “ ” – — ….
const preview = new MarkdownIt({ html: true, linkify: true, typographer: true });
const pageText = (src: string) => preview.render(src).replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

test('a comment\'s quote from the preview, with the typographer\'s characters, is found in the markdown source', () => {
  const cases: [string, string][] = [
    ["It's a test of the apostrophe.", "It's a test"],
    ['She said "quoted words" today.', '"quoted words"'],
    ['Pages ten--twenty are dashes.', 'ten--twenty'],
    ['A pause---then more.', 'pause---then'],
    ['And then... an ellipsis.', 'then... an'],
    ['Don’t panic, it’s typed.', 'Don’t panic'],
    ["- It's one\n- It's two", "It's one\n- It's two"],
  ];
  for (const [src, want] of cases) {
    const shown = pageText(src);
    const quote = shown.slice(0, shown.length - (src.endsWith('.') ? 1 : 0));
    const r = findQuote(src, quote, null, null, { markdown: true, fold: true });
    assert.ok(r, `found: ${JSON.stringify(quote)}`);
    assert.ok(src.slice(r.from, r.to).includes(want), `${JSON.stringify(src.slice(r.from, r.to))} holds ${JSON.stringify(want)}`);
  }
  const dash = findQuote('Pages ten--twenty are dashes.', 'ten–twenty', null, null, { markdown: true, fold: true })!;
  assert.equal('Pages ten--twenty are dashes.'.slice(dash.from, dash.to), 'ten--twenty');
  assert.equal(findQuote("It's a test.", 'It’s a test', null, null, { markdown: true }), null);
  const typed = findQuote('Typed: we’re here.', 'we’re here', null, null, { markdown: true })!;
  assert.equal('Typed: we’re here.'.slice(typed.from, typed.to), 'we’re here');
});

test('a quote from the preview inside a code span, or with an underscore inside a word, is found with the characters it shows', () => {
  const src = 'The value is `my_var` and `a*b*c` and `$x$` and `\\_raw` here.';
  assert.equal(pageText(src), 'The value is my_var and a*b*c and $x$ and \\_raw here.');
  const md = (q: string) => { const r = findQuote(src, q, null, null, { markdown: true }); return r && src.slice(r.from, r.to); };
  assert.equal(md('my_var'), 'my_var');
  assert.equal(md('The value is my_var and a*b*c'), 'The value is `my_var` and `a*b*c');
  assert.equal(md('$x$'), '$x$');
  assert.equal(md('\\_raw here'), '\\_raw` here');
  const bare = 'A bare my_var, café_bar, cafe\u0301_bar and _emphasis_ here.';
  assert.equal(pageText(bare), 'A bare my_var, café_bar, cafe\u0301_bar and emphasis here.');
  const b = findQuote(bare, 'A bare my_var, café_bar, cafe\u0301_bar and emphasis', null, null, { markdown: true })!;
  assert.equal(bare.slice(b.from, b.to), 'A bare my_var, café_bar, cafe\u0301_bar and _emphasis');
  const astral = 'Astral x_\u{1E900} and \u{1E900}_x here.';
  assert.equal(pageText(astral), astral);
  const c = findQuote(astral, 'x_\u{1E900} and \u{1E900}_x', null, null, { markdown: true })!;
  assert.equal(astral.slice(c.from, c.to), 'x_\u{1E900} and \u{1E900}_x');
});

test('a thread\'s quote, a slice of the source, reads as the preview shows it, so its mark can be found there', () => {
  const src = "It's a test.\n\nPages ten--twenty, then... an end.\n\nThe value is `a*b*c` here.";
  const idx = indexSource(src, { markdown: true, fold: true });
  const shown = (quote: string) => { const at = src.indexOf(quote); return indexedText(idx, at, at + quote.length).trim(); };
  const page = foldTypography(pageText(src));
  for (const quote of ["It's a test", 'ten--twenty, then... an', 'a*b*c', '`a*b*c` here']) {
    assert.ok(page.includes(shown(quote)), `${JSON.stringify(shown(quote))} in ${JSON.stringify(page)}`);
  }
  assert.equal(shown('a*b*c'), 'a*b*c');
});

test('a markdown document whose last line closes a fenced code block is indexed, and a quote before it is found', () => {
  assert.equal(indexSource('```\nx\n```', { markdown: true }).text.trim(), 'x');
  assert.equal(indexSource('```\nx\n```', { markdown: true, fold: true }).text.trim(), 'x');
  const src = 'Some words.\n\n```\nx\n```';
  const r = findQuote(src, 'Some words', null, null, { markdown: true, fold: true })!;
  assert.equal(src.slice(r.from, r.to), 'Some words');
});

test('a code span\'s closing ticks are looked for only within its own block', () => {
  const items = '- first `red\n- blue` end';
  const r = findQuote(items, 'red blue', null, null, { markdown: true, fold: true })!;
  assert.equal(items.slice(r.from, r.to), 'red\n- blue');
  const para = 'A line `one\ntwo` ends.';
  const p = findQuote(para, 'line one two ends', null, null, { markdown: true, fold: true })!;
  assert.equal(para.slice(p.from, p.to), 'line `one\ntwo` ends');
});

test('a run of underscores between two word characters reads as text, and emphasis underscores still vanish', () => {
  const src = 'Call foo__bar, foo___bar and a__b__c, then __bold__ x and __init__.py.';
  const shown = pageText(src);
  assert.equal(shown, 'Call foo__bar, foo___bar and a__b__c, then bold x and init .py.');
  const r = findQuote(src, 'Call foo__bar, foo___bar and a__b__c, then bold x and init.py.', null, null, { markdown: true, fold: true })!;
  assert.equal(src.slice(r.from, r.to), src);
});

test('an escaped pipe in a code span reads as a pipe, as it shows in a table cell', () => {
  const src = '| Type |\n| --- |\n| `string \\| null` |';
  assert.equal(pageText(src), 'Type string | null');
  const r = findQuote(src, 'string | null', null, null, { markdown: true, fold: true })!;
  assert.equal(src.slice(r.from, r.to), 'string \\| null');
});
