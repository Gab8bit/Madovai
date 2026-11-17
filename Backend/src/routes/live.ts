import type { FastifyInstance } from 'fastify';
import { route } from '../lib/routes.js';
import { BadRequest } from '../lib/errors.js';
import { CODE_PATTERN, isValidCode, transits, vehiclePosition } from '../live/cotral.js';
import { MAX_POLES, scanVehicles } from '../live/cotralScanner.js';
import { astralLine } from '../live/astral.js';
import { atacTrip, atacVehicles, STOP_LIMIT, stopArrivals } from '../live/atac.js';
import { TRAIN_ROUTE_CODES } from '../live/cotralTrainRoute.js';

/**
 * Live endpoints (Cotral PIV/Automezzi XML, ASTRAL JSON, Roma Mobilità GTFS-Realtime).
 * Same JSON as Madovai-Web's public/api/{cotral-transits,cotral-vehicle,cotral-vehicles,astral-line,atac-vehicles,
 * atac-live,atac-trip}.php; every route is also reachable at its legacy `.php` path.
 *
 * Response schemas declare every field: Fastify serializes (and filters) through them, and they feed /docs.
 */

// ---- shared schema fragments -------------------------------------------------------------------------------------

const str = { type: 'string' } as const;
const nstr = { type: ['string', 'null'] } as const;
const num = { type: 'number' } as const;
const nnum = { type: ['number', 'null'] } as const;
const int = { type: 'integer' } as const;
const nint = { type: ['integer', 'null'] } as const;
const bool = { type: 'boolean' } as const;
const errorResponse = { type: 'object', properties: { error: str }, required: ['error'] } as const;
const errors = { 400: errorResponse, 502: errorResponse } as const;

/** Comma-separated list of codes: the per-code rules are re-checked after split/trim/dedup (as in PHP). */
const codeList = (max: number, description: string) => ({
  type: 'string',
  pattern: '^[A-Za-z0-9_.:,\\s-]*$',
  maxLength: max * 80,
  description,
} as const);

const entrySchema = {
  type: 'object',
  description: 'Passaggio ASTRAL (Entry)',
  properties: {
    id: { type: 'string', description: 'Numero corsa (es. "RL2173")' },
    time: { type: 'string', description: '"HH:MM" programmato (ora di Roma; le ore possono superare 23 dopo mezzanotte)' },
    sortSeconds: { type: 'integer', description: 'Secondi dalla mezzanotte di Roma' },
    delayMinutes: { type: ['integer', 'null'], description: 'Ritardo in minuti (negativo = in anticipo), null se non ancora calcolato' },
    isCancelled: bool,
    isReplacementBus: { type: 'boolean', description: 'Corsa effettuata con bus sostitutivo' },
  },
  required: ['id', 'time', 'sortSeconds', 'delayMinutes', 'isCancelled', 'isReplacementBus'],
} as const;

const transitSchema = {
  type: 'object',
  description: 'Passaggio Cotral alla palina (campi di PIV.do, orari convertiti in "HH:MM")',
  properties: {
    idCorsa: str,
    percorso: { type: 'string', description: 'Codice percorso (es. "CF952A")' },
    partenzaCorsa: { type: 'string', description: 'Capolinea di partenza' },
    orarioPartenzaCorsa: { type: 'string', description: '"HH:MM" partenza dal capolinea (24h)' },
    arrivoCorsa: { type: 'string', description: 'Capolinea di arrivo' },
    orarioArrivoCorsa: { type: 'string', description: '"HH:MM" arrivo al capolinea (24h)' },
    soppressa: { type: 'string', description: '"Y" se soppressa, altrimenti "N"' },
    numeroOrdine: str,
    tempoTransito: { type: 'string', description: '"HH:MM" programmato di transito alla palina (24h)' },
    ritardoSeconds: { type: 'integer', description: 'Ritardo in secondi, non normalizzato (negativo = in anticipo)' },
    passato: str,
    vehicleCode: { type: ['string', 'null'], description: 'Codice del mezzo (es. "T393"), null se assente' },
    vehicleAlive: { type: 'boolean', description: 'Il mezzo sta trasmettendo la posizione' },
    testoFermata: str,
    instradamento: str,
    banchina: str,
    monitorata: { type: 'string', description: '"1" se la corsa è monitorata in tempo reale' },
    accessibile: str,
  },
  required: ['idCorsa', 'percorso', 'partenzaCorsa', 'orarioPartenzaCorsa', 'arrivoCorsa', 'orarioArrivoCorsa', 'soppressa',
    'numeroOrdine', 'tempoTransito', 'ritardoSeconds', 'passato', 'vehicleCode', 'vehicleAlive', 'testoFermata',
    'instradamento', 'banchina', 'monitorata', 'accessibile'],
} as const;

