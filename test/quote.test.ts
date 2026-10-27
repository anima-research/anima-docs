import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findQuote, indexSource } from '../src/quote.js';

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
