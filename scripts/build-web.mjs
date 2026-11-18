// Bundle the browser client: web/main.ts → public/app.js, web/styles.css → public/app.css.
//   node scripts/build-web.mjs           one-off production build
//   node scripts/build-web.mjs --watch   rebuild on change (development)

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cpSync, mkdirSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

// KaTeX's stylesheet and fonts, served at /katex/ (loaded only by pages that show math).
mkdirSync(join(root, 'public/katex/fonts'), { recursive: true });
cpSync(join(root, 'node_modules/katex/dist/katex.min.css'), join(root, 'public/katex/katex.min.css'));
cpSync(join(root, 'node_modules/katex/dist/fonts'), join(root, 'public/katex/fonts'), { recursive: true });
// pdf.js's worker, character maps and standard fonts, served at /pdfjs/ (loaded only when a PDF is filled or signed).
mkdirSync(join(root, 'public/pdfjs'), { recursive: true });
cpSync(join(root, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'), join(root, 'public/pdfjs/pdf.worker.min.mjs'));
cpSync(join(root, 'node_modules/pdfjs-dist/cmaps'), join(root, 'public/pdfjs/cmaps'), { recursive: true });
cpSync(join(root, 'node_modules/pdfjs-dist/standard_fonts'), join(root, 'public/pdfjs/standard_fonts'), { recursive: true });

const options = {
  absWorkingDir: root,
  entryPoints: [
    { in: 'web/main.ts', out: 'app' },
    { in: 'web/styles.css', out: 'app' },
    // Filling and signing PDFs (pdf.js and pdf-lib): a bundle of its own, fetched the first time it is needed.
    { in: 'web/pdfsign.ts', out: 'pdfsign' },
    // The spreadsheet grid and its formula engine: a bundle of its own, fetched the first time a spreadsheet is opened.
    { in: 'web/sheetgrid.ts', out: 'sheet' },
  ],
  external: ['/pdfsign.js'],
  outdir: 'public',
  bundle: true,
  format: 'esm',
  splitting: false,
  target: ['es2021', 'chrome100', 'firefox100', 'safari15'],
  minify: !watch,
  sourcemap: true,
  // Licence notices of what is bundled stay in the files (the spreadsheet bundle carries HyperFormula, GPL-3.0).
  legalComments: 'eof',
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[build-web] watching web/ …');
} else {
  await esbuild.build(options);
}