const poleSchema = {
  type: ['object', 'null'],
  description: 'Palina (null se Cotral non ha dati)',
  properties: {
    code: str, name: str, stopName: str, locality: str, comune: str,
    lat: num, lon: num,
  },
  required: ['code', 'name', 'stopName', 'locality', 'comune', 'lat', 'lon'],
} as const;

const kindSchema = { type: 'string', enum: ['bus', 'tram', 'metro', 'treno'] } as const;
const operatorSchema = { type: 'string', enum: ['Atac', 'Roma TPL', 'Cotral'] } as const;

/** "a, b,,a" → ["a","b"] (trim, drop empties, dedup: PHP array_unique keeps the first). */
const splitCodes = (raw: string | undefined) => [...new Set((raw ?? '').split(',').map((s) => s.trim()).filter((s) => s !== ''))];

// ---- routes ------------------------------------------------------------------------------------------------------

export default async function liveRoutes(app: FastifyInstance): Promise<void> {
  route(app, 'GET', { v1: '/cotral-transits', legacy: 'cotral-transits.php' }, {
    maxAge: 5,
    schema: {
      tags: ['live'],
      summary: 'Passaggi in tempo reale a una palina Cotral',
      description: 'Da PIV.do di Cotral (cache 8 s). Senza dati (palina sconosciuta o nessuna corsa) → `{"pole":null,"transits":[]}`.',
      querystring: {
        type: 'object',
        properties: { pole: { type: 'string', pattern: CODE_PATTERN, description: 'Codice palina Cotral (es. "1021")' } },
        required: ['pole'],
      },
      response: {
        200: {
          type: 'object',
          properties: { pole: poleSchema, transits: { type: 'array', items: transitSchema } },
          required: ['pole', 'transits'],
        },
        ...errors,
      },
    },
  }, async (req) => {
    const { pole } = req.query as { pole: string };
    return (await transits(pole)) ?? { pole: null, transits: [] };
  });

  route(app, 'GET', { v1: '/cotral-vehicle', legacy: 'cotral-vehicle.php' }, {
    maxAge: 3,
    schema: {
      tags: ['live'],
      summary: 'Ultima posizione di un mezzo Cotral',
      description: 'Da Automezzi.do (cache 5 s). `{"lat":null,"lon":null}` se il mezzo non ha una posizione valida.',
      querystring: {
        type: 'object',
        properties: { code: { type: 'string', pattern: CODE_PATTERN, description: 'Codice mezzo (vehicleCode di un passaggio)' } },
        required: ['code'],
      },
      response: {
        200: { type: 'object', properties: { lat: nnum, lon: nnum }, required: ['lat', 'lon'] },
        ...errors,
      },
    },
  }, async (req) => {
    const { code } = req.query as { code: string };
    return (await vehiclePosition(code)) ?? { lat: null, lon: null };
  });

  route(app, 'GET', { v1: '/cotral-vehicles', legacy: 'cotral-vehicles.php' }, {
    maxAge: 3,
    schema: {
      tags: ['live'],
      summary: 'Mezzi Cotral in movimento vicino a un gruppo di paline',
      description: `Per ogni palina (max ${MAX_POLES}) legge i passaggi, tiene i mezzi tracciabili (monitorata = "1" e vehicleCode) e ne `
        + 'recupera la posizione, in parallelo con un tempo massimo di ~10 s: le richieste fallite vengono saltate. Senza `poles` → lista vuota.',
      querystring: {
        type: 'object',
        properties: { poles: codeList(MAX_POLES, `Codici palina separati da virgola (max ${MAX_POLES})`) },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            vehicles: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: '"cotral-" + code' },
                  code: str,
                  lat: num,
                  lon: num,
                  routeId: { type: ['string', 'null'], description: 'percorso' },
                  routeLabel: nstr,
                  kind: { type: 'string', enum: ['bus', 'treno'] },
                  delaySeconds: { type: ['integer', 'null'], description: 'Solo se il ritardo è affidabile (monitorata e mezzo in trasmissione)' },
                  tripId: { type: ['string', 'null'], description: 'idCorsa' },
                },
                required: ['id', 'code', 'lat', 'lon', 'routeId', 'routeLabel', 'kind', 'delaySeconds', 'tripId'],
              },
            },
          },
          required: ['vehicles'],
        },
        ...errors,
      },
    },
  }, async (req) => {
    const poles = splitCodes((req.query as { poles?: string }).poles);
    if (poles.length > MAX_POLES) throw new BadRequest(`Troppe paline (max ${MAX_POLES})`);
    if (poles.some((p) => !isValidCode(p))) throw new BadRequest('Codice palina non valido');
    return { vehicles: poles.length === 0 ? [] : await scanVehicles(poles) };
  });

  route(app, 'GET', { v1: '/astral-line', legacy: 'astral-line.php' }, {
    maxAge: 10,
    schema: {
      tags: ['live'],
      summary: 'Prossimo treno a ogni stazione di una linea ferroviaria Cotral (ASTRAL)',
      description: 'Per ogni stazione della direzione, il primo passaggio non ancora passato (ora di Roma); `next:null` se la '
        + 'richiesta per quella stazione fallisce o non ci sono altri treni oggi. Cache 20 s.',
      querystring: {
        type: 'object',
        properties: { route: { type: 'string', enum: TRAIN_ROUTE_CODES, description: 'Codice direzione ASTRAL' } },
        required: ['route'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            route: str,
            directionLabel: { type: 'string', description: 'Es. "Porta San Paolo → Cristoforo Colombo"' },
            lineName: { type: 'string', description: 'Es. "Metromare"' },
            stations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: str,
                  code: { type: 'string', description: 'Codice fermata ASTRAL' },
                  order: { type: 'integer', description: 'Posizione lungo la linea' },
                  next: { ...entrySchema, type: ['object', 'null'] },
                },
                required: ['name', 'code', 'order', 'next'],
              },
            },
          },
          required: ['route', 'directionLabel', 'lineName', 'stations'],
        },
        ...errors,
      },
    },
  }, async (req) => astralLine((req.query as { route: string }).route));

  route(app, 'GET', { v1: '/atac-vehicles', legacy: 'atac-vehicles.php' }, {
    maxAge: 5,
    schema: {
      tags: ['live'],
      summary: 'Posizioni in tempo reale dei mezzi Atac / Roma TPL',
      description: 'Da GTFS-Realtime vehicle_positions di Roma Mobilità (cache 12 s), arricchite con linea, tipo, operatore e '
        + 'destinazione dal GTFS statico (se non ancora pronto: id grezzi, kind "bus", operator "Atac", headsign null).',
      response: {
        200: {
          type: 'object',
          properties: {
            updated: { type: 'integer', description: 'Timestamp del feed (secondi unix)' },
            vehicles: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: '"atac-" + id veicolo' },
                  lat: num,
                  lon: num,
                  bearing: { type: ['number', 'null'], description: 'Gradi, null se assente' },
                  routeId: nstr,
                  routeLabel: { type: ['string', 'null'], description: 'short_name della linea (fallback routeId)' },
                  kind: kindSchema,
                  operator: operatorSchema,
                  tripId: nstr,
                  headsign: { type: ['string', 'null'], description: 'Destinazione della corsa (GTFS statico)' },
                },
                required: ['id', 'lat', 'lon', 'bearing', 'routeId', 'routeLabel', 'kind', 'operator', 'tripId', 'headsign'],
              },
            },
          },
          required: ['updated', 'vehicles'],
        },
        502: errorResponse,
      },
    },
  }, async () => atacVehicles());

  route(app, 'GET', { v1: '/atac-live', legacy: 'atac-live.php' }, {
    maxAge: 5,
    schema: {
      tags: ['live'],
      summary: 'Arrivi in tempo reale alle fermate Atac / Roma TPL',
      description: `Da GTFS-Realtime trip_updates (cache 12 s): per ogni fermata richiesta (max ${STOP_LIMIT}) gli arrivi con ts > adesso−120 s, `
        + 'ordinati per ts. Ogni fermata richiesta compare come chiave, anche con lista vuota.',
      querystring: {
        type: 'object',
        properties: { stops: codeList(STOP_LIMIT, `stop_id separati da virgola (max ${STOP_LIMIT})`) },
        required: ['stops'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            updated: { type: 'integer', description: 'Timestamp del feed (secondi unix)' },
            stops: {
              type: 'object',
              description: 'stop_id → arrivi',
              additionalProperties: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    tripId: str,
                    routeId: str,
                    routeLabel: str,
                    kind: kindSchema,
                    ts: { type: 'integer', description: 'Arrivo previsto (secondi unix)' },
                    delaySeconds: nint,
                    headsign: nstr,
                    cancelled: { type: 'boolean', description: 'Corsa cancellata o fermata saltata' },
                  },
                  required: ['tripId', 'routeId', 'routeLabel', 'kind', 'ts', 'delaySeconds', 'headsign', 'cancelled'],
                },
              },
            },
          },
          required: ['updated', 'stops'],
        },
        ...errors,
      },
    },
  }, async (req) => {
    const stops = splitCodes((req.query as { stops?: string }).stops);
    if (stops.length === 0) throw new BadRequest('Parametro stops mancante');
    if (stops.length > STOP_LIMIT) throw new BadRequest(`Troppe fermate (max ${STOP_LIMIT})`);
    if (stops.some((s) => !isValidCode(s))) throw new BadRequest('ID fermata non valido');
    return stopArrivals(stops);
  });

  route(app, 'GET', { v1: '/atac-trip', legacy: 'atac-trip.php' }, {
    maxAge: 5,
    schema: {
      tags: ['live'],
      summary: 'Fermate di una corsa Atac / Roma TPL con orari in tempo reale',
      description: 'Tutte le fermate della corsa (passate e future) ordinate per sequence; `stops:[]` se la corsa non è nel feed. '
        + 'I trip id contengono "#" (es. `0#1640-11`): codificarli con encodeURIComponent.',
      querystring: {
        type: 'object',
        properties: { trip: { type: 'string', pattern: '^[A-Za-z0-9_.:#-]{1,64}$', description: 'trip_id GTFS' } },
        required: ['trip'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            tripId: str,
            routeId: nstr,
            routeLabel: nstr,
            headsign: nstr,
            stops: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  stopId: str,
                  stopName: { type: 'string', description: 'Nome dal GTFS statico (fallback stopId)' },
                  sequence: int,
                  ts: { type: 'integer', description: 'Arrivo/partenza prevista (secondi unix)' },
                  delaySeconds: nint,
                },
                required: ['stopId', 'stopName', 'sequence', 'ts', 'delaySeconds'],
              },
            },
          },
          required: ['tripId', 'routeId', 'routeLabel', 'headsign', 'stops'],
        },
        ...errors,
      },
    },
  }, async (req) => atacTrip((req.query as { trip: string }).trip));
}
