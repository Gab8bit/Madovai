import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { BadRequest } from '../lib/errors.js';
import { route } from '../lib/routes.js';
import type { Device } from '../types.js';
import { testPayload } from '../push/notifier.js';
import { assertDeviceSupported, pushConfig, send } from '../push/send.js';
import { getStore, ReminderStore } from '../push/store.js';
import { MAX_REMINDERS, TRAIN_ROUTES, validateDevice, validateReminders } from '../push/validation.js';
import { vapidKeys } from '../push/vapid.js';

/**
 * Push module: devices, reminders, test notification. Port of Madovai-Web's push-key.php / reminders.php /
 * push-test.php (legacy aliases kept with the exact PHP request/response shapes), generalised to 3 device types.
 *
 * Request bodies are validated by src/push/validation.ts (a literal port of Validator.php: same strictness — e.g.
 * "7" is NOT an hour — and the same Italian messages), so Fastify's own (type-coercing) validation is switched off
 * for these routes; the JSON schemas below document the contract for OpenAPI and filter the responses.
 */

const TEST_INTERVAL_SECONDS = 30;

// ---------------------------------------------------------------- schemas (OpenAPI)

const errorSchema = {
  type: 'object',
  properties: { error: { type: 'string', description: 'Messaggio in italiano, mostrabile all\'utente' } },
  required: ['error'],
} as const;

const webPushSubscription = {
  type: 'object',
  description: 'PushSubscription.toJSON() del browser. Endpoint https su porta 443, host DNS pubblico (no IP/localhost), ≤ 600 caratteri.',
  properties: {
    endpoint: { type: 'string', format: 'uri', maxLength: 600, examples: ['https://fcm.googleapis.com/fcm/send/eABC…'] },
    keys: {
      type: 'object',
      properties: {
        p256dh: { type: 'string', description: 'base64url senza padding: punto P-256 non compresso (65 byte)' },
        auth: { type: 'string', description: 'base64url senza padding: 16 byte' },
      },
      required: ['p256dh', 'auth'],
    },
  },
  required: ['endpoint', 'keys'],
} as const;

const deviceSchema = {
  description: 'Dispositivo che riceve le notifiche. L\'identità è endpoint (webpush) o token (fcm/apns): reinviare lo stesso device aggiorna quello esistente.',
  oneOf: [
    {
      type: 'object', title: 'webpush',
      properties: { type: { const: 'webpush' }, subscription: webPushSubscription },
      required: ['type', 'subscription'],
    },
    {
      type: 'object', title: 'fcm',
      description: 'Android: registration token di Firebase Cloud Messaging.',
      properties: { type: { const: 'fcm' }, token: { type: 'string', pattern: '^[A-Za-z0-9_:-]{100,4096}$' } },
      required: ['type', 'token'],
    },
    {
      type: 'object', title: 'apns',
      description: 'iOS: device token APNs (32 byte in esadecimale). environment = sandbox per le build di sviluppo (Xcode), production per TestFlight/App Store; se omesso vale il default del server (APNS_PRODUCTION).',
      properties: {
        type: { const: 'apns' },
        token: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
        environment: { type: 'string', enum: ['sandbox', 'production'] },
      },
      required: ['type', 'token'],
    },
  ],
} as const;

const reminderSchema = {
  type: 'object',
  description: 'Promemoria: al minuto previsto (ora di Roma) il server controlla il prossimo passaggio e invia subito la notifica.',
  properties: {
    id: { type: 'string', pattern: '^[A-Za-z0-9-]{1,64}$', description: 'Univoco nella lista (es. UUID)' },
    stopName: { type: 'string', minLength: 1, maxLength: 120, description: 'Nome mostrato nel testo della notifica' },
    weekdays: {
      type: 'array', minItems: 1, maxItems: 14,
      items: { type: 'integer', minimum: 1, maximum: 7 },
      description: '1 = domenica … 7 = sabato (convenzione Calendar di Apple); duplicati rimossi',
    },
    hour: { type: 'integer', minimum: 0, maximum: 23 },
    minute: { type: 'integer', minimum: 0, maximum: 59 },
    source: {
      description: 'Da dove leggere il prossimo passaggio',
      oneOf: [
        { type: 'object', title: 'cotralBus', properties: { type: { const: 'cotralBus' }, poleCode: { type: 'string', maxLength: 64 } }, required: ['type', 'poleCode'] },
        {
          type: 'object', title: 'cotralTrain',
          properties: { type: { const: 'cotralTrain' }, stationName: { type: 'string', maxLength: 64 }, route: { type: 'string', enum: [...TRAIN_ROUTES] } },
          required: ['type', 'stationName', 'route'],
        },
        { type: 'object', title: 'atacStop', properties: { type: { const: 'atacStop' }, stopId: { type: 'string', maxLength: 64 } }, required: ['type', 'stopId'] },
      ],
    },
  },
  required: ['id', 'stopName', 'weekdays', 'hour', 'minute', 'source'],
  examples: [{ id: '3F2504E0-4F89-41D3-9A0C-0305E82C3301', stopName: 'Acilia', weekdays: [2, 3, 4], hour: 7, minute: 30, source: { type: 'cotralBus', poleCode: '1021' } }],
} as const;

