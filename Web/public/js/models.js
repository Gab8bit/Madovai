// Static lookup tables ported from the iOS models (CotralTrainRoute, AtacMetroLine, Weekday, TransitOperator).

/**
 * `codicePercorso` values ASTRAL keys rail schedules by — one per direction of
 * each rail line (port of `CotralTrainRoute`). `gtfs` is the GTFS rail route's
 * `route_short_name` the line corresponds to.
 */
export const TRAIN_ROUTES = {
  'RL_CC-PSP': { line: 'Metromare', label: 'Cristoforo Colombo → Porta San Paolo', dest: 'Porta San Paolo', reversed: 'RL_PSP-CC', gtfs: 'ROMALIDO' },
  'RL_PSP-CC': { line: 'Metromare', label: 'Porta San Paolo → Cristoforo Colombo', dest: 'Cristoforo Colombo', reversed: 'RL_CC-PSP', gtfs: 'ROMALIDO' },
  'RN_RMMON': { line: 'Roma-Viterbo Urbana', label: 'Flaminio → Montebello', dest: 'Montebello', reversed: 'RN_MONRM', gtfs: 'RVURB' },
  'RN_MONRM': { line: 'Roma-Viterbo Urbana', label: 'Montebello → Flaminio', dest: 'Flaminio', reversed: 'RN_RMMON', gtfs: 'RVURB' },
  'RV_CATVIT': { line: 'Roma-Viterbo Extraurbana', label: 'Catalano → Viterbo', dest: 'Viterbo', reversed: 'RV_VITCAT', gtfs: 'RVEXT' },
  'RV_VITCAT': { line: 'Roma-Viterbo Extraurbana', label: 'Viterbo → Catalano', dest: 'Catalano', reversed: 'RV_CATVIT', gtfs: 'RVEXT' },
  'RV_MORCAT': { line: 'Roma-Viterbo Extraurbana', label: 'Morlupo → Catalano', dest: 'Catalano', reversed: 'RV_CATMOR', gtfs: 'RVEXT' },
  'RV_CATMOR': { line: 'Roma-Viterbo Extraurbana', label: 'Catalano → Morlupo', dest: 'Morlupo', reversed: 'RV_MORCAT', gtfs: 'RVEXT' },
};

export const trainRoute = (code) => TRAIN_ROUTES[code] ?? null;

/** Every direction of the line a GTFS rail route (by short name) belongs to. */
export function trainDirectionsForGtfs(shortName) {
  const key = String(shortName || '').toUpperCase();
  return Object.keys(TRAIN_ROUTES).filter((code) => TRAIN_ROUTES[code].gtfs === key);
}

/** Hand-written metro names — the feed leaves route_long_name blank for all 4 (see AtacMetroLine.swift). */
export const METRO_NAMES = { MEA: 'Metro A', MEB: 'Metro B', MEB1: 'Metro B1', MEC: 'Metro C' };
export const metroName = (shortName) => METRO_NAMES[String(shortName || '').toUpperCase()] ?? null;

/** Weekday ids match Apple's Calendar (1 = Sunday … 7 = Saturday), shown Monday-first. */
export const WEEKDAYS_MONDAY_FIRST = [
  { id: 2, label: 'Lun' }, { id: 3, label: 'Mar' }, { id: 4, label: 'Mer' }, { id: 5, label: 'Gio' },
  { id: 6, label: 'Ven' }, { id: 7, label: 'Sab' }, { id: 1, label: 'Dom' },
];

export function weekdaysLabel(weekdays) {
  const set = new Set(weekdays);
  if (set.size === 7) return 'Tutti i giorni';
  return WEEKDAYS_MONDAY_FIRST.filter((d) => set.has(d.id)).map((d) => d.label).join(' · ');
}

/** Vehicle kind → marker/line colour (iOS system colours; see TransitVehicleAnnotationView / AtacPolyline). */
export function vehicleColor(vehicle) {
  switch (vehicle.operator) {
    case 'Cotral': return 'var(--orange)';
    case 'Roma TPL': return 'var(--green)';
    default:
      switch (vehicle.kind) {
        case 'metro': return 'var(--red)';
        case 'tram': return 'var(--orange)';
        case 'treno': return 'var(--purple)';
        default: return 'var(--teal)';
      }
  }
}

export function lineStrokeColor(kind, colorHex) {
  if (colorHex && /^[0-9a-fA-F]{6}$/.test(colorHex)) return '#' + colorHex;
  switch (kind) {
    case 'metro': return '#FF3B30';
    case 'tram': return '#FF9500';
    case 'treno': return '#AF52DE';
    default: return '#007AFF';
  }
}
