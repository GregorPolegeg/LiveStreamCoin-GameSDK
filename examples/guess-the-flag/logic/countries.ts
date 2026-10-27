// Countries in the game (ISO 3166-1 alpha-2, lower case), by continent.
// Names come from the player's own language in the client (Intl.DisplayNames), so the logic only needs codes.
// Flag images: client/flags/<code>.svg (flag-icons, MIT).

export const REGIONS = {
  europe: ['al', 'ad', 'at', 'by', 'be', 'ba', 'bg', 'hr', 'cy', 'cz', 'dk', 'ee', 'fi', 'fr', 'de', 'gr', 'hu', 'is', 'ie', 'it', 'xk', 'lv', 'li', 'lt', 'lu', 'mt', 'md', 'mc', 'me', 'nl', 'mk', 'no', 'pl', 'pt', 'ro', 'ru', 'sm', 'rs', 'sk', 'si', 'es', 'se', 'ch', 'ua', 'gb', 'va'],
  asia: ['af', 'am', 'az', 'bh', 'bd', 'bt', 'bn', 'kh', 'cn', 'ge', 'in', 'id', 'ir', 'iq', 'il', 'jp', 'jo', 'kz', 'kw', 'kg', 'la', 'lb', 'my', 'mv', 'mn', 'mm', 'np', 'kp', 'om', 'pk', 'ps', 'ph', 'qa', 'sa', 'sg', 'kr', 'lk', 'sy', 'tw', 'tj', 'th', 'tl', 'tr', 'tm', 'ae', 'uz', 'vn', 'ye'],
  africa: ['dz', 'ao', 'bj', 'bw', 'bf', 'bi', 'cv', 'cm', 'cf', 'td', 'km', 'cg', 'cd', 'ci', 'dj', 'eg', 'gq', 'er', 'sz', 'et', 'ga', 'gm', 'gh', 'gn', 'gw', 'ke', 'ls', 'lr', 'ly', 'mg', 'mw', 'ml', 'mr', 'mu', 'ma', 'mz', 'na', 'ne', 'ng', 'rw', 'st', 'sn', 'sc', 'sl', 'so', 'za', 'ss', 'sd', 'tz', 'tg', 'tn', 'ug', 'zm', 'zw'],
  americas: ['ag', 'ar', 'bs', 'bb', 'bz', 'bo', 'br', 'ca', 'cl', 'co', 'cr', 'cu', 'dm', 'do', 'ec', 'sv', 'gd', 'gt', 'gy', 'ht', 'hn', 'jm', 'mx', 'ni', 'pa', 'py', 'pe', 'kn', 'lc', 'vc', 'sr', 'tt', 'us', 'uy', 've'],
  oceania: ['au', 'fj', 'ki', 'mh', 'fm', 'nr', 'nz', 'pw', 'pg', 'ws', 'sb', 'to', 'tv', 'vu'],
} as const;

export type Region = keyof typeof REGIONS;
export const REGION_NAMES = Object.keys(REGIONS) as Region[];

/** Well-known flags: the default pool, so a first game isn't 10 x "which island is this". */
export const FAMOUS = [
  'at', 'be', 'hr', 'cz', 'dk', 'fi', 'fr', 'de', 'gr', 'hu', 'is', 'ie', 'it', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'rs', 'si', 'es', 'se', 'ch', 'ua', 'gb', 'ba', 'sk', 'bg',
  'cn', 'in', 'jp', 'kr', 'tr', 'il', 'sa', 'th', 'vn', 'id', 'ph', 'pk', 'ir', 'ae',
  'eg', 'za', 'ng', 'ke', 'ma', 'gh', 'et', 'sn', 'tn', 'dz',
  'us', 'ca', 'mx', 'br', 'ar', 'cl', 'co', 'pe', 'cu', 'jm', 'uy', 've',
  'au', 'nz', 'fj',
] as const;

const REGION_OF: Record<string, Region> = {};
for (const r of REGION_NAMES) for (const c of REGIONS[r]) REGION_OF[c] = r;
export const regionOf = (code: string): Region | undefined => REGION_OF[code];

export const ALL: readonly string[] = REGION_NAMES.flatMap((r) => REGIONS[r]);
