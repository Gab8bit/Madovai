import type { FastifyInstance, FastifyRequest } from 'fastify';
import { route } from '../lib/routes.js';
import { BadRequest } from '../lib/errors.js';
import { Store } from '../gtfs/store.js';
import { railDepartures, type AstralDeparturesFn } from '../gtfs/rail.js';

/**
 * Static endpoints backed by madovai.sqlite (GTFS Cotral bus + rail, Atac/Roma TPL). Same JSON, same validation,
 * same Cache-Control as Madovai-Web's public/api/{stops,search,lines,line,shapes,atac-stop,atac-schedule,pole,rail}.php;
 * every route is also reachable at its legacy `.php` path. 503 while the database is being built for the first time.
 *
 * Response schemas declare every field: Fastify serializes (and filters) through them, and they feed /docs.
 */

// ---- schema fragments --------------------------------------------------------------------------------------------

const str = { type: 'string' } as const;
const nstr = { type: ['string', 'null'] } as const;
const num = { type: 'number' } as const;
const bool = { type: 'boolean' } as const;
const kind = { type: 'string', enum: ['bus', 'tram', 'metro', 'treno'], description: 'Tipo di mezzo (GTFS route_type 3/0/1/2)' } as const;
const bbox = {
  type: 'array', items: num, minItems: 4, maxItems: 4,
  description: 'Riquadro [minLat, minLon, maxLat, maxLon]',
} as const;
const polyline = { type: 'string', description: 'Encoded Polyline Algorithm (Google), precisione 5' } as const;
const errorResponse = { type: 'object', properties: { error: str }, required: ['error'] } as const;
const errors = { 400: errorResponse, 503: errorResponse } as const;

const routeSchema = {
  type: 'object',
  description: 'Linea (Cotral treno: id "F:"+route_id; Cotral bus e Atac: route_id GTFS grezzo)',
  properties: {
    source: { type: 'string', enum: ['cotral', 'atac'] },
    id: str,
    shortName: str,
    longName: { type: 'string', description: 'Nome lungo (Cotral: senza il suffisso " # CODICE")' },
    displayName: { type: 'string', description: '"Metro A/B/B1/C" per MEA/MEB/MEB1/MEC; Atac: longName o shortName; Cotral: shortName' },
    kind,
    operator: { type: 'string', enum: ['Cotral', 'Atac', 'Roma TPL'] },
    color: { type: ['string', 'null'], description: 'Colore esadecimale senza "#" (solo Atac, se presente)' },
    rail: { type: 'boolean', description: 'true per le linee ferroviarie Cotral' },
  },
  required: ['source', 'id', 'shortName', 'longName', 'displayName', 'kind', 'operator', 'color', 'rail'],
} as const;

const stopWithHeadsign = {
  type: 'object',
  properties: {
    id: str, name: str, lat: num, lon: num,
    headsign: { type: ['string', 'null'], description: 'Destinazione (capitalizzata) delle corse che passano di qui' },
  },
  required: ['id', 'name', 'lat', 'lon', 'headsign'],
} as const;

const shapeSchema = {
  type: 'object',
  properties: { id: { type: 'string', description: 'shape_id GTFS' }, coords: polyline, bbox },
  required: ['id', 'coords', 'bbox'],
} as const;

const entrySchema = {
  type: 'object',
  description: 'Passaggio ferroviario (Entry)',
  properties: {
    id: { type: 'string', description: 'Numero corsa ASTRAL (es. "RL2173") o trip_id GTFS' },
    time: { type: 'string', description: '"HH:MM" (ora di Roma)' },
    sortSeconds: { type: 'integer', description: 'Secondi dalla mezzanotte di Roma (ordinamento)' },
    delayMinutes: { type: ['integer', 'null'], description: 'Ritardo in minuti; sempre null per la fonte gtfs' },
    isCancelled: bool,
    isReplacementBus: { type: 'boolean', description: 'Corsa effettuata con bus sostitutivo' },
  },
  required: ['id', 'time', 'sortSeconds', 'delayMinutes', 'isCancelled', 'isReplacementBus'],
} as const;

// ---- query-string helpers (same rules and messages as Madovai-Web's Gtfs\Input) ----------------------------------

const coord = (description: string) => ({ type: 'number', description } as const);
const bboxQuery = {
  minLat: coord('Latitudine minima'),
  minLon: coord('Longitudine minima'),
  maxLat: coord('Latitudine massima'),
  maxLon: coord('Longitudine massima'),
} as const;