const okSchema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } as const;

const testResultSchema = {
  type: 'object',
  description: 'Esito della consegna al servizio push. ok=false con gone=true: il dispositivo non è più valido ed è stato cancellato (riattivare le notifiche).',
  properties: {
    ok: { type: 'boolean' },
    gone: { type: 'boolean' },
    status: { type: 'integer', description: 'Stato HTTP del servizio push (0 = errore di rete/timeout)' },
    error: { type: 'string' },
  },
  required: ['ok', 'status'],
} as const;

/** Bodies are validated in code (validation.ts); Fastify's validator would coerce "7" into 7. */
const noFastifyValidation = () => () => true;

// ---------------------------------------------------------------- helpers

function bodyObject(req: FastifyRequest): Record<string, unknown> {
  const b = req.body;
  if (typeof b !== 'object' || b === null) throw new BadRequest('Corpo JSON non valido');
  return b as Record<string, unknown>;
}

const isLegacy = (req: FastifyRequest) => (req.routeOptions.url ?? '').endsWith('.php');

/** v1 bodies carry `device`; the legacy PHP endpoints carry a Web Push `subscription`. */
function deviceFrom(req: FastifyRequest, body: Record<string, unknown>, needKeys = true): Device {
  return isLegacy(req)
    ? validateDevice({ type: 'webpush', subscription: body.subscription }, needKeys)
    : validateDevice(body.device, needKeys);
}

// ---------------------------------------------------------------- routes

