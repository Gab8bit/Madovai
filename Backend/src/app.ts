import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from './config.js';
import { HttpError } from './lib/errors.js';
import { gtfsReady } from './db.js';
import staticRoutes from './routes/static.js';
import liveRoutes from './routes/live.js';
import pushRoutes from './routes/push.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

export const VERSION: string = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

/**
 * Builds the HTTP app (no listening, no background jobs — tests use it directly via `app.inject`).
 * Route modules: routes/static.ts (GTFS-backed), routes/live.ts (Cotral/ASTRAL/Atac live), routes/push.ts (reminders).
 */
export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 256 * 1024,
    ajv: { customOptions: { coerceTypes: true, removeAdditional: false, allErrors: false } },
  });

  await app.register(cors, {
    origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    maxAge: 86400,
  });

  await app.register(rateLimit, {
    max: config.rateLimitPerMinute,
    timeWindow: '1 minute',
    // Only the API is rate limited (/health and /docs are not).
    allowList: (req) => !req.url.startsWith('/api/'),
    errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, error: `Troppe richieste: riprova tra ${Math.ceil(ctx.ttl / 1000)} secondi.` }),
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Madovai API',
        version: VERSION,
        description: 'Trasporto pubblico di Roma e del Lazio in tempo reale (Cotral, ASTRAL, Atac/Roma TPL) e promemoria con notifiche push per web, Android e iOS. Orari "HH:MM" = ora di Roma; `ts` = secondi unix.',
      },
      tags: [
        { name: 'static', description: 'Fermate, linee, percorsi e orari programmati (GTFS)' },
        { name: 'live', description: 'Passaggi e veicoli in tempo reale' },
        { name: 'push', description: 'Dispositivi, promemoria e notifiche' },
        { name: 'system', description: 'Stato del servizio' },
      ],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number; validation?: unknown };
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
    if (e.validation) return reply.status(400).send({ error: `Parametri non validi: ${e.message}` });
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.message });
    req.log.error(err);
    return reply.status(500).send({ error: 'Errore interno' });
  });

  app.get('/health', { schema: { tags: ['system'], summary: 'Stato del servizio' } }, async () => ({
    ok: true,
    version: VERSION,
    gtfsReady: gtfsReady(),
  }));

  await app.register(staticRoutes);
  await app.register(liveRoutes);
  await app.register(pushRoutes);

  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: 'Risorsa non trovata' }));
  return app;
}
