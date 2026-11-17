import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify';

/**
 * Registers an endpoint under its versioned path (/api/v1/…) and, optionally, under the legacy Madovai-Web path
 * (/api/<name>.php) with the SAME handler and JSON shape — so the existing PWA works unchanged on top of this backend.
 * The legacy alias is hidden from the OpenAPI docs.
 *
 * `maxAge` sets `Cache-Control: public, max-age=…` on success (omit for no-store).
 */
export function route(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'DELETE',
  paths: { v1: string; legacy?: string },
  opts: RouteShorthandOptions & { maxAge?: number },
  handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
): void {
  const { maxAge, ...routeOpts } = opts;
  const wrapped = async (req: FastifyRequest, reply: FastifyReply) => {
    const data = await handler(req, reply);
    if (!reply.sent) {
      reply.header('Cache-Control', maxAge ? `public, max-age=${maxAge}` : 'no-store');
    }
    return data;
  };
  app.route({ method, url: `/api/v1${paths.v1}`, ...routeOpts, handler: wrapped });
  if (paths.legacy) {
    const schema = { ...(routeOpts.schema ?? {}), hide: true } as Record<string, unknown>;
    app.route({ method, url: `/api/${paths.legacy}`, ...routeOpts, schema, handler: wrapped });
  }
}
