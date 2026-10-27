/**
 * Builds a game project:
 *   logic/index.ts → dist/logic.js   (ONE script for the sandbox, sets globalThis.__vibesGame)
 *   client/        → dist/client/    (index.html + bundled client/main.ts + static files)
 */
import { builtinModules } from 'module';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, extname, join, relative, resolve } from 'path';
import * as esbuild from 'esbuild';
import { DEFAULT_LIMITS, Sandbox, SandboxError, sha256, type GameMeta, type Limits } from '@vibes/game-runtime';
import type { Project } from './manifest';
import { CliError, kb } from './util';

export const LOGIC_LIMIT_BYTES = 2 * 1024 * 1024;

export interface LogicBuild {
  code: string;
  sha256: string;
  bytes: number;
  file: string;
  /** Static scan findings that are not fatal (e.g. `fetch` used inside a function). */
  warnings: string[];
  /** Absolute paths of every source file in the bundle (for watching). */
  inputs: string[];
}

export interface ClientBuild {
  dir: string;
  files: string[];
  inputs: string[];
  /** The folder that is copied or bundled (watched in dev). */
  sourceDir: string;
}

/** Names that do not exist in the sandbox. Any use throws, at the latest when the code runs. */
export const FORBIDDEN_GLOBALS = [
  'fetch', 'window', 'document', 'process', 'require', 'XMLHttpRequest', 'WebSocket', 'localStorage',
  'sessionStorage', 'indexedDB', 'navigator', 'location', 'setTimeout', 'setInterval', 'setImmediate',
  'clearTimeout', 'clearInterval', 'Buffer', 'Deno', 'Bun', 'importScripts', 'performance',
];

/** Keeps Node built-ins out of the logic bundle with a message that says why. */
function noNodeBuiltins(): esbuild.Plugin {
  const builtins = new Set(builtinModules.filter((n) => !n.startsWith('_')));
  return {
    name: 'vibes-no-node-builtins',
    setup(b) {
      b.onResolve({ filter: /.*/ }, async (args) => {
        if ((args.pluginData as { skip?: boolean } | undefined)?.skip) return undefined;
        const p = args.path;
        const isNodePrefix = p.startsWith('node:');
        const top = p.split('/')[0]!;
        if (!isNodePrefix && !builtins.has(p) && !builtins.has(top)) return undefined;
        if (!isNodePrefix) {
          // A real npm package with a built-in's name (e.g. "events", "buffer" polyfills) is fine.
          const r = await b.resolve(p, { kind: args.kind, resolveDir: args.resolveDir, importer: args.importer, pluginData: { skip: true } });
          if (r.errors.length === 0 && r.path) return { path: r.path, namespace: r.namespace, sideEffects: r.sideEffects };
        }
        return {
          errors: [{
            text: `"${p}" is a Node.js built-in module. Game logic runs in a sandbox with no Node or browser APIs (no files, network, processes or timers). Remove this import, or the package that needs it.`,
          }],
        };
      });
    },
  };
}

async function esbuildError(e: unknown, root: string): Promise<CliError> {
  const failure = e as esbuild.BuildFailure;
  if (!Array.isArray(failure?.errors)) return new CliError(String((e as Error)?.message ?? e));
  const lines = await esbuild.formatMessages(failure.errors, { kind: 'error', color: false });
  return new CliError(lines.join('\n').replaceAll(root + '/', '').trim());
}

