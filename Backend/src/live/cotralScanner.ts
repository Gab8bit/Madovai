import { canTrackVehicle, isDelayReliable, transits, vehiclePosition, type Transit } from './cotral.js';
import { isTrainRoute } from './cotralTrainRoute.js';
import { settleWithin } from './fanout.js';

/**
 * Server-side port of CotralViewportVehicleService.scan() (Madovai-Web's CotralScanner.php):
 * poles → live transits → trackable vehicles → positions. Two concurrent fan-outs sharing a ~10 s budget; a failed
 * or late sub-request is skipped, never fatal. Each upstream answer goes through the same per-pole (8 s) /
 * per-vehicle (5 s) cache as the single-item endpoints.
 */
export const MAX_POLES = 15;
const BUDGET_MS = 10_000;

export interface CotralVehicle {
  id: string;
  code: string;
  lat: number;
  lon: number;
  routeId: string | null;
  routeLabel: string | null;
  kind: 'bus' | 'treno';
  delaySeconds: number | null;
  tripId: string | null;
}

/** @param poleCodes already validated */
export async function scanVehicles(poleCodes: string[]): Promise<CotralVehicle[]> {
  const start = Date.now();
  const poles = [...new Set(poleCodes)];

  // 1) transits per pole (cached; misses fetched concurrently).
  const poleBudget = BUDGET_MS * 0.6;
  const byPole = await settleWithin(poles, (code) => transits(code, poleBudget), poleBudget);

  // Keep the originating transit per vehicle (later poles win, as in the Swift merge).
  const transitByVehicle = new Map<string, Transit>();
  for (const code of poles) {
    for (const t of byPole.get(code)?.transits ?? []) {
      if (canTrackVehicle(t)) transitByVehicle.set(t.vehicleCode as string, t);
    }
  }

  // 2) position per vehicle (cached; misses fetched concurrently).
  const remaining = Math.max(1_000, BUDGET_MS - (Date.now() - start));
  const positions = await settleWithin([...transitByVehicle.keys()], (v) => vehiclePosition(v, remaining), remaining);

  const vehicles: CotralVehicle[] = [];
  for (const [vcode, t] of transitByVehicle) {
    const pos = positions.get(vcode);
    if (!pos) continue;
    const routeId = t.percorso === '' ? null : t.percorso;
    vehicles.push({
      id: `cotral-${vcode}`,
      code: vcode,
      lat: pos.lat,
      lon: pos.lon,
      routeId,
      routeLabel: routeId,
      kind: routeId !== null && isTrainRoute(routeId) ? 'treno' : 'bus',
      delaySeconds: isDelayReliable(t) ? t.ritardoSeconds : null,
      tripId: t.idCorsa === '' ? null : t.idCorsa,
    });
  }
  return vehicles;
}