export default async function pushRoutes(app: FastifyInstance): Promise<void> {
  // Malformed / oversized JSON bodies: the PHP status and message instead of Fastify's English ones
  // (every other error goes on to the app-wide handler).
  app.setErrorHandler((err, _req, reply) => {
    const code = (err as { code?: string }).code;
    if (code === 'FST_ERR_CTP_INVALID_JSON_BODY' || code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      return reply.status(400).send({ error: 'Corpo JSON non valido' });
    }
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.status(400).send({ error: 'Richiesta troppo grande' });
    throw err;
  });

  route(app, 'GET', { v1: '/push/config' }, {
    maxAge: 300,
    schema: {
      tags: ['push'],
      summary: 'Canali di notifica disponibili',
      description: 'Quali tipi di dispositivo questo server può raggiungere. `webPush.publicKey` è la applicationServerKey (VAPID) da passare a `pushManager.subscribe()`; `null` se il Web Push non è disponibile. FCM e APNs sono attivi solo se il server ha le credenziali.',
      response: {
        200: {
          type: 'object',
          properties: {
            webPush: { type: ['object', 'null'], properties: { publicKey: { type: 'string', description: 'base64url, punto P-256 non compresso (65 byte)' } }, required: ['publicKey'] },
            fcm: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] },
            apns: { type: 'object', properties: { enabled: { type: 'boolean' }, topic: { type: ['string', 'null'], description: 'Bundle id dell\'app iOS' } }, required: ['enabled', 'topic'] },
          },
          required: ['webPush', 'fcm', 'apns'],
        },
      },
    },
  }, async () => pushConfig());

  // Legacy: exactly the PHP shape ({"publicKey"} or 503), cached for an hour like push-key.php.
  app.route({
    method: 'GET',
    url: '/api/push-key.php',
    schema: { hide: true, response: { 200: { type: 'object', properties: { publicKey: { type: 'string' } }, required: ['publicKey'] }, 503: errorSchema } },
    handler: async (_req: FastifyRequest, reply: FastifyReply) => {
      const { publicKey } = vapidKeys();
      reply.header('Cache-Control', 'public, max-age=3600');
      return { publicKey };
    },
  });

  route(app, 'POST', { v1: '/reminders', legacy: 'reminders.php' }, {
    validatorCompiler: noFastifyValidation,
    schema: {
      tags: ['push'],
      summary: 'Registra un dispositivo e sostituisce tutti i suoi promemoria',
      description: `Il client è la fonte di verità: la lista inviata **sostituisce** quella salvata (lista vuota = nessun promemoria, il dispositivo resta registrato). Max ${MAX_REMINDERS} promemoria. Un promemoria con id e orario/giorni/sorgente invariati conserva lo stato (già eseguito oggi / tentativi); uno nuovo o modificato il cui orario di oggi è già passato non scatta retroattivamente. 503 se il tipo di dispositivo non è configurato sul server o se il server ha già 5000 dispositivi. Alias legacy \`reminders.php\`: body con \`subscription\` (Web Push) al posto di \`device\`; \`?action=unsubscribe\` cancella sottoscrizione e promemoria.`,
      body: {
        type: 'object',
        properties: { device: deviceSchema, reminders: { type: 'array', maxItems: MAX_REMINDERS, items: reminderSchema } },
        required: ['device', 'reminders'],
      },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' }, count: { type: 'integer', description: 'Promemoria salvati' } }, required: ['ok'] },
        400: errorSchema,
        503: errorSchema,
      },
    },
  }, async (req) => {
    const body = bodyObject(req);
    const store = getStore();
    if (isLegacy(req) && (req.query as Record<string, unknown>)?.action === 'unsubscribe') {
      store.deleteDevice(ReminderStore.deviceId(deviceFrom(req, body, false)));
      return { ok: true };
    }
    const device = deviceFrom(req, body);
    if (!Object.hasOwn(body, 'reminders')) throw new BadRequest('reminders mancante');
    const reminders = validateReminders(body.reminders);
    assertDeviceSupported(device);
    const count = store.replaceReminders(device, reminders, new Date());
    return { ok: true, count };
  });

  route(app, 'DELETE', { v1: '/devices' }, {
    validatorCompiler: noFastifyValidation,
    schema: {
      tags: ['push'],
      summary: 'Cancella un dispositivo e tutti i suoi promemoria',
      description: 'Da chiamare quando l\'utente disattiva le notifiche. Per webpush basta `subscription.endpoint`. Idempotente: `{"ok":true}` anche se il dispositivo non era registrato.',
      body: { type: 'object', properties: { device: deviceSchema }, required: ['device'] },
      response: { 200: okSchema, 400: errorSchema },
    },
  }, async (req) => {
    const device = validateDevice(bodyObject(req).device, false);
    getStore().deleteDevice(ReminderStore.deviceId(device));
    return { ok: true };
  });

  route(app, 'POST', { v1: '/push/test', legacy: 'push-test.php' }, {
    validatorCompiler: noFastifyValidation,
    schema: {
      tags: ['push'],
      summary: 'Invia subito una notifica di prova',
      description: `Consegna sincrona di "Notifiche attive" al dispositivo (che viene anche registrato/aggiornato). Al massimo una prova ogni ${TEST_INTERVAL_SECONDS} secondi per dispositivo (429 con header Retry-After). Alias legacy \`push-test.php\`: body \`{"subscription":{…}}\`.`,
      body: { type: 'object', properties: { device: deviceSchema }, required: ['device'] },
      response: {
        200: testResultSchema,
        400: errorSchema,
        429: {
          type: 'object',
          properties: { error: { type: 'string' }, retryAfter: { type: 'integer', description: 'Secondi da attendere' } },
          required: ['error'],
        },
        503: errorSchema,
      },
    },
  }, async (req, reply) => {
    const device = deviceFrom(req, bodyObject(req));
    assertDeviceSupported(device);
    const store = getStore();
    const now = Math.floor(Date.now() / 1000);
    const id = store.saveDevice(device, now); // keeps keys fresh; also enforces the device cap (503)

    const wait = store.claimTest(id, now, TEST_INTERVAL_SECONDS);
    if (wait > 0) {
      reply.code(429).header('Retry-After', String(wait));
      return { error: `Attendi ${wait} secondi prima di un nuovo test`, retryAfter: wait };
    }

    const result = await send(device, testPayload());
    if (result.ok) {
      store.touchOk(id, now);
      return { ok: true, status: result.status };
    }
    if (result.gone) {
      store.deleteDevice(id);
      return { ok: false, gone: true, status: result.status, error: 'Sottoscrizione non più valida: riattiva le notifiche' };
    }
    return { ok: false, status: result.status, error: result.error !== '' ? result.error : 'Il servizio push ha rifiutato il messaggio' };
  });
}