type Query = Record<string, unknown>;
const q = (req: FastifyRequest) => req.query as Query;

/** PHP Input::float: finite number. */
function float(query: Query, name: string): number {
  const v = query[name];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new BadRequest(`Parametro '${name}' non valido`);
  return v;
}

/** PHP Input::bbox */
function readBbox(query: Query): [number, number, number, number] {
  const b: [number, number, number, number] = [float(query, 'minLat'), float(query, 'minLon'), float(query, 'maxLat'), float(query, 'maxLon')];
  if (b[0] > b[2] || b[1] > b[3]) throw new BadRequest('Riquadro non valido');
  return b;
}

/** PHP Input::int: optional, clamped into [min, max] (out-of-range values are limited, not rejected). */
function intParam(query: Query, name: string, def: number, min: number, max: number): number {
  const v = query[name];
  if (v === undefined) return def;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new BadRequest(`Parametro '${name}' non valido`);
  return Math.max(min, Math.min(max, v));
}

/** PHP Input::string: required, trimmed, non-empty, at most `maxLen` bytes. */
function strParam(query: Query, name: string, maxLen: number): string {
  const v = query[name];
  if (typeof v !== 'string') throw new BadRequest(`Parametro '${name}' mancante`);
  const t = v.trim();
  if (t === '' || Buffer.byteLength(t) > maxLen) throw new BadRequest(`Parametro '${name}' non valido`);
  return t;
}

function optStrParam(query: Query, name: string, maxLen: number): string | null {
  const v = query[name];
  return v === undefined || v === '' ? null : strParam(query, name, maxLen);
}

/** PHP treats `?x=` like a missing parameter for OPTIONAL values: drop those before validation so defaults apply. */
const OPTIONAL_PARAMS = ['cotralLimit', 'atacLimit', 'limit', 'route', 'q'];
async function dropEmptyOptionalParams(req: FastifyRequest): Promise<void> {
  const query = req.query as Record<string, unknown> | undefined;
  if (!query) return;
  for (const k of OPTIONAL_PARAMS) if (query[k] === '') delete query[k];
}

/**
 * Schema validation errors with Gtfs\Input's messages ("Parametro 'x' mancante" for an absent string,
 * "Parametro 'x' non valido" otherwise): an HttpError, so the app error handler returns it verbatim.
 */
