/**
 * Text and CSV helpers — exact ports of Madovai-Web's src/Gtfs/Text.php and Csv.php (themselves ports of the iOS
 * GTFSTextUtils / GTFSParsing), plus the few PHP scalar semantics the builder relies on (is_numeric, ctype_digit,
 * (int) casts, round(), float-to-string) so the database is byte-for-byte the one the PHP builder writes.
 */

/** PCRE `\h` (horizontal whitespace) — Swift `.whitespaces`. */
const H = '\\t \\u00A0\\u1680\\u180E\\u2000-\\u200A\\u202F\\u205F\\u3000';
const TRIM_WS = new RegExp(`^[${H}]+|[${H}]+$`, 'gu');

/** Swift `trimmingCharacters(in: .whitespaces)` (spaces, tabs, Unicode Zs). */
export function trimWs(s: string): string {
  return s.replace(TRIM_WS, '');
}

/** PHP `trim()` with its default character list (" \t\n\r\0\x0B"), or a custom list. */
export function phpTrim(s: string, chars = ' \t\n\r\0\x0B'): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

/** ` #\s*\w+$` suffix removal (Cotral appends " # CODE" to stop and route names). PHP /u = Unicode \w and \s. */
const HASH_CODE = / #\s*[\p{L}\p{N}_]+$/u;
export function stripTrailingHashCode(value: string): string {
  return trimWs(value.replace(HASH_CODE, ''));
}

