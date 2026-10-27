/**
 * Logger used by the runtime. JSON lines to stdout by default; the game server or
 * the CLI can swap it with setLogger(). Never pass tokens, payloads or game state.
 */
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

type Level = keyof Logger;
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function jsonLogger(): Logger {
  const min = order[(process.env.LOG_LEVEL as Level) || 'info'] ?? 20;
  const write = (level: Level) => (msg: string, fields?: Record<string, unknown>) => {
    if (order[level] < min || process.env.LOG_SILENT === '1') return;
    process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }) + '\n');
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

let current: Logger = jsonLogger();

/** The runtime always logs through this object, so setLogger() takes effect everywhere. */
export const log: Logger = {
  debug: (m, f) => current.debug(m, f),
  info: (m, f) => current.info(m, f),
  warn: (m, f) => current.warn(m, f),
  error: (m, f) => current.error(m, f),
};

export function setLogger(l: Logger) { current = l; }
