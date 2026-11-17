/**
 * Port of CotralTrainRoute.swift / CotralTrainRoute.php: ASTRAL's `codicePercorso` values
 * (one per direction of each Cotral rail line).
 */
export interface TrainRouteInfo {
  line: string;
  direction: string;
  destination: string;
}

export const TRAIN_ROUTES = {
  'RL_CC-PSP': { line: 'Metromare', direction: 'Cristoforo Colombo → Porta San Paolo', destination: 'Porta San Paolo' },
  'RL_PSP-CC': { line: 'Metromare', direction: 'Porta San Paolo → Cristoforo Colombo', destination: 'Cristoforo Colombo' },
  'RN_RMMON': { line: 'Roma-Viterbo Urbana', direction: 'Flaminio → Montebello', destination: 'Montebello' },
  'RN_MONRM': { line: 'Roma-Viterbo Urbana', direction: 'Montebello → Flaminio', destination: 'Flaminio' },
  'RV_CATVIT': { line: 'Roma-Viterbo Extraurbana', direction: 'Catalano → Viterbo', destination: 'Viterbo' },
  'RV_VITCAT': { line: 'Roma-Viterbo Extraurbana', direction: 'Viterbo → Catalano', destination: 'Catalano' },
  'RV_MORCAT': { line: 'Roma-Viterbo Extraurbana', direction: 'Morlupo → Catalano', destination: 'Catalano' },
  'RV_CATMOR': { line: 'Roma-Viterbo Extraurbana', direction: 'Catalano → Morlupo', destination: 'Morlupo' },
} as const satisfies Record<string, TrainRouteInfo>;

export type TrainRouteCode = keyof typeof TRAIN_ROUTES;

/** The 8 codes, in the canonical order (also the enum of the `route` query parameter). */
export const TRAIN_ROUTE_CODES = Object.keys(TRAIN_ROUTES) as TrainRouteCode[];

export function isTrainRoute(code: string): code is TrainRouteCode {
  return Object.prototype.hasOwnProperty.call(TRAIN_ROUTES, code);
}

export const lineName = (code: TrainRouteCode): string => TRAIN_ROUTES[code].line;
export const directionLabel = (code: TrainRouteCode): string => TRAIN_ROUTES[code].direction;
export const destinationName = (code: TrainRouteCode): string => TRAIN_ROUTES[code].destination;

/** `CotralTrainRoute.directions(forGTFSRouteShortName:)`: ASTRAL direction codes per GTFS rail line, or null. */
export function directionsForGtfsRouteShortName(shortName: string): TrainRouteCode[] | null {
  switch (shortName.toUpperCase()) {
    case 'ROMALIDO': return ['RL_CC-PSP', 'RL_PSP-CC'];
    case 'RVURB': return ['RN_RMMON', 'RN_MONRM'];
    case 'RVEXT': return ['RV_CATVIT', 'RV_VITCAT', 'RV_MORCAT', 'RV_CATMOR'];
    default: return null;
  }
}
