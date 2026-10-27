/** Small helpers shared by the commands: colors, sizes, errors the user should read. */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  cyan: paint(36),
  dim: paint(2),
  bold: paint(1),
};

/** An error meant for the developer: printed without a stack trace. */
export class CliError extends Error {}

export function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function short(value: unknown, max = 120): string {
  let s: string;
  try { s = JSON.stringify(value) ?? 'undefined'; } catch { s = String(value); }
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