/** Bundles the logic. Throws CliError with a readable message when it can't. */
export async function buildLogic(project: Project, opts: { minify?: boolean; write?: boolean; verifyLoad?: boolean } = {}): Promise<LogicBuild> {
  let result: esbuild.BuildResult<{ write: false; metafile: true }>;
  try {
    result = await esbuild.build({
      absWorkingDir: project.root,
      entryPoints: [project.logicEntry],
      bundle: true,
      platform: 'neutral',
      format: 'iife',
      globalName: '__vibesGameModule',
      footer: { js: 'globalThis.__vibesGame = __vibesGameModule.default || __vibesGameModule;' },
      target: 'es2022',
      minify: !!opts.minify,
      sourcemap: false,
      legalComments: 'none',
      write: false,
      metafile: true,
      logLevel: 'silent',
      // platform 'neutral' resolves no package fields by default; pure npm packages need these.
      mainFields: ['module', 'main'],
      conditions: ['module'],
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [noNodeBuiltins()],
    });
  } catch (e) {
    throw await esbuildError(e, project.root);
  }
  const code = result.outputFiles[0]!.text;
  const bytes = Buffer.byteLength(code, 'utf8');
  if (bytes > LOGIC_LIMIT_BYTES) throw new CliError(`dist/logic.js is ${kb(bytes)}; the limit is ${kb(LOGIC_LIMIT_BYTES)}. Remove big dependencies from the logic.`);

  // The real test for "no outside world at the top level": load it in the same sandbox VIBES uses.
  if (opts.verifyLoad !== false) await loadOnce(code);

  const file = join(project.dist, 'logic.js');
  if (opts.write !== false) {
    mkdirSync(project.dist, { recursive: true });
    writeFileSync(file, code);
  }
  return {
    code, sha256: sha256(code), bytes, file,
    warnings: scanForbidden(code),
    inputs: Object.keys(result.metafile.inputs).map((p) => resolve(project.root, p)),
  };
}

async function loadOnce(code: string) {
  const r = await loadInSandbox(code);
  if ('error' in r) {
    const hint = forbiddenHint(r.error.message);
    throw new CliError(`the logic bundle crashed while loading in the sandbox: ${r.error.message}${hint ? `\n  ${hint}` : ''}`);
  }
}

/**
 * Loads the bundle in a fresh runtime Sandbox and reads meta().
 *
 * Sandbox.create() reports every load-time error as kind "memory" ("logic ran out of
 * memory"): it disposes the isolate before classifying the error. To still show the
 * developer the real message, a failed load is retried with the bundle wrapped in
 * try/catch, and the caught error is re-thrown from the first call.
 */
export async function loadInSandbox(code: string, limits: Limits = { ...DEFAULT_LIMITS }): Promise<{ meta: GameMeta } | { error: SandboxError }> {
  const attempt = async (src: string) => {
    const sb = await Sandbox.create(src, sha256(src), limits);
    try { return await sb.meta(); } finally { sb.dispose(); }
  };
  try {
    return { meta: await attempt(code) };
  } catch (e) {
    const err = e instanceof SandboxError ? e : new SandboxError(String(e), 'crash');
    if (err.kind !== 'memory') return { error: err };
    try {
      await attempt(`try {\n${code}\n} catch (e) { globalThis.__vibesLoadError = (e && e.name ? e.name + ': ' : '') + (e && typeof e.message === 'string' ? e.message : String(e)); }
;(function () { var call = globalThis.__vibesCall; globalThis.__vibesCall = function (k, i) { if (globalThis.__vibesLoadError) throw new Error(globalThis.__vibesLoadError); return call(k, i); }; })();`);
    } catch (e2) {
      if (e2 instanceof SandboxError && e2.kind !== 'memory') return { error: new SandboxError(e2.message, e2.kind) };
    }
    return { error: err };
  }
}

/** Explains the usual sandbox errors. */
export function forbiddenHint(msg: string): string | null {
  const m = /\b([A-Za-z_$][\w$]*) is not defined\b/.exec(msg);
  if (m && FORBIDDEN_GLOBALS.includes(m[1]!)) return `"${m[1]}" does not exist in game logic: no network, DOM, timers or Node APIs. Keep it in the client.`;
  if (/is not allowed in game logic/.test(msg)) return 'use ctx.rng for randomness and ctx.now for time.';
  return null;
}

/**
 * Cheap static check: free uses of browser / Node globals anywhere in the bundle (strings and
 * comments skipped). Uses at load time already failed in loadOnce(); these would throw when called.
 */
export function scanForbidden(code: string): string[] {
  const src = stripStringsAndComments(code);
  const names = FORBIDDEN_GLOBALS.join('|');
  const re = new RegExp(`(?<![\\w$.])(?<!typeof\\s+)(${names})\\b(?!\\s*:)`, 'g');
  const found = new Map<string, number[]>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length;
    const lines = found.get(m[1]!) ?? [];
    if (lines.length < 3) lines.push(line);
    found.set(m[1]!, lines);
  }
  return [...found].map(([name, lines]) => `"${name}" is used in dist/logic.js (line ${lines.join(', ')}); it does not exist in the sandbox and throws when that code runs`);
}

