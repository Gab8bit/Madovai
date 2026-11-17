import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

/**
 * GTFS-Realtime decoding (gtfs-realtime-bindings / protobufjs), specialised for what the app needs from Roma
 * Mobilità's two feeds. Port of Madovai-Web's GtfsRealtime.php (a hand-written decoder) with identical semantics —
 * notably proto2 field PRESENCE matters (absent trip_id → null, absent bearing → null, absent stop_sequence →
 * running index), so presence is checked with hasOwnProperty (protobufjs keeps defaults on the prototype).
 *
 * Cancellation = TripDescriptor CANCELED(3)/DELETED(7) OR StopTimeUpdate SKIPPED(1) (AtacStopArrivalClient semantics).
 */
const rt = GtfsRealtimeBindings.transit_realtime;

export const TRIP_CANCELED = 3;
export const TRIP_DELETED = 7;
export const STOP_SKIPPED = 1;

export interface RawVehicle {
  id: string;
  lat: number;
  lon: number;
  bearing: number | null;
  /** '' when the trip (or its route_id) is absent. */
  routeId: string;
  tripId: string | null;
}

export interface VehicleFeed {
  timestamp: number;
  vehicles: RawVehicle[];
}

/** One upcoming event at a stop (only ts > decode time − 120 s are indexed). */
export interface StopEvent {
  tripId: string;
  routeId: string;
  ts: number;
  delay: number | null;
  cancelled: boolean;
}

export interface TripStop {
  stopId: string;
  sequence: number;
  ts: number;
  delay: number | null;
}

export interface TripEntry {
  route: string;
  stops: TripStop[];
}

export interface TripUpdatesIndex {
  timestamp: number;
  byStop: Map<string, StopEvent[]>;
  byTrip: Map<string, TripEntry>;
}

const has = (o: object | null | undefined, k: string): boolean => o != null && Object.prototype.hasOwnProperty.call(o, k);

/** uint64/int64 fields come back as Long objects (or numbers): unix seconds fit a double. */
function toNum(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && typeof (v as { toNumber?: () => number }).toNumber === 'function') {
    return (v as { toNumber: () => number }).toNumber();
  }
  return Number(v);
}

type Entity = GtfsRealtimeBindings.transit_realtime.FeedEntity;

/**
 * Splits the top-level FeedMessage by hand and decodes the header and each entity separately with the bindings, so a
 * single malformed entity (protobufjs throws on a missing proto2 `required` field) is skipped instead of failing the
 * whole feed — the tolerance of Madovai-Web's hand-written decoder. A truncated/garbage buffer still throws.
 */
function decodeFeed(buf: Uint8Array): { timestamp: number; entities: Entity[] } {
  let p = 0;
  const end = buf.length;
  const varint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (p >= end) throw new Error('GTFS-RT: varint troncato');
      const b = buf[p++];
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
      if (shift > 63) throw new Error('GTFS-RT: varint non valido');
    }
  };
  let timestamp = 0;
  const entities: Entity[] = [];
  while (p < end) {
    const tag = varint();
    const wt = tag % 8;
    const field = Math.floor(tag / 8);
    if (wt === 0) { varint(); continue; }
    if (wt === 1) { p += 8; continue; }
    if (wt === 5) { p += 4; continue; }
    if (wt !== 2) throw new Error(`GTFS-RT: wire type ${wt} non supportato`);
    const len = varint();
    if (p + len > end) throw new Error('GTFS-RT: campo troncato');
    const slice = buf.subarray(p, p + len);
    p += len;
    try {
      if (field === 1) {
        const h = rt.FeedHeader.decode(slice);
        timestamp = has(h, 'timestamp') ? toNum(h.timestamp) : 0;
      } else if (field === 2) {
        entities.push(rt.FeedEntity.decode(slice));
      }
    } catch {
      // malformed header/entity: skipped
    }
  }
  if (p > end) throw new Error('GTFS-RT: messaggio troncato');
  return { timestamp, entities };
}