/** `stopName.split(/[|!(]/)[0].trim()` */
export function extractLocality(stopName: string): string {
  const m = /[|!(]/.exec(stopName);
  return trimWs(m ? stopName.slice(0, m.index) : stopName);
}

/** Single-character title case (mb_convert_case MB_CASE_TITLE): a few code points differ from upper case. */
const TITLE_SPECIAL: Record<string, string> = {
  'Ǆ': 'ǅ', 'ǅ': 'ǅ', 'ǆ': 'ǅ',
  'Ǉ': 'ǈ', 'ǈ': 'ǈ', 'ǉ': 'ǈ',
  'Ǌ': 'ǋ', 'ǋ': 'ǋ', 'ǌ': 'ǋ',
  'Ǳ': 'ǲ', 'ǲ': 'ǲ', 'ǳ': 'ǲ',
  'ß': 'Ss', 'ﬀ': 'Ff', 'ﬁ': 'Fi', 'ﬂ': 'Fl', 'ﬃ': 'Ffi', 'ﬄ': 'Ffl', 'ﬅ': 'St', 'ﬆ': 'St',
};
const WORD_START = /(?<![\p{L}\p{M}])(?<![\p{L}\p{M}]['’])\p{L}/gu;

/**
 * Swift `.capitalized`: everything lowercased, then every letter that does not follow another letter is
 * title-cased. Digits and punctuation ("P.LE" -> "P.Le", "A1B" -> "A1B") break words; an apostrophe between
 * letters does not ("D'AOSTA" -> "D'aosta").
 */
export function capitalized(s: string): string {
  return s.toLowerCase().replace(WORD_START, (c) => TITLE_SPECIAL[c] ?? c.toUpperCase());
}

/** Atac trip_headsign "ANAGNINA (MA)" -> "Anagnina"; null when empty. */
export function cleanHeadsign(raw: string): string | null {
  const cleaned = capitalized(extractLocality(raw));
  return cleaned === '' ? null : cleaned;
}

/** mb_strtolower */
export const lower = (s: string): string => s.toLowerCase();

/** Escapes a user string for `LIKE ? ESCAPE '\'`. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

export type KindName = 'bus' | 'tram' | 'metro' | 'treno';

/** GTFS route_type -> app kind (default bus, like TransitVehicleKind(gtfsRouteType:)). */
export function kindName(routeType: number): KindName {
  switch (routeType) {
    case 0: return 'tram';
    case 1: return 'metro';
    case 2: return 'treno';
    default: return 'bus';
  }
}

/** Friendly names of Rome's metro lines (their route_long_name is blank in the feed). */
export function metroName(shortName: string): string | null {
  switch (shortName.toUpperCase()) {
    case 'MEA': return 'Metro A';
    case 'MEB': return 'Metro B';
    case 'MEB1': return 'Metro B1';
    case 'MEC': return 'Metro C';
    default: return null;
  }
}

// ------------------------------------------------------------------ PHP scalar semantics

/** PHP 8 `is_numeric()` for strings (leading/trailing whitespace allowed, no hex). */
const NUMERIC = /^[ \t\n\r\v\f]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\r\v\f]*$/;
export const isNumeric = (s: string): boolean => NUMERIC.test(s);

/** `ctype_digit()` for strings: non-empty, ASCII digits only. */
export const ctypeDigit = (s: string): boolean => s.length > 0 && /^[0-9]+$/.test(s);

/** `preg_match('/^[+-]?\d+$/')` */
export const isIntString = (s: string): boolean => /^[+-]?\d+$/.test(s);

/** PHP `(int) $string`: leading whitespace, optional sign, digits; 0 when nothing parses. */
export function phpInt(s: string): number {
  const m = /^[ \t\n\r\v\f]*([+-]?\d+)/.exec(s);
  return m ? parseInt(m[1], 10) : 0;
}

/** PHP `round()` to an integer: half away from zero. */
export function phpRound(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/**
 * PHP's float-to-string conversion with `precision = 14` (what PDO does to every bound float: the PHP builder
 * passes all values through `execute($params)` = PARAM_STR, and SQLite converts the text back by column affinity).
 * Binding the same text here reproduces the stored REAL values exactly.
 */
export function phpFloatStr(x: number): string {
  if (!Number.isFinite(x)) return x > 0 ? 'INF' : x < 0 ? '-INF' : 'NAN';
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  const [mant, expStr] = x.toExponential(13).split('e');
  const exp = parseInt(expStr, 10);
  const neg = mant.startsWith('-');
  const digits = mant.replace('-', '').replace('.', '').replace(/0+$/, '') || '0';
  let out: string;
  if (exp < -4 || exp >= 14) {
    out = `${digits[0]}.${digits.length > 1 ? digits.slice(1) : '0'}E${exp < 0 ? '-' : '+'}${Math.abs(exp)}`;
  } else if (exp < 0) {
    out = `0.${'0'.repeat(-exp - 1)}${digits}`;
  } else if (digits.length <= exp + 1) {
    out = digits + '0'.repeat(exp + 1 - digits.length);
  } else {
    out = `${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
  }
  return neg ? '-' + out : out;
}

/** PHP 8 "numeric string" test used by comparisons (`<=>`): whitespace allowed around the number. */
function phpNumericValue(s: string): number | null {
  return NUMERIC.test(s) ? Number(s.trim()) : null;
}

/** PHP 8 `$a <=> $b` for two strings: numeric when both are numeric strings, else byte-wise strcmp. */
export function phpCompareStrings(a: string, b: string): number {
  const na = phpNumericValue(a);
  const nb = phpNumericValue(b);
  if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
  return strcmp(a, b);
}

/** Byte-wise (UTF-8) string comparison, like PHP strcmp / SQLite BINARY. */
export function strcmp(a: string, b: string): number {
  if (a === b) return 0;
  const c = Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  return c;
}

// ------------------------------------------------------------------ CSV

/**
 * Quote-aware field split: `""` inside a quoted field is an escaped quote (same hand-rolled semantics as the iOS
 * app / reference server — an unescaped quote inside a field just toggles the quoted state).
 */
export function parseCsvLine(line: string): string[] {
  if (!line.includes('"')) return line.split(',');
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  const n = line.length;
  for (let i = 0; i < n; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && i + 1 < n && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      fields.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

/** "HH:MM:SS" (hours may exceed 23) -> seconds, null if malformed. */
export function timeToSeconds(time: string): number | null {
  if (time.length === 8 && time[2] === ':' && time[5] === ':') {
    const c = (i: number) => time.charCodeAt(i) - 48;
    const d = [c(0), c(1), c(3), c(4), c(6), c(7)];
    if (d.every((v) => v >= 0 && v <= 9)) {
      return d[0] * 36000 + d[1] * 3600 + d[2] * 600 + d[3] * 60 + d[4] * 10 + d[5];
    }
  }
  const parts = phpTrim(time).split(':').filter((p) => p !== '');
  if (parts.length !== 3) return null;
  for (const p of parts) {
    if (!ctypeDigit(p.replace(/^[+-]+/, ''))) return null;
  }
  return phpInt(parts[0]) * 3600 + phpInt(parts[1]) * 60 + phpInt(parts[2]);
}