/** Replaces string, template and comment contents with spaces (keeps line numbers). Best effort. */
function stripStringsAndComments(s: string): string {
  let out = '';
  let i = 0;
  const blank = (t: string) => t.replace(/[^\n]/g, ' ');
  while (i < s.length) {
    const ch = s[i]!;
    const next = s[i + 1];
    if (ch === '/' && next === '/') { const j = s.indexOf('\n', i); const end = j < 0 ? s.length : j; out += blank(s.slice(i, end)); i = end; continue; }
    if (ch === '/' && next === '*') { const j = s.indexOf('*/', i + 2); const end = j < 0 ? s.length : j + 2; out += blank(s.slice(i, end)); i = end; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < s.length && s[j] !== ch) { if (s[j] === '\\') j++; j++; }
      out += ch + blank(s.slice(i + 1, j)) + ch; i = j + 1; continue;
    }
    if (ch === '/') {
      // Regex literal if the previous meaningful char can't end an expression.
      const prev = out.replace(/\s+$/, '').slice(-1);
      if (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev)) {
        let j = i + 1; let inClass = false;
        while (j < s.length && s[j] !== '\n') {
          if (s[j] === '\\') { j += 2; continue; }
          if (s[j] === '[') inClass = true; else if (s[j] === ']') inClass = false;
          else if (s[j] === '/' && !inClass) break;
          j++;
        }
        out += '/' + blank(s.slice(i + 1, j)) + '/'; i = j + 1; continue;
      }
    }
    out += ch; i++;
  }
  return out;
}

const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.jsx']);
const ASSET_LOADERS: Record<string, esbuild.Loader> = Object.fromEntries(
  ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.woff', '.woff2', '.ttf', '.mp3', '.ogg', '.wav'].map((e) => [e, 'file' as const]),
);

/** Builds (or copies) the client into dist/client. */
export async function buildClient(project: Project, opts: { minify?: boolean; dev?: boolean } = {}): Promise<ClientBuild> {
  const out = join(project.dist, 'client');
  const { client } = project.manifest;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  if (client.dir !== undefined) {
    const src = resolve(project.root, client.dir);
    if (!existsSync(join(src, 'index.html'))) throw new CliError(`client.dir "${client.dir}" has no index.html (build your client first, e.g. \`vite build\`)`);
    cpSync(src, out, { recursive: true });
    return { dir: out, files: listFiles(out), inputs: [], sourceDir: src };
  }

  const entry = resolve(project.root, client.entry!);
  const srcDir = dirname(entry);
  if (!existsSync(entry)) throw new CliError(`client entry ${relative(project.root, entry)} not found (set "client.entry" or "client.dir" in vibes.json)`);
  if (!existsSync(join(srcDir, 'index.html'))) throw new CliError(`${relative(project.root, srcDir) || '.'}/index.html not found`);

  let result: esbuild.BuildResult<{ metafile: true }>;
  try {
    result = await esbuild.build({
      absWorkingDir: project.root,
      entryPoints: [entry],
      outfile: join(out, basename(entry, extname(entry)) + '.js'),
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2020',
      minify: !!opts.minify,
      sourcemap: opts.dev ? 'linked' : false,
      legalComments: 'none',
      metafile: true,
      logLevel: 'silent',
      loader: ASSET_LOADERS,
      define: { 'process.env.NODE_ENV': opts.dev ? '"development"' : '"production"' },
    });
  } catch (e) {
    throw await esbuildError(e, project.root);
  }
  const inputs = Object.keys(result.metafile.inputs).map((p) => resolve(project.root, p));
  const bundled = new Set(inputs);
  copyStatic(srcDir, out, bundled);
  return { dir: out, files: listFiles(out), inputs, sourceDir: srcDir };
}

/** Copies index.html and other static files (not TS sources, not files already bundled). */
function copyStatic(from: string, to: string, skip: Set<string>) {
  for (const name of readdirSync(from)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) { copyStatic(src, dst, skip); continue; }
    if (SOURCE_EXT.has(extname(name)) || name.endsWith('.d.ts') || skip.has(src)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst);
  }
}

export function listFiles(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p));
  }
  return out.sort();
}
