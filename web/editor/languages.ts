// Languages highlighted inside fenced code blocks. A curated set rather than
// @codemirror/language-data: the app ships as one bundle (no code splitting),
// and the full catalogue would triple its size.

import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { sql } from '@codemirror/lang-sql';
import { go } from '@codemirror/lang-go';
import { yaml } from '@codemirror/lang-yaml';
import { shell } from '@codemirror/legacy-modes/mode/shell';

const of = (name: string, alias: string[], support: () => LanguageSupport) =>
  LanguageDescription.of({ name, alias, load: async () => support() });

export const codeLanguages: LanguageDescription[] = [
  of('JavaScript', ['js', 'javascript', 'mjs', 'cjs', 'node'], () => javascript()),
  of('JSX', ['jsx'], () => javascript({ jsx: true })),
  of('TypeScript', ['ts', 'typescript', 'mts'], () => javascript({ typescript: true })),
  of('TSX', ['tsx'], () => javascript({ jsx: true, typescript: true })),
  of('Python', ['py', 'python', 'python3'], () => python()),
  of('JSON', ['json', 'jsonc', 'json5'], () => json()),
  of('CSS', ['css', 'scss'], () => css()),
  of('HTML', ['html', 'htm', 'xml', 'svg'], () => html()),
  of('SQL', ['sql', 'postgres', 'sqlite', 'mysql'], () => sql()),
  of('Go', ['go', 'golang'], () => go()),
  of('YAML', ['yaml', 'yml'], () => yaml()),
  of('Shell', ['sh', 'bash', 'zsh', 'shell', 'console'], () => new LanguageSupport(StreamLanguage.define(shell))),
];
