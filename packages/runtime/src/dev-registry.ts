/**
 * Dev / test registry: sessions come from memory or from DEV_SESSIONS_DIR/<id>.json
 * ({ ...SessionConfig without logic, "logicFile": "path/to/logic.js" }).
 * Never use it in production (the game server refuses it there).
 */
import { readFile } from 'fs/promises';
import { join, resolve, dirname } from 'path';
import { sha256 } from './sandbox';
import type { SessionConfig } from './types';
import type { Outcome, Registry } from './registry';
import { log } from './log';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export class DevRegistry implements Registry {
  readonly sessions = new Map<string, SessionConfig>();
  readonly outcomes = new Map<string, Outcome>();

  constructor(private readonly dir: string | null = null) {}

  add(cfg: SessionConfig) { this.sessions.set(cfg.id, cfg); }

  async load(id: string) {
    const known = this.sessions.get(id);
    if (known) return known;
    if (!this.dir || !ID.test(id)) return null;
    try {
      const file = join(this.dir, `${id}.json`);
      const raw = JSON.parse(await readFile(file, 'utf8')) as SessionConfig & { logicFile: string };
      const code = await readFile(resolve(dirname(file), raw.logicFile), 'utf8');
      const cfg: SessionConfig = { ...raw, id, logic: { code, sha256: sha256(code) } };
      this.sessions.set(id, cfg);
      return cfg;
    } catch {
      return null;
    }
  }

  async started(id: string) { log.info('dev session started', { ses: id }); }

  async finished(id: string, outcome: Outcome) {
    this.outcomes.set(id, outcome);
    log.info('dev session finished', { ses: id, status: outcome.status, reason: outcome.reason });
  }
}
