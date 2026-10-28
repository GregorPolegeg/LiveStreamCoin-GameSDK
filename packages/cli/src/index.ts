#!/usr/bin/env node
/**
 * vibes-games: the developer CLI for VIBES DM games.
 *
 *   vibes-games dev     local multiplayer: N players side by side, live reload
 *   vibes-games build   dist/logic.js (+ sha256) and dist/client/
 *   vibes-games check   the automatic release checks (spec §9.1) that run locally
 *   vibes-games test    runs test/*.test.ts with node:test
 *   vibes-games login / push / submit / status   publishing (publish.ts)
 */
import { spawn } from 'child_process';
import { parseArgs, intFlag, strFlag, type Args } from './args';
import { buildClient, buildLogic } from './build';
import { check } from './check';
import { dev } from './dev';
import { loadProject } from './manifest';
import { login, push, status, submit } from './publish';
import { runTests } from './test-cmd';
import { c, CliError, kb } from './util';

const VERSION = '0.1.0';

const HELP = `vibes-games ${VERSION}: build, check and run VIBES DM games locally

Usage: vibes-games <command> [options]

Commands
  dev                    Local multiplayer: one window per player, live reload
    --players <n>        players in the first session (default: players.min)
    --port <port>        default 5173
    --host <host>        default 127.0.0.1
  build                  dist/logic.js (+ sha256) and dist/client/
    --minify             minify the logic and client
  check                  Build, then run the automatic release checks
    --games <n>          fuzz games (default 200)
    --steps <n>          max steps per fuzz game (default 300)
  test                   Run test/*.test.ts with node:test

Publishing (portal: Applications → your app → Game)
  login --token <token>  Once: the upload token from the portal
  push                   Build, run the checks, upload: "Testing", only you see it under + → Games
    --submit             also send it to review
    --skip-check         upload without the checks (the reviewer sees they were skipped)
    --app <id>           when you are logged in to more than one app
  submit [version]       Send a tested version (default: the newest Testing one) to review
  status                 Your versions and where they are

Options
  --dir <path>           the game project (default: current folder)
  -h, --help             this help
`;

/** isolated-vm needs --no-node-snapshot on Node >= 20: run ourselves again with it. */
function needsRespawn(): boolean {
  return !process.execArgv.includes('--no-node-snapshot') && !(process.env.NODE_OPTIONS ?? '').includes('--no-node-snapshot');
}

function respawn() {
  const child = spawn(process.execPath, ['--no-node-snapshot', ...process.execArgv, __filename, ...process.argv.slice(2)], { stdio: 'inherit' });
  // Forward signals (Ctrl+C in a terminal also reaches the child directly; it ignores repeats).
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => { try { child.kill(sig); } catch { /* gone */ } });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 130 : 1)));
}

async function main(args: Args): Promise<number> {
  const dir = strFlag(args, 'dir') ?? process.cwd();
  switch (args.command) {
    case 'build': {
      const project = loadProject(dir);
      const minify = args.flags.minify === true;
      const logic = await buildLogic(project, { minify });
      for (const w of logic.warnings) process.stdout.write(`${c.yellow('warn')} ${w}\n`);
      const client = await buildClient(project, { minify });
      process.stdout.write(`${c.green('built')} dist/logic.js  ${kb(logic.bytes)}\n`);
      process.stdout.write(`      sha256 ${logic.sha256}\n`);
      process.stdout.write(`${c.green('built')} dist/client/   ${client.files.length} file(s): ${client.files.slice(0, 8).join(', ')}${client.files.length > 8 ? ', …' : ''}\n`);
      return 0;
    }
    case 'check': {
      const games = intFlag(args, 'games', 200, 1, 10_000);
      const steps = intFlag(args, 'steps', 300, 1, 10_000);
      process.stdout.write(`vibes-games check: ${games} fuzz games x 2 runs, up to ${steps} steps each\n\n`);
      const report = await check(dir, { games, steps, minify: args.flags.minify === true });
      report.print();
      return report.failed ? 1 : 0;
    }
    case 'dev': {
      const players = args.flags.players === undefined ? undefined : intFlag(args, 'players', 2, 1, 16);
      const port = intFlag(args, 'port', 5173, 0, 65535);
      const server = await dev(dir, { players, port, host: strFlag(args, 'host') ?? '127.0.0.1', verbose: args.flags.verbose === true });
      await new Promise<void>((resolve) => {
        let stopping = false;
        const stop = () => {
          if (stopping) return;
          stopping = true;
          process.stdout.write('\nstopping…\n');
          setTimeout(() => process.exit(0), 5000).unref();
          resolve();
        };
        for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, stop);
      });
      await server.close();
      return 0;
    }
    case 'test':
      return runTests(dir, args.positional);
    case 'login':
      return login(strFlag(args, 'token') ?? args.positional[0], strFlag(args, 'api'), dir);
    case 'push':
    case 'upload':
      return push(dir, { submit: args.flags.submit === true, skipCheck: args.flags['skip-check'] === true, app: strFlag(args, 'app') });
    case 'submit':
      return submit(dir, args.positional[0], strFlag(args, 'app'));
    case 'status':
      return status(dir, strFlag(args, 'app'));
    case 'version':
      process.stdout.write(VERSION + '\n');
      return 0;
    case null:
    case 'help':
      process.stdout.write(HELP);
      return args.command === null && !args.flags.help && !args.flags.h ? 1 : 0;
    default:
      process.stderr.write(`unknown command "${args.command}"\n\n${HELP}`);
      return 1;
  }
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.help || args.flags.h) { process.stdout.write(HELP); process.exit(0); }
  const sandboxed = ['build', 'check', 'dev', 'push', 'upload'].includes(args.command ?? '');
  if (sandboxed && needsRespawn()) respawn();
  else {
    main(args).then((code) => process.exit(code), (e) => {
      if (e instanceof CliError) process.stderr.write(`${c.red('error')} ${e.message}\n`);
      else process.stderr.write(`${c.red('error')} ${(e as Error)?.stack ?? e}\n`);
      process.exit(1);
    });
  }
}

export { check, buildLogic, buildClient, dev, loadProject };
