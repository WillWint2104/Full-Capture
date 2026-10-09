// Bundles src/ into one self-contained HTML file that opens straight from disk
// (file://) with no network access. Usage: node scripts/build.mjs [--watch]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, SRC, bundle, bundleScript } from './bundler.mjs';

const argValue = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
// --html/--out let tests build the app into an alternative page shell.
const HTML = path.resolve(argValue('--html') || path.join(SRC, 'index.html'));
const OUT = path.resolve(argValue('--out') || path.join(ROOT, 'full-capture.html'));
const CSS = path.resolve(argValue('--css') || path.join(SRC, 'styles', 'main.css'));
const watch = process.argv.includes('--watch');

async function buildOnce() {
  const started = Date.now();
  const [html, css, js] = await Promise.all([
    readFile(HTML, 'utf8'),
    bundle(CSS, { loader: { '.css': 'css' } }),
    bundleScript(path.join(SRC, 'app', 'main.js')),
  ]);
  if (!html.includes('/*@inline-css*/') || !html.includes('/*@inline-js*/')) {
    throw new Error(`${path.relative(ROOT, HTML)} must contain /*@inline-css*/ and /*@inline-js*/ markers`);
  }
  const safeCss = css.text.replace(/<\/style/gi, '<\\/style');
  const out = html
    .replace('/*@inline-css*/', () => safeCss)
    .replace('/*@inline-js*/', () => js.text);
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, out);
  console.log(`built ${path.relative(ROOT, OUT)} (${(out.length / 1024).toFixed(0)} KB) in ${Date.now() - started} ms`);
}

function report(e) {
  console.error(e.errors
    ? e.errors.map(x => `${x.text} @ ${x.location ? x.location.file + ':' + x.location.line : '?'}`).join('\n')
    : e);
}

if (!watch) {
  try { await buildOnce(); } catch (e) { report(e); process.exit(1); }
} else {
  const { watch: fsWatch } = await import('node:fs');
  let timer = null;
  const run = () => buildOnce().catch(report);
  fsWatch(SRC, { recursive: true }, () => { clearTimeout(timer); timer = setTimeout(run, 80); });
  await run();
  console.log('watching src/ ...');
}
