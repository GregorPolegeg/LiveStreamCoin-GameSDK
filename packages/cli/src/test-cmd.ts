/** `vibes-games test`: bundles test/*.test.ts with esbuild and runs them with node:test. No ts-node / tsx needed. */
import { spawn } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { basename, join, resolve } from 'path';
import * as esbuild from 'esbuild';
import { listFiles } from './build';
import { CliError } from './util';

export async function runTests(dir: string, extra: string[]): Promise<number> {
  const root = resolve(dir);
  const testDir = join(root, 'test');
  const files = listFiles(testDir).filter((f) => /\.test\.(ts|mts|js|mjs|tsx)$/.test(f)).map((f) => join(testDir, f));
  if (!files.length) throw new CliError('no tests found (test/*.test.ts)');
  const out = join(root, 'dist', 'test');
  rmSync(out, { recursive: true, force: true });
  try {
    await esbuild.build({
      absWorkingDir: root,
      entryPoints: files,
      outdir: out,
      outbase: testDir,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      packages: 'external',
      sourcemap: 'inline',
      logLevel: 'silent',
      outExtension: { '.js': '.cjs' },
    });
  } catch (e) {
    const errs = (e as esbuild.BuildFailure).errors;
    throw new CliError(errs ? (await esbuild.formatMessages(errs, { kind: 'error', color: false })).join('\n') : String(e));
  }
  const built = listFiles(out).filter((f) => f.endsWith('.cjs')).map((f) => join(out, f));
  if (!built.length || !built.every((f) => existsSync(f))) throw new CliError('tests did not build');
  process.stdout.write(`running ${built.map((f) => basename(f)).join(', ')}\n`);
  return new Promise((ok) => {
    const child = spawn(process.execPath, ['--enable-source-maps', '--test', ...extra, ...built], { cwd: root, stdio: 'inherit' });
    child.on('exit', (code) => ok(code ?? 1));
  });
}
