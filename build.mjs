// Builds the app into docs/ (published by GitHub Pages). `node build.mjs test` builds a test copy
// into test-build/ that uses the stand-in database instead of Firebase.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const test = process.argv[2] === 'test';
const out = test ? 'test-build' : 'docs';
mkdirSync(out, { recursive: true });
await build({
  entryPoints: ['src/main.js'], bundle: true, minify: !test, format: 'iife', target: 'es2020',
  outfile: `${out}/app.js`,
  plugins: [{ name: 'storage', setup(b) { b.onResolve({ filter: /^\.\/fb\.js$/ }, () => ({ path: resolve(test ? 'src/fb-mock.js' : 'src/fb-real.js') })); } }],
  loader: { '.json': 'json' }, logLevel: 'warning',
});
const version = createHash('sha1').update(readFileSync(`${out}/app.js`)).digest('hex').slice(0, 10);
writeFileSync(`${out}/index.html`, readFileSync('src/index.html', 'utf8').replaceAll('__VERSION__', version));
writeFileSync(`${out}/sw.js`, readFileSync('src/sw.js', 'utf8').replaceAll('__VERSION__', version));
for (const f of ['manifest.webmanifest', 'icon-192.png', 'icon-512.png']) copyFileSync(`src/${f}`, `${out}/${f}`);
writeFileSync(`${out}/.nojekyll`, '');
console.log(`built ${out}/ version ${version}`);
