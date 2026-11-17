/**
 * Stops of a line in route order, computed by the builder from stop_times (Atac and Cotral bus; Cotral rail keeps
 * its own longest-trip order in Store.railStopsInOrder).
 *
 * For every direction_id the representative trip is the one with the most stops (ties: the trip whose shape is the
 * most frequent in that direction, then the first trip in trips.txt). The line's stop list is:
 *   1. the stops of direction 0's representative, in stop_sequence order;
 *   2. stops that only appear on the other directions' representatives, appended in their sequence order;
 *   3. stops that only appear on other trips (branches, short or detour variants), each inserted right after the
 *      nearest preceding stop of that trip already in the list (or before the nearest following one, or at the end).
 * Every stop served by the line appears exactly once, so the list has the same stops as atac_stop_routes /
 * cotral_stop_routes.
 */

/**
 * Collects stop_times rows while the file streams, reducing each trip to its stop pattern as soon as the trip's rows
 * end (GTFS files list a trip's rows together; a trip that shows up again later is merged back). Identical patterns
 * are stored once, so memory is a few thousand patterns + one Int32 per trip instead of millions of rows.
 */
export class TripStopCollector {
  private readonly stopIdx = new Map<string, number>();
  readonly stopIds: string[] = [];
  /** pattern id => (seq, stop) pairs sorted by seq / stop indexes in that order */
  private readonly pairs: Int32Array[] = [];
  private readonly stops: Int32Array[] = [];
  /** hash of the (seq, stop) pairs => pattern ids with that hash (no per-trip key strings) */
  private readonly patternIdx = new Map<number, number[]>();
  private tripPattern = new Int32Array(1 << 16).fill(-1);
  private cur = -1;
  private curSeq: number[] = [];
  private curStop: number[] = [];
  rows = 0;

  /** `trip` is a 0-based trip index; a non-integer sequence sorts as 0 (file order kept). */
  add(trip: number, seq: string, stopId: string): void {
    if (trip !== this.cur) {
      this.flush();
      this.cur = trip;
    }
    let s = this.stopIdx.get(stopId);
    if (s === undefined) {
      s = this.stopIds.push(stopId) - 1;
      this.stopIdx.set(stopId, s);
    }
    const n = Number.parseInt(seq, 10);
    this.curSeq.push(Number.isFinite(n) ? n : 0);
    this.curStop.push(s);
    this.rows++;
  }

  private flush(): void {
    const t = this.cur;
    if (t < 0 || this.curSeq.length === 0) return;
    if (t >= this.tripPattern.length) {
      const b = new Int32Array(Math.max(t + 1, this.tripPattern.length * 2)).fill(-1);
      b.set(this.tripPattern);
      this.tripPattern = b;
    }
    let seq = this.curSeq;
    let stop = this.curStop;
    const prev = this.tripPattern[t];
    if (prev >= 0) { // the trip's rows were split: earlier rows first, then these
      const p = this.pairs[prev];
      const s0: number[] = [];
      const st0: number[] = [];
      for (let i = 0; i < p.length; i += 2) { s0.push(p[i]); st0.push(p[i + 1]); }
      seq = s0.concat(seq);
      stop = st0.concat(stop);
    }
    const n = seq.length;
    let sorted = true;
    for (let i = 1; i < n && sorted; i++) if (seq[i] < seq[i - 1]) sorted = false;
    const order = sorted ? null : seq.map((_, i) => i).sort((a, b) => seq[a] - seq[b]); // stable
    let hash = n;
    for (let k = 0; k < n; k++) {
      const i = order ? order[k] : k;
      hash = (Math.imul(hash, 31) + seq[i]) | 0;
      hash = (Math.imul(hash, 31) + stop[i]) | 0;
    }
    let id = -1;
    const candidates = this.patternIdx.get(hash);
    if (candidates) {
      for (const c of candidates) {
        const p = this.pairs[c];
        if (p.length !== 2 * n) continue;
        let same = true;
        for (let k = 0; k < n && same; k++) {
          const i = order ? order[k] : k;
          same = p[2 * k] === seq[i] && p[2 * k + 1] === stop[i];
        }
        if (same) { id = c; break; }
      }
    }
    if (id < 0) {
      const pairs = new Int32Array(2 * n);
      const stops = new Int32Array(n);
      for (let k = 0; k < n; k++) {
        const i = order ? order[k] : k;
        pairs[2 * k] = seq[i];
        pairs[2 * k + 1] = stop[i];
        stops[k] = stop[i];
      }
      id = this.pairs.push(pairs) - 1;
      this.stops.push(stops);
      if (candidates) candidates.push(id);
      else this.patternIdx.set(hash, [id]);
    }
    this.tripPattern[t] = id;
    this.curSeq.length = 0;
    this.curStop.length = 0;
  }

