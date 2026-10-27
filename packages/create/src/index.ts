#!/usr/bin/env node
/**
 * npx create-vibes-game my-game
 *
 * Copies the template (a working tic-tac-toe in TypeScript) into ./my-game and
 * sets the game's name and slug.
 */
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { basename, join, relative, resolve } from 'path';

const TEMPLATE = join(__dirname, '..', 'template');
const TEMPLATE_NAME = 'Tic Tac Toe';
const TEMPLATE_SLUG = 'tic-tac-toe';

export function toSlug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

export function toTitle(slug: string): string {
  return slug.split('-').filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
}

export function create(target: string, opts: { name?: string; force?: boolean } = {}): { dir: string; slug: string; name: string } {
  const dir = resolve(target);
  const slug = toSlug(basename(dir));
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) throw new Error(`"${basename(dir)}" does not give a valid slug (3-40 characters of a-z, 0-9, "-")`);
  const name = opts.name?.trim() || toTitle(slug);
  if (existsSync(dir) && readdirSync(dir).length > 0 && !opts.force) throw new Error(`${dir} already exists and is not empty (use --force to write into it)`);

  cpSync(TEMPLATE, dir, { recursive: true, filter: (src) => !/[\\/](node_modules|dist)([\\/]|$)/.test(relative(TEMPLATE, src)) });
  // npm drops .gitignore from published packages, so the template ships it as "gitignore".
  if (existsSync(join(dir, 'gitignore'))) renameSync(join(dir, 'gitignore'), join(dir, '.gitignore'));

  const manifestFile = join(dir, 'vibes.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  manifest.name = name;
  manifest.slug = slug;
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');

  const pkgFile = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  pkg.name = slug;
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');

  for (const f of ['README.md', 'client/index.html']) {
    const p = join(dir, f);
    if (existsSync(p)) writeFileSync(p, readFileSync(p, 'utf8').replaceAll(TEMPLATE_NAME, name).replaceAll(TEMPLATE_SLUG, slug));
  }
  return { dir, slug, name };
}

function main(argv: string[]): number {
  const positional = argv.filter((a) => !a.startsWith('-'));
  const nameFlag = argv.indexOf('--name');
  const name = nameFlag >= 0 ? argv[nameFlag + 1] : undefined;
  const target = positional.filter((p) => p !== name)[0];
  if (!target || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('Usage: npx create-vibes-game <folder> [--name "My Game"] [--force]\n');
    return target ? 0 : 1;
  }
  try {
    const r = create(target, { name, force: argv.includes('--force') });
    const rel = relative(process.cwd(), r.dir) || '.';
    process.stdout.write(`\nCreated "${r.name}" (slug ${r.slug}) in ${rel}\n\nNext steps:\n` +
      `  cd ${rel}\n` +
      '  npm install\n' +
      '  npm run dev      # one window per player, live reload\n' +
      '  npm test         # unit tests for the rules\n' +
      '  npm run check    # the automatic checks VIBES runs before a release\n\n' +
      'The rules are in logic/index.ts, the screen in client/main.ts.\n');
    return 0;
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
