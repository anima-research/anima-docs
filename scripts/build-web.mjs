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

const options = {
  absWorkingDir: root,
  entryPoints: [
    { in: 'web/main.ts', out: 'app' },
    { in: 'web/styles.css', out: 'app' },
  ],
  outdir: 'public',
  bundle: true,
  format: 'esm',
  splitting: false,
  target: ['es2021', 'chrome100', 'firefox100', 'safari15'],
  minify: !watch,
  sourcemap: true,
  legalComments: 'none',
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