  /** Ends the stream (flushes the last trip). */
  finish(): void {
    this.flush();
    this.cur = -1;
    this.patternIdx.clear();
  }

  get patternCount(): number { return this.stops.length; }

  /** Pattern id of a trip, -1 when it had no rows. */
  patternOf(trip: number): number {
    return trip < this.tripPattern.length ? this.tripPattern[trip] : -1;
  }

  /** Stop indexes of a pattern, in stop_sequence order. */
  stopsOf(pattern: number): Int32Array {
    return this.stops[pattern];
  }
}

export interface TripInfo {
  /** 0-based trip index (file order, used for ties). */
  trip: number;
  /** Stop pattern id (TripStopCollector.patternOf). */
  pattern: number;
  direction: number;
  /** Shape index (-1 = none). */
  shape: number;
  headsign: string | null;
}

export interface RouteOrder {
  /** Every stop of the line, in route order (stop indexes). */
  stops: number[];
  /** One entry per direction_id (ascending): the representative trip's stops in sequence order. */
  directions: Array<{ directionId: number; headsign: string | null; stops: number[] }>;
}

interface Pattern { stops: Int32Array; count: number; first: number; direction: number; headsign: string | null; shapeFreq: number }

/** Order of one line's stops from its trips (see the module comment). */
export function orderRoute(trips: TripInfo[], stopsOf: (pattern: number) => Int32Array): RouteOrder {
  // shape frequency per direction (tie-break of the representative trip)
  const shapeFreq = new Map<string, number>();
  for (const t of trips) if (t.shape >= 0) shapeFreq.set(`${t.direction}:${t.shape}`, (shapeFreq.get(`${t.direction}:${t.shape}`) ?? 0) + 1);

  // distinct stop patterns per direction
  const patterns = new Map<string, Pattern>();
  for (const t of trips) {
    if (t.pattern < 0) continue;
    const stops = stopsOf(t.pattern);
    if (stops.length === 0) continue;
    const key = `${t.direction}|${t.pattern}`;
    const freq = t.shape >= 0 ? shapeFreq.get(`${t.direction}:${t.shape}`) ?? 0 : 0;
    const p = patterns.get(key);
    if (p) {
      p.count++;
      if (freq > p.shapeFreq) p.shapeFreq = freq;
    } else {
      patterns.set(key, { stops, count: 1, first: t.trip, direction: t.direction, headsign: t.headsign, shapeFreq: freq });
    }
  }
  const all = [...patterns.values()];

  // representative per direction: most stops, then most frequent shape, then first trip
  const reps = new Map<number, Pattern>();
  for (const p of all) {
    const cur = reps.get(p.direction);
    if (!cur || p.stops.length > cur.stops.length
      || (p.stops.length === cur.stops.length && (p.shapeFreq > cur.shapeFreq || (p.shapeFreq === cur.shapeFreq && p.first < cur.first)))) {
      reps.set(p.direction, p);
    }
  }
  const dirs = [...reps.keys()].sort((a, b) => a - b);

  const order: number[] = [];
  const seen = new Set<number>();
  for (const d of dirs) {
    for (const s of reps.get(d)!.stops) {
      if (!seen.has(s)) { seen.add(s); order.push(s); }
    }
  }

  // other trips: most common patterns first, then file order
  const repSet = new Set(reps.values());
  const rest = all.filter((p) => !repSet.has(p)).sort((a, b) => b.count - a.count || a.first - b.first);
  for (const p of rest) {
    const s = p.stops;
    for (let i = 0; i < s.length; i++) {
      if (seen.has(s[i])) continue;
      // nearest preceding stop of this trip already placed -> right after it
      let at = -1;
      for (let j = i - 1; j >= 0 && at < 0; j--) if (seen.has(s[j])) at = order.indexOf(s[j]) + 1;
      // else nearest following one -> right before it
      for (let j = i + 1; j < s.length && at < 0; j++) if (seen.has(s[j])) at = order.indexOf(s[j]);
      if (at < 0) at = order.length;
      order.splice(at, 0, s[i]);
      seen.add(s[i]);
    }
  }

  return {
    stops: order,
    directions: dirs.map((d) => {
      const p = reps.get(d)!;
      return { directionId: d, headsign: p.headsign, stops: [...p.stops] };
    }),
  };
}