function tripIds(trip: GtfsRealtimeBindings.transit_realtime.ITripDescriptor | null | undefined): { routeId: string; tripId: string | null; rel: number | null } {
  if (!trip) return { routeId: '', tripId: null, rel: null };
  return {
    routeId: has(trip, 'routeId') ? String(trip.routeId) : '',
    tripId: has(trip, 'tripId') ? String(trip.tripId) : null,
    rel: has(trip, 'scheduleRelationship') ? Number(trip.scheduleRelationship) : null,
  };
}

/**
 * `vehicle_positions` → vehicles that have a position (AtacRealtimeService.decodeVehicles): id = vehicle.vehicle.id
 * else entity.id; routeId '' when the trip is absent; bearing null when absent.
 */
export function decodeVehicles(buf: Uint8Array): VehicleFeed {
  const feed = decodeFeed(buf);
  const vehicles: RawVehicle[] = [];
  for (const entity of feed.entities) {
    const v = entity.vehicle;
    if (!v || !v.position) continue;
    const pos = v.position;
    const { routeId, tripId } = tripIds(v.trip);
    const vehicleId = v.vehicle && has(v.vehicle, 'id') ? String(v.vehicle.id) : null;
    vehicles.push({
      id: vehicleId ?? (has(entity, 'id') ? String(entity.id) : ''),
      lat: has(pos, 'latitude') ? pos.latitude : 0,
      lon: has(pos, 'longitude') ? pos.longitude : 0,
      bearing: has(pos, 'bearing') ? (pos.bearing as number) : null,
      routeId,
      tripId,
    });
  }
  return { timestamp: feed.timestamp, vehicles };
}

/**
 * `trip_updates` → two indexes built in a single pass (AtacRealtimeService.decodeTripUpdates):
 *  byStop[stopId] = events with ts > now−120 (unsorted);
 *  byTrip[tripId] = { route, stops: all stops (unsorted) }.
 * The event is `arrival` if present, else `departure`; skipped when it has no time or time ≤ 0.
 *
 * @param now unix seconds (decode time)
 */
export function decodeTripUpdates(buf: Uint8Array, now: number): TripUpdatesIndex {
  const feed = decodeFeed(buf);
  const byStop = new Map<string, StopEvent[]>();
  const byTrip = new Map<string, TripEntry>();
  for (const entity of feed.entities) {
    const tu = entity.tripUpdate;
    if (!tu) continue;
    const { routeId, tripId: rawTripId, rel } = tripIds(tu.trip);
    const tripId = rawTripId ?? (has(entity, 'id') ? String(entity.id) : '');
    const tripCancelled = rel === TRIP_CANCELED || rel === TRIP_DELETED;

    for (const stu of tu.stopTimeUpdate ?? []) {
      if (!has(stu, 'stopId')) continue;
      const stopId = String(stu.stopId);
      const ev = stu.arrival ?? stu.departure;
      if (!ev) continue;
      if (!has(ev, 'time')) continue;
      const time = toNum(ev.time);
      if (time <= 0) continue;
      const delay = has(ev, 'delay') ? Number(ev.delay) : null;
      const skipped = has(stu, 'scheduleRelationship') && Number(stu.scheduleRelationship) === STOP_SKIPPED;

      if (time - now > -120) {
        let list = byStop.get(stopId);
        if (!list) byStop.set(stopId, (list = []));
        list.push({ tripId, routeId, ts: time, delay, cancelled: tripCancelled || skipped });
      }
      let trip = byTrip.get(tripId);
      if (!trip) byTrip.set(tripId, (trip = { route: routeId, stops: [] }));
      trip.stops.push({
        stopId,
        sequence: has(stu, 'stopSequence') ? Number(stu.stopSequence) : trip.stops.length,
        ts: time,
        delay,
      });
    }
  }
  return { timestamp: feed.timestamp, byStop, byTrip };
}
