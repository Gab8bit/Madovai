import type Database from 'better-sqlite3';

/**
 * In-memory search index over stop and line names, built once per database file (≈30k names, a few MB) and
 * dropped with it when the builder replaces the file. A query is a scan of precomputed normalized strings
 * (no SQL, no per-request normalization of the data): about a millisecond.
 *
 * Matching (normalized text, see `normalize`): every word of the query must be contained in the name, in any order.
 * Rank (see `rank`): exact name, name starting with the query, every word at the start of a word of the name
 * (the whole query as a phrase first), then the rest;
 * ties: shorter name first, then the old order (stops: file order; lines: shortName, route_id). Cotral and Atac keep
 * their own limits (stops 15 + 15, lines 10 + 10) and the two lists are merged by rank (ties: Cotral first).
 */

/** Lower case, no accents, punctuation as spaces, spaces collapsed: "ROMA | Termini FS (P.zza)" -> "roma termini fs p zza". */
export function normalize(s: string): string {
  return s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export interface Query { text: string; words: string[] }

export function parseQuery(raw: string): Query | null {
  const text = normalize(Array.from(raw).slice(0, 100).join(''));
  if (text === '') return null;
  return { text, words: [...new Set(text.split(' '))] };
}

/**
 * Rank of `name` (normalized) for the query, -1 when it does not match: 0 identical, 1 starts with the query,
 * 2 every word at the start of a word of the name (2: the whole query as a phrase there, e.g. "metro a" in
 * "cornelia metro a"; 3: the words scattered), 4 every word contained somewhere.
 */
export function rank(name: string, q: Query): number {
  if (name === q.text) return 0;
  if (name.startsWith(q.text)) return 1;
  let allAtWordStart = true;
  for (const w of q.words) {
    if (!name.includes(w)) return -1;
    if (allAtWordStart && !name.startsWith(w) && !name.includes(' ' + w)) allAtWordStart = false;
  }
  if (!allAtWordStart) return 4;
  return name.includes(' ' + q.text) ? 2 : 3;
}

/** Keeps the best `k` items by (rank, length, order) without sorting every match. */
class TopK<T> {
  private readonly items: Array<{ key: [number, number, number]; value: T }> = [];
  constructor(private readonly k: number) {}

  private static less(a: [number, number, number], b: [number, number, number]): boolean {
    return a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];
  }

  offer(key: [number, number, number], value: T): void {
    const items = this.items;
    if (items.length === this.k && !TopK.less(key, items[items.length - 1].key)) return;
    let i = items.length;
    while (i > 0 && TopK.less(key, items[i - 1].key)) i--;
    items.splice(i, 0, { key, value });
    if (items.length > this.k) items.pop();
  }

  ranked(): Array<{ key: [number, number, number]; value: T }> { return this.items; }
}

/** A searchable item: its normalized names (a line has several) and its position in the old order. */
interface Entry<T> { names: string[]; order: number; row: T }

export class SearchIndex<S, R> {
  constructor(
    private readonly cotralStops: Entry<S>[],
    private readonly atacStops: Entry<S>[],
    private readonly cotralRoutes: Entry<R>[],
    private readonly atacRoutes: Entry<R>[],
  ) {}

  static best<T>(entries: Entry<T>[], q: Query, k: number): Array<{ key: [number, number, number]; value: T }> {
    const top = new TopK<T>(k);
    for (const e of entries) {
      let bestRank = -1;
      let bestLen = 0;
      for (const n of e.names) {
        const r = rank(n, q);
        if (r >= 0 && (bestRank < 0 || r < bestRank || (r === bestRank && n.length < bestLen))) {
          bestRank = r;
          bestLen = n.length;
        }
      }
      if (bestRank >= 0) top.offer([bestRank, bestLen, e.order], e.row);
    }
    return top.ranked();
  }

  /**
   * Best Cotral (max `k`) and Atac (max `k`) matches, merged by (rank, length): the per-source limits are the old
   * ones, but a better Atac match comes before a worse Cotral one ("Metro A" → MEA first). Ties: Cotral first.
   */
  static merged<T>(cotral: Entry<T>[], atac: Entry<T>[], q: Query, k: number): T[] {
    const a = SearchIndex.best(cotral, q, k);
    const b = SearchIndex.best(atac, q, k);
    const out: T[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      const takeAtac = i >= a.length || (j < b.length && (b[j].key[0] < a[i].key[0] || (b[j].key[0] === a[i].key[0] && b[j].key[1] < a[i].key[1])));
      out.push(takeAtac ? b[j++].value : a[i++].value);
    }
    return out;
  }

  search(q: Query): { stops: S[]; routes: R[] } {
    return {
      stops: SearchIndex.merged(this.cotralStops, this.atacStops, q, 15),
      routes: SearchIndex.merged(this.cotralRoutes, this.atacRoutes, q, 10),
    };
  }
}

const perDb = new WeakMap<Database.Database, Map<string, unknown>>();

/** A value derived from this database handle, built on first use (`build` runs once per handle and name). */
export function indexFor<T>(db: Database.Database, name: string, build: () => T): T {
  let m = perDb.get(db);
  if (!m) perDb.set(db, (m = new Map()));
  let v = m.get(name) as T | undefined;
  if (v === undefined) {
    v = build();
    m.set(name, v);
  }
  return v;
}

export function entry<T>(names: string[], order: number, row: T): Entry<T> {
  return { names: [...new Set(names.map(normalize).filter((n) => n !== ''))], order, row };
}
