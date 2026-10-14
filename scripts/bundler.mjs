// Shared esbuild setup for the app build and for test harnesses.
import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SRC = path.join(ROOT, 'src');
export const TARGET = ['chrome116', 'edge116'];

// `import SRC from 'worklet:voice-processor.js'` bundles src/worklets/<file>
// (and anything it imports) into a string, so AudioWorklet can load it from a
// data: URL. Blob URLs are refused for worklets on file:// pages.
export const workletPlugin = {
  name: 'worklet',
  setup(build) {
    // Paths relative to the repository root, so the built file (which names
    // its modules in comments) is the same on every machine.
    build.onResolve({ filter: /^worklet:/ }, args => ({
      path: path.relative(ROOT, path.join(SRC, 'worklets', args.path.slice('worklet:'.length))).split(path.sep).join('/'),
      namespace: 'worklet',
    }));
    build.onLoad({ filter: /.*/, namespace: 'worklet' }, async args => {
      const r = await esbuild.build({
        entryPoints: [path.resolve(ROOT, args.path)], bundle: true, write: false, format: 'iife',
        target: TARGET, metafile: true, logLevel: 'silent', absWorkingDir: ROOT,
      });
      return {
        contents: r.outputFiles[0].text,
        loader: 'text',
        watchFiles: Object.keys(r.metafile.inputs).map(p => path.resolve(ROOT, p)),
      };
    });
  },
};

/** Bundle one entry point to a string. Returns { text, inputs }. */
export async function bundle(entry, opts = {}) {
  const r = await esbuild.build({
    entryPoints: [entry], bundle: true, write: false, target: TARGET,
    charset: 'utf8', legalComments: 'none', logLevel: 'silent', metafile: true,
    absWorkingDir: ROOT, plugins: [workletPlugin], ...opts,
  });
  return { text: r.outputFiles[0].text, inputs: Object.keys(r.metafile.inputs) };
}

/** Bundle a JS entry as an IIFE that is safe to inline in a <script> tag. */
export async function bundleScript(entry, opts = {}) {
  const r = await bundle(entry, { format: 'iife', ...opts });
  return { ...r, text: r.text.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--') };
}
