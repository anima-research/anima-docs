// The colours of source text: the document editor's, and a collection's file editor's.

import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

export const docHighlight = HighlightStyle.define([
  { tag: t.heading, class: 'tok-heading' },
  { tag: t.strong, class: 'tok-strong' },
  { tag: t.emphasis, class: 'tok-em' },
  { tag: t.strikethrough, class: 'tok-strike' },
  { tag: t.link, class: 'tok-link' },
  { tag: t.url, class: 'tok-url' },
  { tag: t.monospace, class: 'tok-mono' },
  { tag: t.processingInstruction, class: 'tok-mark' },
  { tag: t.quote, class: 'tok-quote' },
  { tag: t.contentSeparator, class: 'tok-mark' },
  { tag: t.labelName, class: 'tok-label' },
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], class: 'tok-kw' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], class: 'tok-str' },
  { tag: [t.number, t.bool, t.null, t.atom], class: 'tok-num' },
  { tag: [t.comment, t.lineComment, t.blockComment], class: 'tok-comment' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: 'tok-fn' },
  { tag: [t.typeName, t.className, t.namespace], class: 'tok-type' },
  { tag: [t.propertyName, t.attributeName], class: 'tok-prop' },
  { tag: t.tagName, class: 'tok-tag' },
  { tag: [t.meta, t.escape], class: 'tok-meta' },
  { tag: t.invalid, class: 'tok-invalid' },
]);
