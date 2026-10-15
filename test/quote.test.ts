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
