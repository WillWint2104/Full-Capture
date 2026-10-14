// Makes a static preview of the real UI shell (src/index.html + src/styles)
// driven by a demo script instead of the app, for screenshots:
//   node scripts/design-preview.mjs <demo.js> <out.html>
// then: node scripts/shoot-design.mjs <out.html>
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, SRC } from './bundler.mjs';

const [demo, out] = process.argv.slice(2);
if (!demo || !out) { console.error('usage: node scripts/design-preview.mjs <demo.js> <out.html>'); process.exit(1); }
const outPath = path.resolve(out);
const rel = p => path.relative(path.dirname(outPath), p).split(path.sep).join('/');
let html = await readFile(path.join(SRC, 'index.html'), 'utf8');
html = html
  .replace(/<style>\s*\/\*@inline-css\*\/\s*<\/style>/, `<link rel="stylesheet" href="${rel(path.join(SRC, 'styles', 'main.css'))}">`)
  .replace(/<script>\s*\/\*@inline-js\*\/\s*<\/script>/, `<script src="${rel(path.resolve(demo))}"></script>`);
await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, html);
console.log('wrote', path.relative(ROOT, outPath));