function phpErrorFormatter(errors: Array<{ keyword: string; instancePath: string; params: Record<string, unknown> }>, _dataVar: string): Error {
  const e = errors[0];
  if (e?.keyword === 'required') {
    const name = String(e.params.missingProperty ?? '');
    const isString = !['minLat', 'minLon', 'maxLat', 'maxLon'].includes(name);
    return new BadRequest(`Parametro '${name}' ${isString ? 'mancante' : 'non valido'}`);
  }
  const name = (e?.instancePath ?? '').replace(/^\//, '');
  return new BadRequest(name ? `Parametro '${name}' non valido` : 'Parametri non validi');
}

// ---- ASTRAL (live module), loaded lazily: /rail falls back to the GTFS timetable if it is unavailable --------------

let astralFn: AstralDeparturesFn | null = null;
async function loadAstral(): Promise<AstralDeparturesFn | null> {
  if (astralFn) return astralFn;
  try {
    const mod = await import('../live/astral.js');
    if (typeof mod.astralDepartures === 'function') astralFn = mod.astralDepartures;
  } catch {
    // live module missing or broken: GTFS tier only
  }
  return astralFn;
}

// ---- routes ------------------------------------------------------------------------------------------------------

export default async function staticRoutes(app: FastifyInstance): Promise<void> {
  const common = { preValidation: dropEmptyOptionalParams, schemaErrorFormatter: phpErrorFormatter };

  // Errors are never cacheable (PHP's Json::out sent no-store with every error).
  app.addHook('onSend', async (_req, reply, payload) => {
    if (reply.statusCode >= 400 && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  route(app, 'GET', { v1: '/stops', legacy: 'stops.php' }, {
    ...common,
    maxAge: 30,
    schema: {
      tags: ['static'],
      summary: 'Fermate nel riquadro',
      description: 'Fermate Cotral (bus + stazioni) e Atac dentro il riquadro, ordinate per vicinanza al centro del riquadro (distanza equirettangolare), poi per id.',
      querystring: {
        type: 'object',
        properties: {
          ...bboxQuery,
          cotralLimit: { type: 'integer', default: 150, description: 'Max fermate Cotral (valori fuori da 1–500 vengono limitati)' },
          atacLimit: { type: 'integer', default: 400, description: 'Max fermate Atac (valori fuori da 1–1000 vengono limitati)' },
        },
        required: ['minLat', 'minLon', 'maxLat', 'maxLon'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            cotral: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'stop_id GTFS (es. "1021", "RL_ACILIA")' },
                  name: { type: 'string', description: 'Nome senza il suffisso " # codice"' },
                  locality: { type: 'string', description: 'Parte del nome prima di | ! (' },
                  lat: num, lon: num,
                  rail: { type: 'boolean', description: 'Stazione ferroviaria Cotral' },
                },
                required: ['id', 'name', 'locality', 'lat', 'lon', 'rail'],
              },
            },
            atac: {
              type: 'array',
              items: { type: 'object', properties: { id: str, name: str, lat: num, lon: num }, required: ['id', 'name', 'lat', 'lon'] },
            },
          },
          required: ['cotral', 'atac'],
        },
        ...errors,
      },
    },
  }, async (req) => {
    const query = q(req);
    const [minLat, minLon, maxLat, maxLon] = readBbox(query);
    const cotralLimit = intParam(query, 'cotralLimit', 150, 1, 500);
    const atacLimit = intParam(query, 'atacLimit', 400, 1, 1000);
    return Store.open().stopsInBox(minLat, minLon, maxLat, maxLon, cotralLimit, atacLimit);
  });

  route(app, 'GET', { v1: '/search', legacy: 'search.php' }, {
    ...common,
    maxAge: 60,
    schema: {
      tags: ['static'],
      summary: 'Ricerca fermate e linee',
      description: 'Ricerca per parole (primi 100 caratteri): senza distinzione di maiuscole/minuscole e accenti, punteggiatura ignorata, '
        + 'spazi multipli compressi; un risultato deve contenere tutte le parole, in qualsiasi ordine ("roma termini", "anagnina metro"). '
        + 'Fermate: max 15 Cotral + max 15 Atac, match sul nome. Linee: max 10 Cotral + max 10 Atac, match su shortName, longName o '
        + 'displayName ("Metro A"). Ordine (fermate e linee, Cotral e Atac insieme): nome identico alla ricerca, poi nome che inizia con la '
        + 'ricerca, poi tutte le parole all\'inizio di una parola del nome, poi il resto; a parità il nome più corto, poi Cotral prima di Atac '
        + '(e a seguire: fermate in ordine di file, linee per shortName). '
        + 'q vuota o di sola punteggiatura → liste vuote.',
      querystring: {
        type: 'object',
        properties: { q: { type: 'string', description: 'Testo da cercare' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            stops: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  source: { type: 'string', enum: ['cotral', 'atac'] },
                  id: str, name: str, lat: num, lon: num,
                  rail: { type: 'boolean', description: 'Stazione ferroviaria Cotral (sempre false per Atac)' },
                  metro: { type: 'boolean', description: 'Solo fermate Atac: servita da una linea metro (MEA/MEB/MEB1/MEC)' },
                },
                required: ['source', 'id', 'name', 'lat', 'lon', 'rail'],
              },
            },
            routes: { type: 'array', items: routeSchema },
          },
          required: ['stops', 'routes'],
        },
        ...errors,
      },
    },
  }, async (req) => {
    const v = q(req).q;
    return Store.open().search(typeof v === 'string' ? v : '');
  });

  route(app, 'GET', { v1: '/lines', legacy: 'lines.php' }, {
    ...common,
    maxAge: 3600,
    schema: {
      tags: ['static'],
      summary: 'Elenco linee Atac e treni Cotral',
      description: 'Tutte le linee Atac/Roma TPL e le linee ferroviarie Cotral, ordinate per shortName.',
      response: {
        200: {
          type: 'object',
          properties: {
            atac: { type: 'array', items: routeSchema },
            cotralRail: { type: 'array', items: routeSchema },
          },
          required: ['atac', 'cotralRail'],
        },
        503: errorResponse,
      },
    },
  }, async () => Store.open().lines());

  route(app, 'GET', { v1: '/line', legacy: 'line.php' }, {
    ...common,
    maxAge: 3600,
    schema: {
      tags: ['static'],
      summary: 'Dettaglio linea: fermate e percorsi',
      description: 'Atac e Cotral bus: tutte le fermate servite dalla linea in ordine di percorso (prima la direzione 0 secondo la sua '
        + 'corsa rappresentativa, poi le fermate delle altre direzioni, poi quelle di diramazioni e varianti accanto alla fermata più vicina '
        + 'in sequenza), con la destinazione per quella fermata (solo Atac), le shape (solo Atac) e `directions`: la sequenza di ogni '
        + 'direzione. Cotral treno ("F:…"): stazioni in ordine di linea (corsa più lunga) e shape, senza `directions`. Linea inesistente → 400.',
      querystring: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['atac', 'cotral'], description: 'Fonte della linea' },
          id: { type: 'string', maxLength: 64, description: 'Id linea (Atac: route_id; Cotral treno: "F:"+route_id, es. "F:ROMALIDO")' },
        },
        required: ['source', 'id'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            route: routeSchema,
            stops: { type: 'array', items: stopWithHeadsign, description: 'Fermate in ordine di percorso, ciascuna una sola volta' },
            shapes: { type: 'array', items: shapeSchema },
            directions: {
              type: 'array',
              description: 'Facoltativo (Atac e Cotral bus). Per ogni direction_id GTFS la corsa rappresentativa (quella con più fermate; '
                + 'a parità quella con la shape più frequente): le sue fermate in ordine di sequenza.',
              items: {
                type: 'object',
                properties: {
                  directionId: { type: 'integer', description: 'direction_id GTFS (0 o 1)' },
                  headsign: { type: ['string', 'null'], description: 'Destinazione della corsa rappresentativa (solo Atac)' },
                  stopIds: { type: 'array', items: str, description: 'Id delle fermate in ordine di sequenza (tutti presenti in `stops`)' },
                },
                required: ['directionId', 'headsign', 'stopIds'],
              },
            },
          },
          required: ['route', 'stops', 'shapes'],
        },
        ...errors,
      },
    },
  }, async (req) => {
    const query = q(req);
    const source = strParam(query, 'source', 16);
    const id = strParam(query, 'id', 64);
    return Store.open().line(source, id);
  });

  route(app, 'GET', { v1: '/shapes', legacy: 'shapes.php' }, {
    ...common,
    maxAge: 300,
    schema: {
      tags: ['static'],
      summary: 'Percorsi Atac nel riquadro',
      description: 'Shape Atac (una per coppia linea/shape) il cui riquadro interseca quello richiesto, per il livello "linee" della mappa.',
      querystring: {
        type: 'object',
        properties: {
          ...bboxQuery,
          limit: { type: 'integer', default: 150, description: 'Max shape (valori fuori da 1–500 vengono limitati)' },
        },
        required: ['minLat', 'minLon', 'maxLat', 'maxLon'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            shapes: {
              type: 'array',
              items: {
                type: 'object',
                properties: { id: { type: 'string', description: 'shape_id GTFS' }, routeId: str, kind, color: nstr, coords: polyline, bbox },
                required: ['id', 'routeId', 'kind', 'color', 'coords', 'bbox'],
              },
            },
          },
          required: ['shapes'],
        },
        ...errors,
      },
    },
  }, async (req) => {
    const query = q(req);
    const [minLat, minLon, maxLat, maxLon] = readBbox(query);
    const limit = intParam(query, 'limit', 150, 1, 500);
    return { shapes: Store.open().shapesInBox(minLat, minLon, maxLat, maxLon, limit) };
  });

  route(app, 'GET', { v1: '/atac-stop', legacy: 'atac-stop.php' }, {
    ...common,
    maxAge: 3600,
    schema: {
      tags: ['static'],
      summary: 'Fermata Atac e piattaforme con lo stesso nome',
      description: 'Tutte le piattaforme con lo stesso nome della fermata, ordinate per stop_id. headsign: con `route` quello della linea, '
        + 'altrimenti uno qualsiasi della piattaforma. Fermata inesistente → 400.',
      querystring: {
        type: 'object',
        properties: {
          id: { type: 'string', maxLength: 64, description: 'stop_id Atac (es. "70180")' },
          route: { type: 'string', maxLength: 64, description: 'route_id Atac opzionale per la destinazione' },
        },
        required: ['id'],
      },
      response: {
        200: {
          type: 'object',
          properties: { name: str, stops: { type: 'array', items: stopWithHeadsign } },
          required: ['name', 'stops'],
        },
        ...errors,
      },
    },
  }, async (req) => {
    const query = q(req);
    return Store.open().atacStopGroup(strParam(query, 'id', 64), optStrParam(query, 'route', 64));
  });

  route(app, 'GET', { v1: '/atac-schedule', legacy: 'atac-schedule.php' }, {
    ...common,
    maxAge: 30,
    schema: {
      tags: ['static'],
      summary: 'Orari programmati Atac (fallback)',
      description: 'Prossime 6 partenze programmate dalla fermata oggi (servizi attivi nella data di Roma, partenza ≥ adesso), '
        + 'per quando il tempo reale non risponde. Le corse notturne ancora sul servizio di ieri non sono incluse.',
      querystring: {
        type: 'object',
        properties: { stop: { type: 'string', maxLength: 64, description: 'stop_id Atac' } },
        required: ['stop'],
      },
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tripId: { type: 'string', description: 'trip_id Atac (può contenere "#")' },
              routeId: str,
              routeLabel: { type: 'string', description: 'short_name della linea (fallback routeId)' },
              kind,
              ts: { type: 'integer', description: 'Orario programmato, secondi unix' },
              headsign: nstr,
            },
            required: ['tripId', 'routeId', 'routeLabel', 'kind', 'ts', 'headsign'],
          },
        },
        ...errors,
      },
    },
  }, async (req) => Store.open().atacScheduled(strParam(q(req), 'stop', 64)));

  route(app, 'GET', { v1: '/pole', legacy: 'pole.php' }, {
    ...common,
    maxAge: 3600,
    schema: {
      tags: ['static'],
      summary: 'Palina Cotral (dati statici)',
      description: 'Fermata/stazione Cotral con i codici ASTRAL candidati delle direzioni ferroviarie che la servono '
        + '(ROMALIDO → RL_CC-PSP, RL_PSP-CC; RVURB → RN_RMMON, RN_MONRM; RVEXT → RV_CATVIT, RV_VITCAT, RV_MORCAT, RV_CATMOR; [] per i bus). '
        + 'Palina inesistente → 400.',
      querystring: {
        type: 'object',
        properties: { id: { type: 'string', maxLength: 64, description: 'stop_id Cotral (es. "1021", "RL_ACILIA")' } },
        required: ['id'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: str, name: str, locality: str, lat: num, lon: num,
            rail: { type: 'boolean', description: 'Stazione ferroviaria' },
            trainRoutes: { type: 'array', items: str, description: 'Codici direzione ASTRAL candidati' },
          },
          required: ['id', 'name', 'locality', 'lat', 'lon', 'rail', 'trainRoutes'],
        },
        ...errors,
      },
    },
  }, async (req) => {
    const pole = Store.open().pole(strParam(q(req), 'id', 64));
    if (pole === null) throw new BadRequest('Palina inesistente');
    return pole;
  });

  route(app, 'GET', { v1: '/rail', legacy: 'rail.php' }, {
    ...common,
    schema: {
      tags: ['static'],
      summary: 'Partenze ferroviarie della giornata da una stazione Cotral',
      description: 'Per ogni direzione candidata della stazione prova ASTRAL (tempo reale); se nessuna risponde usa l\'orario '
        + 'GTFS programmato raggruppato per destinazione (`route` null, `delayMinutes` null). Entries = giornata intera ordinate '
        + 'per sortSeconds (il client filtra le prossime); directions ordinate per destinazione. Stazione inesistente → 400.',
      querystring: {
        type: 'object',
        properties: { stop: { type: 'string', maxLength: 64, description: 'stop_id Cotral della stazione (es. "RL_ACILIA")' } },
        required: ['stop'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            source: { type: 'string', enum: ['astral', 'gtfs', 'none'], description: 'Fonte dei dati' },
            directions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  destination: str,
                  route: { type: ['string', 'null'], description: 'Codice direzione ASTRAL (es. "RL_PSP-CC"), null per la fonte gtfs' },
                  entries: { type: 'array', items: entrySchema },
                },
                required: ['destination', 'route', 'entries'],
              },
            },
          },
          required: ['source', 'directions'],
        },
        ...errors,
      },
    },
  }, async (req) => {
    const stop = strParam(q(req), 'stop', 64);
    const store = Store.open();
    return railDepartures(store, stop, await loadAstral());
  });
}
